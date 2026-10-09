import type { NormalizedJob } from "./sources/types.ts";

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Cross-source identity key: same posting reappearing across JSearch/Adzuna/
 * Greenhouse/Lever (or reposted with a fresh source id) should collapse to
 * one row, keyed on what a human would call "the same job" rather than each
 * source's own id.
 */
export function dedupeKey(job: NormalizedJob): string {
  return [
    normalize(job.company),
    normalize(job.title),
    normalize(job.location),
  ].join("::");
}

export function dedupe(jobs: NormalizedJob[]): NormalizedJob[] {
  const seen = new Map<string, NormalizedJob>();
  for (const job of jobs) {
    const key = dedupeKey(job);
    const existing = seen.get(key);
    // Prefer the entry with the richer description when the same job shows up twice.
    if (
      !existing ||
      (job.description?.length ?? 0) > (existing.description?.length ?? 0)
    ) {
      // Keep a trail whichever copy wins.
      const trail = job.trail ?? existing?.trail;
      seen.set(key, trail ? { ...job, trail } : job);
    }
  }
  return [...seen.values()];
}
