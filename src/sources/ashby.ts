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

interface AshbySecondaryLocation {
  location: string;
}

interface AshbyJob {
  id: string;
  title: string;
  location: string;
  secondaryLocations?: AshbySecondaryLocation[];
  employmentType: string;
  isRemote: boolean;
  workplaceType: string | null;
  publishedAt: string;
  jobUrl: string;
  descriptionPlain: string;
}

interface AshbyResponse {
  jobs: AshbyJob[];
}

function matchesRole(title: string, role: string | string[]): boolean {
  const lowerTitle = title.toLowerCase();
  return toArray(role).some((r) => lowerTitle.includes(r.toLowerCase()));
}

function allLocations(job: AshbyJob): string[] {
  return [
    job.location,
    ...(job.secondaryLocations ?? []).map((l) => l.location),
  ];
}

function toRemoteType(job: AshbyJob): RemoteType {
  switch (job.workplaceType?.toLowerCase()) {
    case "remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "onsite":
      return "onsite";
    default:
      return job.isRemote ? "remote" : "unknown";
  }
}

function toNormalized(job: AshbyJob, company: string): NormalizedJob {
  return {
    sourceId: job.id,
    source: "ashby",
    title: job.title,
    company,
    location: job.location,
    otherLocations: (job.secondaryLocations ?? []).map((l) => l.location),
    remoteType: toRemoteType(job),
    url: job.jobUrl,
    postedAt: job.publishedAt,
    description: job.descriptionPlain,
  };
}

export function createAshbySource(
  boards: Board[] = companiesForAts("ashby"),
): Source {
  return {
    name: "ashby",
    scoped: false,
    async search(params: SearchParams): Promise<NormalizedJob[]> {
      return searchBoards(boards, params, async ({ company, slug }) => {
        const results: NormalizedJob[] = [];
        const body = await getJson<AshbyResponse>(
          `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
        );
        for (const job of body.jobs) {
          if (!matchesRole(job.title, params.role)) continue;
          const locations = allLocations(job);
          if (
            params.location &&
            !locations.some((loc) =>
              matchesLocation(loc, params.location as string | string[]),
            )
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

/** One posting by id (`trailguide add`); Ashby has no single-job endpoint. */
export async function fetchAshbyJob(
  slug: string,
  id: string,
  company?: string,
): Promise<NormalizedJob> {
  const body = await getJson<AshbyResponse>(
    `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
  );
  const job = body.jobs.find((j) => j.id === id);
  if (!job) throw new Error("no longer listed on the board");
  return toNormalized(job, company ?? slug);
}
