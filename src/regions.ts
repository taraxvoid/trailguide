import type { Database } from "bun:sqlite";
import type { RegionEntry } from "./config.ts";
import { addJobRegions, allJobs } from "./db.ts";
import { matches, normalizeRemoteType } from "./sources/location.ts";
import type { NormalizedJob } from "./sources/types.ts";

/** The TUI bucket for jobs that match no configured region. */
export const UNASSIGNED = "unassigned";

/**
 * The regions (names, in config order) whose places and work type a job
 * satisfies. A job naming two metros lands in both.
 */
export function regionsFor(
  job: Pick<NormalizedJob, "location" | "remoteType" | "otherLocations">,
  regions: RegionEntry[],
): string[] {
  // Same remote inference search applies, for imported and stored jobs.
  const normalized = normalizeRemoteType(job);
  return regions
    .filter((region) =>
      region.places.some((city) =>
        matches(normalized, { city, flexibility: region.work }),
      ),
    )
    .map((region) => region.name);
}

/**
 * Gives every job that has no region yet the regions its stored location
 * matches. Covers jobs from before regions existed, `--role`/`--location`
 * searches, and jobs nothing matched before a region was added. Jobs
 * that already have a region are left alone. Returns how many jobs
 * got at least one region. Stored jobs keep no other locations, so only
 * the main location counts here.
 */
export function tagUntaggedJobs(db: Database, regions: RegionEntry[]): number {
  if (regions.length === 0) return 0;
  let tagged = 0;
  db.transaction(() => {
    for (const job of allJobs(db)) {
      if (job.regions.length > 0) continue;
      const found = regionsFor(job, regions);
      if (found.length === 0) continue;
      addJobRegions(db, job.listingId, found);
      tagged++;
    }
  })();
  return tagged;
}
