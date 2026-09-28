import { toArray } from "./params.ts";
import type { NormalizedJob, SearchParams, Source } from "./types.ts";

interface JSearchJob {
  job_id: string;
  job_title: string;
  employer_name: string;
  job_city: string | null;
  job_state: string | null;
  job_country: string | null;
  job_is_remote: boolean;
  job_apply_link: string;
  job_posted_at_datetime_utc: string | null;
  job_description: string | null;
}

interface JSearchResponse {
  data: {
    jobs: JSearchJob[];
  };
}

function toRemoteType(job: JSearchJob): NormalizedJob["remoteType"] {
  return job.job_is_remote ? "remote" : "unknown";
}

function toLocation(job: JSearchJob): string {
  return (
    [job.job_city, job.job_state, job.job_country].filter(Boolean).join(", ") ||
    "unknown"
  );
}

export function createJSearchSource(apiKey: string): Source {
  return {
    name: "jsearch",
    scoped: true,
    async search(params: SearchParams): Promise<NormalizedJob[]> {
      const roles = toArray(params.role);
      const locations = params.location
        ? toArray(params.location)
        : [undefined];
      const combos = roles.flatMap((role) =>
        locations.map((location) => ({ role, location })),
      );

      const results = await Promise.all(
        combos.map(async ({ role, location }) => {
          const query = [role, location].filter(Boolean).join(" in ");
          const url = new URL("https://jsearch.p.rapidapi.com/search-v2");
          url.searchParams.set("query", query);
          if (params.remote) {
            url.searchParams.set("remote_jobs_only", "true");
          }

          const res = await fetch(url, {
            headers: {
              "X-RapidAPI-Key": apiKey,
              "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
            },
          });
          if (!res.ok) {
            throw new Error(
              `JSearch request failed: ${res.status} ${await res.text()}`,
            );
          }

          const body = (await res.json()) as JSearchResponse;
          return body.data.jobs.map((job) => ({
            sourceId: job.job_id,
            source: "jsearch" as const,
            title: job.job_title,
            company: job.employer_name,
            location: toLocation(job),
            remoteType: toRemoteType(job),
            url: job.job_apply_link,
            postedAt: job.job_posted_at_datetime_utc,
            description: job.job_description,
          }));
        }),
      );

      return results.flat();
    },
  };
}
