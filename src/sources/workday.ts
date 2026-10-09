import { getJson, httpFetch } from "../http.ts";
import { mapLimit } from "../limit.ts";
import { type Board, searchBoards } from "./boards.ts";
import { stripHtml } from "./html.ts";
import { toArray } from "./params.ts";
import { companiesForAts } from "./seed.ts";
import type {
  NormalizedJob,
  RemoteType,
  SearchParams,
  Source,
} from "./types.ts";

// Workday's public job-board API (what <tenant>.<host>.myworkdayjobs.com
// calls itself). Search returns 20 postings a page with no description, so
// matching postings are fetched one by one for the full text.

interface WorkdayPosting {
  title: string;
  externalPath: string;
  locationsText?: string;
  bulletFields?: string[];
}

interface WorkdaySearchResponse {
  total?: number;
  jobPostings?: WorkdayPosting[];
}

interface WorkdayDetailResponse {
  jobPostingInfo?: {
    jobDescription?: string;
    location?: string;
    additionalLocations?: string[];
    startDate?: string;
    remoteType?: string;
    jobReqId?: string;
  };
}

const PAGE_SIZE = 20;
/** Pages per (company, keyword); searchText already ranks the best first. */
const MAX_PAGES = 3;
const DETAIL_CONCURRENCY = 4;

type WorkdayCompany = Board & { host: string; site: string };

function boardBase({ slug, host }: WorkdayCompany): string {
  return `https://${slug}.${host}.myworkdayjobs.com`;
}

function matchesRole(title: string, role: string): boolean {
  return title.toLowerCase().includes(role.toLowerCase());
}

/** Workday's free-text remoteType ("Fully Remote", "Hybrid", "On-site"). */
export function workdayRemoteType(value: string | undefined): RemoteType {
  const text = value?.toLowerCase() ?? "";
  if (text.includes("remote")) return "remote";
  if (text.includes("hybrid") || text.includes("flex")) return "hybrid";
  if (text.includes("site") || text.includes("office")) return "onsite";
  return "unknown";
}

async function searchPostings(
  company: WorkdayCompany,
  role: string,
): Promise<WorkdayPosting[]> {
  const url = `${boardBase(company)}/wday/cxs/${company.slug}/${company.site}/jobs`;
  const found: WorkdayPosting[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await getJson<WorkdaySearchResponse>(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        appliedFacets: {},
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        searchText: role,
      }),
    });
    const postings = body.jobPostings ?? [];
    found.push(...postings.filter((p) => matchesRole(p.title, role)));
    if (postings.length < PAGE_SIZE) break;
    if (body.total !== undefined && (page + 1) * PAGE_SIZE >= body.total) break;
  }
  return found;
}

async function toJob(
  company: WorkdayCompany,
  posting: WorkdayPosting,
): Promise<NormalizedJob> {
  const base = boardBase(company);
  let info: WorkdayDetailResponse["jobPostingInfo"];
  try {
    const res = await httpFetch(
      `${base}/wday/cxs/${company.slug}/${company.site}${posting.externalPath}`,
      { headers: { Accept: "application/json" } },
    );
    if (res.ok)
      info = ((await res.json()) as WorkdayDetailResponse).jobPostingInfo;
  } catch {
    // Keep the search-level fields; the listing is still worth showing.
  }
  const reqId =
    info?.jobReqId ?? posting.bulletFields?.[0] ?? posting.externalPath;
  return {
    sourceId: `${company.slug}:${reqId}`,
    source: "workday",
    title: posting.title,
    company: company.company,
    location: info?.location ?? posting.locationsText ?? "",
    otherLocations: info?.additionalLocations,
    remoteType: workdayRemoteType(info?.remoteType),
    url: `${base}/${company.site}${posting.externalPath}`,
    postedAt: info?.startDate ?? null,
    description: info?.jobDescription ? stripHtml(info.jobDescription) : null,
  };
}

export function createWorkdaySource(
  boards: Board[] = companiesForAts("workday"),
): Source {
  return {
    name: "workday",
    scoped: false,
    async search(params: SearchParams): Promise<NormalizedJob[]> {
      return searchBoards(boards, params, async (board) => {
        if (!board.host || !board.site) {
          throw new Error("workday boards need a host and a site");
        }
        const company = board as WorkdayCompany;
        // One search per keyword: Workday's searchText is a single query.
        const seen = new Map<string, WorkdayPosting>();
        for (const role of toArray(params.role)) {
          for (const posting of await searchPostings(company, role)) {
            seen.set(posting.externalPath, posting);
          }
        }
        return mapLimit([...seen.values()], DETAIL_CONCURRENCY, (p) =>
          toJob(company, p),
        );
      });
    },
  };
}
