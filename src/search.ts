import type { SearchPlan, SearchTarget } from "./config.ts";
import { dedupe } from "./dedupe.ts";
import { createLimiter } from "./limit.ts";
import { matches, normalizeRemoteType } from "./sources/location.ts";
import type { NormalizedJob, SearchParams, Source } from "./sources/types.ts";
import { stripTrackingParams } from "./url.ts";

const INTERNSHIP_PATTERN = /\bintern(?:ship)?s?\b/i;
// Defense and government contractors, matched on the employer or title only:
// a commercial listing may name one as a customer.
const GOVMIL_EMPLOYERS =
  /\b(?:Lockheed|Raytheon|RTX|Northrop|General Dynamics|GDIT|Leidos|SAIC|Booz Allen|CACI|ManTech|Peraton|BAE Systems|Parsons|KBR|Deloitte)\b/i;
// Clearance and defense terms anywhere in the listing. Bare "military" and
// "clearance" are left out: EEO boilerplate ("veteran or military status")
// would otherwise hide most US listings.
const GOVMIL_TERMS =
  /\b(?:(?:security|active|secret|government|federal|dod|ts) clearances?|clearance (?:is )?required|(?:obtain|maintain) (?:a |an )?clearance|top secret|(?:ci|full[- ]scope) poly(?:graph)?|polygraph|public trust (?:clearance|position)|department of (?:defense|war)|warfighters?|DoD 8[15][47]0)\b/i;
// Acronyms, case-sensitive so "sci" or "dod" in ordinary words never match.
const GOVMIL_ACRONYMS = /\b(?:TS\/SCI|SCI|DoD|DoDIN)\b/;

export function isInternship(job: NormalizedJob): boolean {
  return INTERNSHIP_PATTERN.test(job.title);
}

/** Whether the company, title or description contains any of `terms` as a whole word. */
export function mentionsAny(job: NormalizedJob, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const text = `${job.company}\n${job.title}\n${job.description ?? ""}`;
  return terms.some((term) =>
    new RegExp(
      `(?<![a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`,
      "i",
    ).test(text),
  );
}

export function requiresClearance(job: NormalizedJob): boolean {
  if (GOVMIL_EMPLOYERS.test(`${job.company} ${job.title}`)) return true;
  const text = `${job.title}\n${job.description ?? ""}`;
  return GOVMIL_TERMS.test(text) || GOVMIL_ACRONYMS.test(text);
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

/**
 * The trail for a job from an unscoped source, which was searched with every
 * keyword at once: the first keyword (in config order) its title contains.
 */
export function trailFromTitle(
  title: string,
  plan: Pick<SearchPlan, "keywords" | "trails">,
): string | undefined {
  const role = plan.keywords.find((k) => {
    const escaped = k.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").test(title);
  });
  return role === undefined ? undefined : plan.trails[role];
}

function withTrail(
  job: NormalizedJob,
  trail: string | undefined,
): NormalizedJob {
  return trail ? { ...job, trail } : job;
}

/** Tags a job with the regions of the targets it satisfied. */
function withRegions(job: NormalizedJob, hit: SearchTarget[]): NormalizedJob {
  const regions = [
    ...new Set(hit.flatMap((t) => (t.region ? [t.region] : []))),
  ];
  return regions.length > 0 ? { ...job, regions } : job;
}

/**
 * Scoped sources are paid search APIs (adzuna, jsearch) called once per
 * (keyword, target); firing them all at once trips their rate limits (nginx
 * 429s from adzuna, queued-until-timeout requests on jsearch).
 */
const SCOPED_CONCURRENCY = 2;

function scopedParams(role: string, target: SearchTarget): SearchParams {
  return {
    role,
    location: target.city ?? undefined,
    remote: target.flexibility === "remote" ? true : undefined,
  };
}

/**
 * Runs every keyword in every target. Unscoped sources are called once with
 * all keywords and no location, and their jobs are checked against every
 * target; scoped sources are called once per (keyword, target) and only
 * the work type is checked. Scoped sources that never label remote jobs
 * (adzuna) are skipped for remote targets. A failing source is recorded,
 * never thrown.
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
      const jobs = await source.search({
        ...params,
        warn: (message) => {
          console.error(`[${source.name}] ${message}`);
          if (!failures.has(source.name)) {
            failures.set(source.name, message.slice(0, 120));
          }
        },
      });
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
  const scoped = sources
    .filter((s) => s.scoped)
    .map((source) => ({ source, limit: createLimiter(SCOPED_CONCURRENCY) }));

  const [loose, perTarget] = await Promise.all([
    Promise.all(unscoped.map((s) => call(s, { role: plan.keywords }))),
    Promise.all(
      plan.keywords.flatMap((role) =>
        plan.targets.map(async (target) => {
          const usable = scoped.filter(
            ({ source }) =>
              source.labelsRemote !== false || target.flexibility !== "remote",
          );
          const found = await Promise.all(
            usable.map(({ source, limit }) =>
              limit(() => call(source, scopedParams(role, target))),
            ),
          );
          return found
            .flat()
            .filter((job) => matches(job, target, { scoped: true }))
            .map((job) =>
              withRegions(withTrail(job, plan.trails[role]), [target]),
            );
        }),
      ),
    ),
  ]);
  const kept = loose.flat().flatMap((job) => {
    const hit = plan.targets.filter((target) => matches(job, target));
    if (hit.length === 0) return [];
    return [withRegions(withTrail(job, trailFromTitle(job.title, plan)), hit)];
  });

  const jobs = dedupe([...kept, ...perTarget.flat()])
    .filter((job) => !isInternship(job))
    .filter((job) => !plan.filter.excludeClearance || !requiresClearance(job))
    .filter((job) => !mentionsAny(job, plan.filter.excludeTerms))
    .map((job) => ({ ...job, url: stripTrackingParams(job.url) }));

  return {
    jobs,
    failures: [...failures].map(([source, message]) => ({ source, message })),
    allFailed: calls > 0 && succeeded === 0,
  };
}
