import type { RegionEntry } from "./config.ts";
import { matches } from "./sources/location.ts";
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
  return regions
    .filter((region) =>
      region.places.some((city) =>
        matches(job, { city, flexibility: region.work }),
      ),
    )
    .map((region) => region.name);
}
