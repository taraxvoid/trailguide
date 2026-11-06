import type { StoredJob } from "../db.ts";
import { UNASSIGNED } from "../regions.ts";
import type { ViewTab } from "./sections.ts";

/**
 * The regions the header strip lists: the configured ones in config order,
 * plus `unassigned` while some job belongs to none, so nothing disappears.
 */
export function stripRegions(
  configured: string[],
  jobs: StoredJob[],
): string[] {
  if (configured.length === 0) return [];
  return jobs.some((job) => (job.regions ?? []).length === 0)
    ? [...configured, UNASSIGNED]
    : configured;
}

/** The region to open on: the saved one if it still exists, else the first. */
export function initialRegion(
  strip: string[],
  saved: string | null,
): string | null {
  if (saved !== null && strip.includes(saved)) return saved;
  return strip[0] ?? null;
}

/** The region `step` places after `current` (-1: before), wrapping around. */
export function nextRegion(strip: string[], current: string, step = 1): string {
  const at = strip.indexOf(current);
  const next =
    strip[(((at + step) % strip.length) + strip.length) % strip.length];
  return next ?? current;
}

/** The region a digit key 1-9 jumps to, if there is one. */
export function regionByKey(strip: string[], input: string): string | null {
  if (!/^[1-9]$/.test(input)) return null;
  return strip[Number(input) - 1] ?? null;
}

/**
 * The view after Tab (Active and Applied swap; Archived goes to Active) or
 * Ctrl+E (into Archived, or back out to `previous`, the view it came from).
 */
export function nextView(
  view: ViewTab,
  key: "tab" | "ctrl-e",
  previous: ViewTab,
): ViewTab {
  if (key === "tab") return view === "active" ? "applied" : "active";
  if (view !== "archived") return "archived";
  return previous === "archived" ? "active" : previous;
}
