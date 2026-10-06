import { getJson } from "../http.ts";
import { type Board, searchBoards } from "./boards.ts";
import { stripHtml } from "./html.ts";
import { matchesLocation } from "./location.ts";
import { toArray } from "./params.ts";
import { companiesForAts } from "./seed.ts";
import type { NormalizedJob, SearchParams, Source } from "./types.ts";

interface GreenhouseJob {
  id: number;
  title: string;
  location: { name: string };
  absolute_url: string;
  updated_at: string;
  content: string;
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[];
}

function matchesRole(title: string, role: string | string[]): boolean {
  const lowerTitle = title.toLowerCase();
  return toArray(role).some((r) => lowerTitle.includes(r.toLowerCase()));
}

export function createGreenhouseSource(
  boards: Board[] = companiesForAts("greenhouse"),
): Source {
  return {
    name: "greenhouse",
    scoped: false,
    async search(params: SearchParams): Promise<NormalizedJob[]> {
      return searchBoards(boards, params, async ({ company, slug }) => {
        const results: NormalizedJob[] = [];
        const body = await getJson<GreenhouseResponse>(
          `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
        );
        for (const job of body.jobs) {
          if (!matchesRole(job.title, params.role)) continue;
          if (
            params.location &&
            !matchesLocation(job.location.name, params.location)
          ) {
            continue;
          }
          results.push({
            sourceId: String(job.id),
            source: "greenhouse",
            title: job.title,
            company,
            location: job.location.name,
            remoteType: job.location.name.toLowerCase().includes("remote")
              ? "remote"
              : "unknown",
            url: job.absolute_url,
            postedAt: job.updated_at,
            description: stripHtml(job.content),
          });
        }
        return results;
      });
    },
  };
}
