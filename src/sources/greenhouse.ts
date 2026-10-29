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

function toNormalized(job: GreenhouseJob, company: string): NormalizedJob {
  return {
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
  };
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
          results.push(toNormalized(job, company));
        }
        return results;
      });
    },
  };
}

/**
 * One posting by id (`trailguide add`). `company` is the board's name when
 * trailguide knows the board; otherwise Greenhouse's own name for it.
 */
export async function fetchGreenhouseJob(
  slug: string,
  id: string,
  company?: string,
): Promise<NormalizedJob> {
  const job = await getJson<GreenhouseJob & { company_name?: string }>(
    `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${id}`,
  );
  return toNormalized(job, company ?? job.company_name ?? slug);
}
