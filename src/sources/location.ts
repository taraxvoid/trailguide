import type { SearchTarget } from "../config.ts";
import { toArray } from "./params.ts";
import type { NormalizedJob } from "./types.ts";

// Aliases used wherever a place is matched (onsite and remote).
const LOCATION_ALIASES: Record<string, string[]> = {
  // Regions: a target of "Bay Area" or "Seattle" takes the whole metro.
  "bay area": [
    "bay area",
    "san francisco",
    "south san francisco",
    "oakland",
    "berkeley",
    "emeryville",
    "alameda",
    "hayward",
    "san leandro",
    "fremont",
    "union city",
    "newark",
    "pleasanton",
    "dublin",
    "san ramon",
    "walnut creek",
    "san mateo",
    "foster city",
    "burlingame",
    "redwood city",
    "menlo park",
    "palo alto",
    "mountain view",
    "sunnyvale",
    "santa clara",
    "cupertino",
    "milpitas",
    "san jose",
    "castro valley",
    "danville",
    "livermore",
  ],
  "east bay": [
    "east bay",
    "oakland",
    "berkeley",
    "emeryville",
    "alameda",
    "san leandro",
    "castro valley",
    "hayward",
    "union city",
    "fremont",
    "newark",
    "dublin",
    "pleasanton",
    "livermore",
    "san ramon",
    "danville",
    "walnut creek",
    "concord",
  ],
  "south bay": [
    "south bay",
    "san jose",
    "santa clara",
    "sunnyvale",
    "mountain view",
    "milpitas",
    "cupertino",
    "campbell",
    "los gatos",
  ],
  seattle: [
    "seattle",
    "bellevue",
    "redmond",
    "kirkland",
    "bothell",
    "woodinville",
    "issaquah",
    "renton",
    "tukwila",
    "kent",
    "everett",
    "lynnwood",
    "tacoma",
    "puget sound",
  ],
  // Suburbs that are de facto Omaha.
  "omaha metro": [
    "omaha metro",
    "omaha",
    "ralston",
    "bellevue",
    "papillion",
    "la vista",
    "gretna",
    "elkhorn",
    "millard",
    "boys town",
    "bennington",
  ],
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
  "bay area": ["california"],
  "east bay": ["california"],
  "south bay": ["california"],
  seattle: ["washington state", "pacific northwest"],
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

const US_STATES: Record<string, string> = {
  AL: "alabama",
  AK: "alaska",
  AZ: "arizona",
  AR: "arkansas",
  CA: "california",
  CO: "colorado",
  CT: "connecticut",
  DE: "delaware",
  DC: "district of columbia",
  FL: "florida",
  GA: "georgia",
  HI: "hawaii",
  ID: "idaho",
  IL: "illinois",
  IN: "indiana",
  IA: "iowa",
  KS: "kansas",
  KY: "kentucky",
  LA: "louisiana",
  ME: "maine",
  MD: "maryland",
  MA: "massachusetts",
  MI: "michigan",
  MN: "minnesota",
  MS: "mississippi",
  MO: "missouri",
  MT: "montana",
  NE: "nebraska",
  NV: "nevada",
  NH: "new hampshire",
  NJ: "new jersey",
  NM: "new mexico",
  NY: "new york",
  NC: "north carolina",
  ND: "north dakota",
  OH: "ohio",
  OK: "oklahoma",
  OR: "oregon",
  PA: "pennsylvania",
  RI: "rhode island",
  SC: "south carolina",
  SD: "south dakota",
  TN: "tennessee",
  TX: "texas",
  UT: "utah",
  VT: "vermont",
  VA: "virginia",
  WA: "washington",
  WV: "west virginia",
  WI: "wisconsin",
  WY: "wyoming",
};

const US_STATE_CODE = new RegExp(
  `(?:^|,\\s*)(?:${Object.keys(US_STATES).join("|")})\\s*(?:,|$|\\d)`,
);

// "Georgia" is also a country, so it only counts with a state code or "USA".
const US_STATE_NAMES = Object.values(US_STATES).filter((n) => n !== "georgia");

/**
 * Whether a listing location names a US state, as a name ("Austin, Texas")
 * or a code after a comma ("San Francisco, CA"). Used only to let such
 * remote listings through for country-level targets; there is no city data,
 * so a bare "San Francisco" is not recognized.
 */
export function isUsLocation(jobLocation: string): boolean {
  if (US_STATE_CODE.test(jobLocation)) return true;
  const text = jobLocation.toLowerCase();
  return US_STATE_NAMES.some((name) => containsTerm(text, name));
}

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
  "san francisco bay area": "bay area",
  "sf bay area": "bay area",
  "greater seattle": "seattle",
  "greater seattle area": "seattle",
  "seattle area": "seattle",
  "seattle metro": "seattle",
};

/** The alias-table key for a place, after synonyms ("Seattle area" → seattle). */
function canonicalKey(place: string): string {
  const key = aliasKey(place);
  return KEY_SYNONYMS[key] ?? key;
}

/** "omaha, ne" also matches a listing that spells the state out. */
function spelledOutState(text: string): string[] {
  const match = /^(.+?)\s*,\s*([a-z]{2})$/.exec(text);
  const state = match && US_STATES[(match[2] ?? "").toUpperCase()];
  return match && state ? [`${match[1]}, ${state}`] : [];
}

/** Match terms for a place: its own text plus aliases of its alias key. */
function aliasesFor(place: string): string[] {
  const text = place.trim().toLowerCase();
  if (text === "") return [];
  return [
    ...new Set([
      text,
      ...spelledOutState(text),
      ...(LOCATION_ALIASES[canonicalKey(text)] ?? []),
    ]),
  ];
}

// Regions span many towns, and several share a name with places elsewhere
// (Dublin, Ireland; Fremont, NE; Pleasanton, TX). A region only matches a
// listing that names its state, or a bare town name.
const REGION_STATES: Record<string, { code: string; name: string }> = {
  "bay area": { code: "CA", name: "california" },
  "east bay": { code: "CA", name: "california" },
  "south bay": { code: "CA", name: "california" },
  seattle: { code: "WA", name: "washington" },
  "omaha metro": { code: "NE", name: "nebraska" },
};

function inRegionState(jobLocation: string, place: string): boolean {
  const state = REGION_STATES[canonicalKey(place)];
  // "Pleasanton" or "Hybrid - Pleasanton" is bare; "Ireland-Dublin" (a
  // Workday location name) and "Fremont, NE" are qualified.
  if (!state || !/,|[A-Za-z]-[A-Za-z]/.test(jobLocation)) return true;
  return (
    new RegExp(`(?<![A-Za-z])${state.code}(?![A-Za-z])`).test(jobLocation) ||
    containsTerm(jobLocation.toLowerCase(), state.name)
  );
}

export function matchesLocation(
  jobLocation: string,
  queryLocation: string | string[],
): boolean {
  const job = jobLocation.toLowerCase();
  return toArray(queryLocation).some(
    (query) =>
      aliasesFor(query).some((alias) => containsTerm(job, alias)) &&
      inRegionState(jobLocation, query),
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

function isUnitedStates(place: string): boolean {
  return canonicalKey(place) === "united states";
}

/** Whether a remote listing's location lets someone in `city` take it. */
export function remoteEligible(jobLocation: string, city: string): boolean {
  if (isGlobalLocation(jobLocation)) return true;
  if (isUnitedStates(city) && isUsLocation(jobLocation)) return true;
  if (matchesLocation(jobLocation, city)) return true;
  const job = jobLocation.toLowerCase();
  return (REMOTE_ONLY_ALIASES[canonicalKey(city)] ?? []).some((term) =>
    containsTerm(job, term),
  );
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
    /(?<![a-z0-9])(?<!non-)(?<!non )(?<!no )(?<!not )remote(?![a-z0-9])/.test(
      job.location.toLowerCase(),
    )
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
    remote ? remoteEligible(place, city) : matchesLocation(place, city),
  );
}
