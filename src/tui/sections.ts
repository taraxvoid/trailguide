import type { StoredJob } from "../db.ts";
import { UNASSIGNED } from "../regions.ts";

export type ViewTab = "active" | "applied" | "archived";

export const NO_TRAIL_LABEL = "Not on a trail (for now)";

export type SectionTone = "applied" | "archived" | "trail" | "none";

export interface Section {
  id: string;
  label: string;
  tone: SectionTone;
}

/**
 * Whether a job shows in `region`. `null` (no regions configured) shows
 * everything; `unassigned` holds jobs that belong to no region.
 */
export function inRegion(job: StoredJob, region: string | null): boolean {
  if (region === null) return true;
  const regions = job.regions ?? [];
  return region === UNASSIGNED
    ? regions.length === 0
    : regions.includes(region);
}

/** The job states a view lists. */
function inView(job: StoredJob, view: ViewTab): boolean {
  return job.state === view;
}

/**
 * Which list section a job falls in. Applied and archived have one flat
 * section each. The active view groups jobs by configured trail (in config
 * order); jobs without a configured trail go under a nudge header, or a
 * plain "Active" one when no trails are configured at all.
 */
export function sectionOf(
  job: StoredJob,
  view: ViewTab,
  trails: string[],
): Section {
  if (view === "archived")
    return { id: "archived", label: "Archived", tone: "archived" };
  if (view === "applied")
    return { id: "applied", label: "Applied", tone: "applied" };
  if (job.trail && trails.includes(job.trail))
    return {
      id: `trail:${job.trail}`,
      label: `Trail: ${job.trail}`,
      tone: "trail",
    };
  if (trails.length > 0)
    return { id: "none", label: NO_TRAIL_LABEL, tone: "none" };
  return { id: "active", label: "Active", tone: "trail" };
}

/** Jobs for a view, ordered so each section is contiguous. */
export function orderJobs(
  jobs: StoredJob[],
  view: ViewTab,
  trails: string[],
  tailoredIds: ReadonlySet<string>,
): StoredJob[] {
  const listed = jobs.filter((j) => inView(j, view));
  if (view === "archived") return listed;
  if (view === "applied") {
    // Array.prototype.sort is stable, so ties keep the db order.
    return listed.sort(
      (x, y) =>
        Number(tailoredIds.has(y.listingId)) -
        Number(tailoredIds.has(x.listingId)),
    );
  }
  const rank = (job: StoredJob): number => {
    const { id } = sectionOf(job, view, trails);
    if (id.startsWith("trail:")) return trails.indexOf(job.trail ?? "");
    return trails.length;
  };
  return listed.sort((x, y) => rank(x) - rank(y));
}

/** Jobs per view in `region`, for the header strip. */
export function viewCounts(
  jobs: StoredJob[],
  region: string | null,
): Record<ViewTab, number> {
  const counts: Record<ViewTab, number> = {
    active: 0,
    applied: 0,
    archived: 0,
  };
  for (const job of jobs) {
    if (!inRegion(job, region)) continue;
    if (job.state === "active" || job.state === "applied") counts[job.state]++;
    else if (job.state === "archived") counts.archived++;
  }
  return counts;
}

/** Jobs per section id, for header counts. */
export function sectionCounts(
  ordered: StoredJob[],
  view: ViewTab,
  trails: string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const job of ordered) {
    const { id } = sectionOf(job, view, trails);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
