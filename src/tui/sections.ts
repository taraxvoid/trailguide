import type { StoredJob } from "../db.ts";

export type ViewTab = "active" | "archived";

export const NO_TRAIL_LABEL = "Not on a trail (for now)";

export type SectionTone = "applied" | "archived" | "trail" | "none";

export interface Section {
  id: string;
  label: string;
  tone: SectionTone;
}

/**
 * Which list section a job falls in. Archived has one flat section. The
 * active view pins applied jobs, then groups the rest by configured trail
 * (in config order); jobs without a configured trail go under a nudge
 * header, or a plain "Active" one when no trails are configured at all.
 */
export function sectionOf(
  job: StoredJob,
  view: ViewTab,
  trails: string[],
): Section {
  if (view === "archived")
    return { id: "archived", label: "Archived", tone: "archived" };
  if (job.state === "applied")
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
  if (view === "archived") return jobs.filter((j) => j.state === "archived");
  const inView = jobs.filter(
    (j) => j.state === "applied" || j.state === "active",
  );
  const rank = (job: StoredJob): number => {
    const { id } = sectionOf(job, view, trails);
    if (id === "applied") return 0;
    if (id.startsWith("trail:")) return 1 + trails.indexOf(job.trail ?? "");
    return 1 + trails.length;
  };
  // Array.prototype.sort is stable, so ties keep the db order.
  return inView.sort((x, y) => {
    const byRank = rank(x) - rank(y);
    if (byRank !== 0) return byRank;
    if (x.state === "applied")
      return (
        Number(tailoredIds.has(y.listingId)) -
        Number(tailoredIds.has(x.listingId))
      );
    return 0;
  });
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
