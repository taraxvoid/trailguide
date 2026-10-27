import { getJson } from "../http.ts";
import { type Board, searchBoards } from "./boards.ts";
import { stripHtml } from "./html.ts";
import { matchesLocation } from "./location.ts";
import { toArray } from "./params.ts";
import { companiesForAts } from "./seed.ts";
import type { NormalizedJob, SearchParams, Source } from "./types.ts";

// Workable's public careers-widget API (what apply.workable.com/<slug> loads).
// No key needed; `details=true` adds each job's HTML description.

interface WorkableLocation {
  country?: string;
  city?: string;
  region?: string;
  hidden?: boolean;
}

interface WorkableJob {
  title: string;
  shortcode: string;
  telecommuting: boolean;
  url: string;
  published_on?: string;
  city?: string;
  state?: string;
  country?: string;
  locations?: WorkableLocation[];
  description?: string;
}

interface WorkableResponse {
  jobs: WorkableJob[];
}

function matchesRole(title: string, role: string | string[]): boolean {
  const lowerTitle = title.toLowerCase();
  return toArray(role).some((r) => lowerTitle.includes(r.toLowerCase()));
}

function placeName(parts: (string | undefined)[]): string {
  return parts.filter((p) => p && p.trim() !== "").join(", ");
}

/** Primary location first, then any other visible locations. */
export function workableLocations(job: WorkableJob): string[] {
  const names = [placeName([job.city, job.state, job.country])];
  for (const loc of job.locations ?? []) {
    if (loc.hidden) continue;
    names.push(placeName([loc.city, loc.region, loc.country]));
  }
  return [...new Set(names.filter((n) => n !== ""))];
}

function toNormalized(
  job: WorkableJob,
  company: string,
  locations: string[],
): NormalizedJob {
  return {
    sourceId: job.shortcode,
    source: "workable",
    title: job.title,
    company,
    location: locations[0] ?? (job.telecommuting ? "Remote" : ""),
    otherLocations: locations.slice(1),
    // The widget only flags fully remote jobs; onsite and hybrid
    // look the same, so anything else stays unknown.
    remoteType: job.telecommuting ? "remote" : "unknown",
    url: job.url,
    postedAt: job.published_on ?? null,
    description: job.description ? stripHtml(job.description) : null,
  };
}

export function createWorkableSource(
  boards: Board[] = companiesForAts("workable"),
): Source {
  return {
    name: "workable",
    scoped: false,
    async search(params: SearchParams): Promise<NormalizedJob[]> {
      return searchBoards(boards, params, async ({ company, slug }) => {
        const results: NormalizedJob[] = [];
        const body = await getJson<WorkableResponse>(
          `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`,
        );
        for (const job of body.jobs ?? []) {
          if (!matchesRole(job.title, params.role)) continue;
          const locations = workableLocations(job);
          if (
            params.location &&
            !locations.some((loc) =>
              matchesLocation(loc, params.location as string | string[]),
            )
          ) {
            continue;
          }
          results.push(toNormalized(job, company, locations));
        }
        return results;
      });
    },
  };
}

/** One posting by shortcode (`trailguide add`), read from the account's widget. */
export async function fetchWorkableJob(
  slug: string,
  shortcode: string,
  company?: string,
): Promise<NormalizedJob> {
  const body = await getJson<WorkableResponse>(
    `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`,
  );
  const job = (body.jobs ?? []).find((j) => j.shortcode === shortcode);
  if (!job) throw new Error("no longer listed on the board");
  return toNormalized(job, company ?? slug, workableLocations(job));
}
