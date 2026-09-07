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

function matchesRole(title: string, role: string): boolean {
  return title.toLowerCase().includes(role.toLowerCase());
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

export function createLeverSource(): Source {
  return {
    name: "lever",
    async search(params: SearchParams): Promise<NormalizedJob[]> {
      const companies = companiesForAts("lever");
      const results: NormalizedJob[] = [];

      for (const { company, slug } of companies) {
        const res = await fetch(
          `https://api.lever.co/v0/postings/${slug}?mode=json`,
        );
        if (!res.ok) {
          continue;
        }
        const jobs = (await res.json()) as LeverJob[];
        for (const job of jobs) {
          if (!matchesRole(job.text, params.role)) continue;
          if (
            params.location &&
            !job.categories.location
              .toLowerCase()
              .includes(params.location.toLowerCase())
          ) {
            continue;
          }
          results.push({
            sourceId: job.id,
            source: "lever",
            title: job.text,
            company,
            location: job.categories.location,
            remoteType: toRemoteType(job.workplaceType),
            url: job.hostedUrl,
            postedAt: new Date(job.createdAt).toISOString(),
            description: job.descriptionPlain,
          });
        }
      }

      return results;
    },
  };
}
