import type { SearchTarget } from "../config.ts";
import { toArray } from "./params.ts";
import type { NormalizedJob } from "./types.ts";

// Aliases used wherever a place is matched (onsite and remote).
const LOCATION_ALIASES: Record<string, string[]> = {
  omaha: ["omaha", "la vista", "elkhorn", "ralston"],
  "united states": [
    "united states",
    "usa",
    "u.s.",
    "us",
    "north america",
    "americas",
  ],
};

// Extra terms that make a remote listing eligible for a place. Never used
// for onsite matching: an onsite job in Lincoln is not an Omaha job.
const REMOTE_ONLY_ALIASES: Record<string, string[]> = {
  omaha: ["nebraska"],
};

// What a listing says when it is not tied to any region.
const GLOBAL_TERMS = new Set([
  "",
  "worldwide",
  "anywhere",
  "global",
  "international",
  "anywhere in the world",
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `term` appears in `text` with no letter or digit on either side. */
function containsTerm(text: string, term: string): boolean {
  if (term.trim() === "") return false;
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(term)}(?![a-z0-9])`).test(
    text,
  );
}

// "Omaha, NE" is one place; the alias key drops the trailing state code.
function aliasKey(place: string): string {
  const key = place.trim().toLowerCase();
  const stripped = key.replace(/\s*,\s*[a-z]{2}$/, "");
  return stripped === "" ? key : stripped;
}

const KEY_SYNONYMS: Record<string, string> = {
  us: "united states",
  usa: "united states",
  "u.s.": "united states",
};

/** Match terms for a place: its own text plus aliases of its alias key. */
function aliasesFor(place: string): string[] {
  const text = place.trim().toLowerCase();
  if (text === "") return [];
  const derived = aliasKey(text);
  const key = KEY_SYNONYMS[derived] ?? derived;
  return [...new Set([text, ...(LOCATION_ALIASES[key] ?? [key])])];
}

export function matchesLocation(
  jobLocation: string,
  queryLocation: string | string[],
): boolean {
  const job = jobLocation.toLowerCase();
  return toArray(queryLocation).some((query) =>
    aliasesFor(query).some((alias) => containsTerm(job, alias)),
  );
}

function isGlobalLocation(jobLocation: string): boolean {
  const text = jobLocation
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\bremote\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return GLOBAL_TERMS.has(text);
}

/** Whether a remote listing's location lets someone in `city` take it. */
export function remoteEligible(
  jobLocation: string,
  city: string,
  region: string[] = [],
): boolean {
  if (isGlobalLocation(jobLocation)) return true;
  const job = jobLocation.toLowerCase();
  const terms = [
    ...[city, ...region].flatMap(aliasesFor),
    ...(REMOTE_ONLY_ALIASES[aliasKey(city)] ?? []),
  ];
  return terms.some((term) => containsTerm(job, term));
}

/**
 * The one free-text inference: a job with no remote signal whose location
 * says "remote" is remote. Hybrid versus onsite is never inferred.
 */
export function normalizeRemoteType<
  T extends Pick<NormalizedJob, "location" | "remoteType">,
>(job: T): T {
  if (
    job.remoteType === "unknown" &&
    containsTerm(job.location.toLowerCase(), "remote")
  ) {
    return { ...job, remoteType: "remote" as const };
  }
  return job;
}

/**
 * The single decision of whether a job satisfies a (city, flexibility)
 * target. `remote` is trusted; anything else counts as possibly onsite.
 * Scoped sources already applied the city in their query, so only the
 * work-type half applies to their jobs.
 */
export function matches(
  job: Pick<NormalizedJob, "location" | "remoteType" | "otherLocations">,
  target: SearchTarget,
  options: { scoped?: boolean } = {},
): boolean {
  const remote = job.remoteType === "remote";
  if (
    remote
      ? target.flexibility === "in-person"
      : target.flexibility === "remote"
  ) {
    return false;
  }
  const city = target.city;
  if (options.scoped || city === null) return true;
  const places = [job.location, ...(job.otherLocations ?? [])];
  return places.some((place) =>
    remote
      ? remoteEligible(place, city, target.region)
      : matchesLocation(place, city),
  );
}
