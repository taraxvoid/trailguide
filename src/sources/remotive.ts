import { stripHtml } from "./html.ts";
import { matchesLocation } from "./location.ts";
import type { NormalizedJob, SearchParams, Source } from "./types.ts";

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  publication_date: string;
  candidate_required_location: string;
  description: string;
}

interface RemotiveResponse {
  jobs: RemotiveJob[];
}

export function createRemotiveSource(): Source {
  return {
    name: "remotive",
    async search(params: SearchParams): Promise<NormalizedJob[]> {
      const url = new URL("https://remotive.com/api/remote-jobs");
      url.searchParams.set("search", params.role);

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(
          `Remotive request failed: ${res.status} ${await res.text()}`,
        );
      }

      const body = (await res.json()) as RemotiveResponse;
      return body.jobs
        .filter(
          (job) =>
            !params.location ||
            matchesLocation(job.candidate_required_location, params.location),
        )
        .map((job) => ({
          sourceId: String(job.id),
          source: "remotive",
          title: job.title,
          company: job.company_name,
          location: job.candidate_required_location,
          remoteType: "remote",
          url: job.url,
          postedAt: job.publication_date,
          description: stripHtml(job.description),
        }));
    },
  };
}
