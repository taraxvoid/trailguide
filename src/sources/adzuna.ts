import { toArray } from "./params.ts";
import type { NormalizedJob, SearchParams, Source } from "./types.ts";

interface AdzunaJob {
  id: string;
  title: string;
  company: { display_name: string };
  location: { display_name: string };
  redirect_url: string;
  created: string;
  description: string;
}

interface AdzunaResponse {
  results: AdzunaJob[];
}

export function createAdzunaSource(
  appId: string,
  appKey: string,
  country = "us",
): Source {
  return {
    name: "adzuna",
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
          const url = new URL(
            `https://api.adzuna.com/v1/api/jobs/${country}/search/1`,
          );
          url.searchParams.set("app_id", appId);
          url.searchParams.set("app_key", appKey);
          url.searchParams.set("what", role);
          if (location) {
            url.searchParams.set("where", location);
          }

          const res = await fetch(url);
          if (!res.ok) {
            throw new Error(
              `Adzuna request failed: ${res.status} ${await res.text()}`,
            );
          }

          const body = (await res.json()) as AdzunaResponse;
          return body.results.map((job) => ({
            sourceId: job.id,
            source: "adzuna" as const,
            title: job.title,
            company: job.company.display_name,
            location: job.location.display_name,
            remoteType: "unknown" as const,
            url: job.redirect_url,
            postedAt: job.created,
            description: job.description,
          }));
        }),
      );

      return results.flat();
    },
  };
}
