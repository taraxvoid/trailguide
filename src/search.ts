import type { SearchPlan, SearchTarget } from "./config.ts";
import { dedupe } from "./dedupe.ts";
import { matches, normalizeRemoteType } from "./sources/location.ts";
import type { NormalizedJob, SearchParams, Source } from "./sources/types.ts";
import { stripTrackingParams } from "./url.ts";

const INTERNSHIP_PATTERN = /\bintern(?:ship)?s?\b/i;
const GOVMIL_PATTERN =
  /\b(?:Lockheed|Raytheon|Deloitte|Leidos|Offutt|military|warfighter|clearance|DoD|department of defense|department of war|SCI|Top Secret|clearance)\b/i;

export function isInternship(job: NormalizedJob): boolean {
  return INTERNSHIP_PATTERN.test(job.title);
}

export function requiresClearance(job: NormalizedJob): boolean {
  return (
    GOVMIL_PATTERN.test(job.title) || GOVMIL_PATTERN.test(job.description ?? "")
  );
}

export interface SourceFailure {
  source: string;
  message: string;
}

export interface CollectResult {
  jobs: NormalizedJob[];
  failures: SourceFailure[];
  /** At least one call was made and none succeeded. */
  allFailed: boolean;
}

/** What `runSearch` returns and the run message is built from. */
export interface SearchResult {
  found: number;
  new: number;
  failures: SourceFailure[];
}

export function formatRunMessage(result: SearchResult): string {
  const failed =
    result.failures.length > 0
      ? `; failed: ${result.failures.map((f) => `${f.source}: ${f.message}`).join(", ")}`
      : "";
  return `${result.found} found, ${result.new} new${failed}`;
}

function scopedParams(role: string, target: SearchTarget): SearchParams {
  return {
    role,
    location: target.city ?? undefined,
    remote: target.flexibility === "remote" ? true : undefined,
  };
}

/**
 * Runs every keyword in every target. Unscoped sources are called once per
 * keyword without a location and their jobs are checked against every
 * target; scoped sources are called once per (keyword, target) and only
 * the work type is checked. A failing source is recorded, never thrown.
 */
export async function collectJobs(
  plan: SearchPlan,
  sources: Source[],
): Promise<CollectResult> {
  const failures = new Map<string, string>();
  let calls = 0;
  let succeeded = 0;

  const call = async (
    source: Source,
    params: SearchParams,
  ): Promise<NormalizedJob[]> => {
    calls++;
    try {
      const jobs = await source.search(params);
      succeeded++;
      return jobs.map(normalizeRemoteType);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${source.name}] search failed: ${message}`);
      if (!failures.has(source.name)) {
        failures.set(source.name, message.slice(0, 120));
      }
      return [];
    }
  };

  const unscoped = sources.filter((s) => !s.scoped);
  const scoped = sources.filter((s) => s.scoped);

  const perKeyword = await Promise.all(
    plan.keywords.map(async (role) => {
      const [loose, perTarget] = await Promise.all([
        Promise.all(unscoped.map((s) => call(s, { role }))),
        Promise.all(
          plan.targets.map(async (target) => {
            const found = await Promise.all(
              scoped.map((s) => call(s, scopedParams(role, target))),
            );
            return found
              .flat()
              .filter((job) => matches(job, target, { scoped: true }));
          }),
        ),
      ]);
      const kept = loose
        .flat()
        .filter((job) => plan.targets.some((target) => matches(job, target)));
      return [...kept, ...perTarget.flat()];
    }),
  );

  const jobs = dedupe(perKeyword.flat())
    .filter((job) => !isInternship(job))
    .filter((job) => plan.govmil || !requiresClearance(job))
    .map((job) => ({ ...job, url: stripTrackingParams(job.url) }));

  return {
    jobs,
    failures: [...failures].map(([source, message]) => ({ source, message })),
    allFailed: calls > 0 && succeeded === 0,
  };
}
