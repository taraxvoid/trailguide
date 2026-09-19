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

export function createAshbySource(): Source {
  return {
    name: "ashby",
    async search(params: SearchParams): Promise<NormalizedJob[]> {
      const companies = companiesForAts("ashby");
      const results: NormalizedJob[] = [];

      for (const { company, slug } of companies) {
        const res = await fetch(
          `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
        );
        if (!res.ok) {
          continue;
        }
        const body = (await res.json()) as AshbyResponse;
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
          results.push({
            sourceId: job.id,
            source: "ashby",
            title: job.title,
            company,
            location: job.location,
            remoteType: toRemoteType(job),
            url: job.jobUrl,
            postedAt: job.publishedAt,
            description: job.descriptionPlain,
          });
        }
      }

      return results;
    },
  };
}
