import { getJson } from "../http.ts";
import { type Board, searchBoards } from "./boards.ts";
import { matchesLocation } from "./location.ts";
import { toArray } from "./params.ts";
import { companiesForAts } from "./seed.ts";
import type {
  NormalizedJob,
  RemoteType,
  SearchParams,
  Source,
} from "./types.ts";

interface LeverJob {
  id: string;
  text: string;
  categories: { location: string; team: string; commitment: string };
  workplaceType: string | null;
  hostedUrl: string;
  createdAt: number;
  descriptionPlain: string;
}

function matchesRole(title: string, role: string | string[]): boolean {
  const lowerTitle = title.toLowerCase();
  return toArray(role).some((r) => lowerTitle.includes(r.toLowerCase()));
}

function toRemoteType(workplaceType: string | null): RemoteType {
  switch (workplaceType?.toLowerCase()) {
    case "remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "onsite":
      return "onsite";
    default:
      return "unknown";
  }
}

function toNormalized(job: LeverJob, company: string): NormalizedJob {
  return {
    sourceId: job.id,
    source: "lever",
    title: job.text,
    company,
    location: job.categories.location,
    remoteType: toRemoteType(job.workplaceType),
    url: job.hostedUrl,
    postedAt: new Date(job.createdAt).toISOString(),
    description: job.descriptionPlain,
  };
}

export function createLeverSource(
  boards: Board[] = companiesForAts("lever"),
): Source {
  return {
    name: "lever",
    scoped: false,
    async search(params: SearchParams): Promise<NormalizedJob[]> {
      return searchBoards(boards, params, async ({ company, slug }) => {
        const results: NormalizedJob[] = [];
        const jobs = await getJson<LeverJob[]>(
          `https://api.lever.co/v0/postings/${slug}?mode=json`,
        );
        for (const job of jobs) {
          if (!matchesRole(job.text, params.role)) continue;
          if (
            params.location &&
            !matchesLocation(job.categories.location, params.location)
          ) {
            continue;
          }
          results.push(toNormalized(job, company));
        }
        return results;
      });
    },
  };
}

/** One posting by id (`trailguide add`). */
export async function fetchLeverJob(
  slug: string,
  id: string,
  company?: string,
): Promise<NormalizedJob> {
  const job = await getJson<LeverJob>(
    `https://api.lever.co/v0/postings/${slug}/${id}`,
  );
  return toNormalized(job, company ?? slug);
}
