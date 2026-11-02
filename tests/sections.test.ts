import { describe, expect, it } from "bun:test";
import type { StoredJob } from "../src/db.ts";
import {
  inRegion,
  NO_TRAIL_LABEL,
  orderJobs,
  sectionCounts,
  sectionOf,
  viewCounts,
} from "../src/tui/sections.ts";

function job(
  id: string,
  state: StoredJob["state"],
  trail?: string,
  appliedAt?: string,
): StoredJob {
  return {
    listingId: id,
    state,
    ...(trail ? { trail } : {}),
    ...(appliedAt ? { appliedAt } : {}),
  } as StoredJob;
}

const none = new Set<string>();

describe("orderJobs", () => {
  const jobs = [
    job("a", "active"),
    job("b", "active", "platform"),
    job("c", "applied", "secplat"),
    job("d", "active", "secplat"),
    job("e", "archived", "secplat"),
    job("f", "active", "gone"),
  ];

  it("groups active jobs by config trail order, then the rest, without applied ones", () => {
    const ids = orderJobs(jobs, "active", ["secplat", "platform"], none).map(
      (j) => j.listingId,
    );
    expect(ids).toEqual(["d", "b", "a", "f"]);
  });

  it("keeps one flat list when no trails are configured", () => {
    const ids = orderJobs(jobs, "active", [], none).map((j) => j.listingId);
    expect(ids).toEqual(["a", "b", "d", "f"]);
    expect(sectionOf(jobs[0] as StoredJob, "active", []).label).toBe("Active");
  });

  it("shows applied jobs in the applied view, tailored first", () => {
    const applied = [job("x", "applied"), job("y", "applied"), ...jobs];
    const ids = orderJobs(applied, "applied", ["secplat"], new Set(["y"])).map(
      (j) => j.listingId,
    );
    expect(ids).toEqual(["y", "x", "c"]);
    expect(sectionOf(job("x", "applied"), "applied", ["secplat"]).label).toBe(
      "Applied",
    );
  });

  it("shows only archived jobs, flat, in the archived view", () => {
    const ids = orderJobs(jobs, "archived", ["secplat"], none).map(
      (j) => j.listingId,
    );
    expect(ids).toEqual(["e"]);
  });
});

describe("sectionOf / sectionCounts", () => {
  it("labels untrailed jobs with the nudge header when trails exist", () => {
    expect(sectionOf(job("a", "active"), "active", ["t"]).label).toBe(
      NO_TRAIL_LABEL,
    );
  });

  it("counts per section", () => {
    const jobs = [
      job("a", "active", "t"),
      job("b", "active", "t"),
      job("c", "active"),
    ];
    const counts = sectionCounts(jobs, "active", ["t"]);
    expect(counts.get("trail:t")).toBe(2);
    expect(counts.get("none")).toBe(1);
  });
});

describe("regions", () => {
  const tagged = (
    id: string,
    state: StoredJob["state"],
    regions: string[],
  ): StoredJob => ({ ...job(id, state), regions });

  it("inRegion matches multi-region jobs", () => {
    const both = tagged("a", "active", ["bay", "omaha"]);
    expect(inRegion(both, "bay")).toBe(true);
    expect(inRegion(both, "omaha")).toBe(true);
    expect(inRegion(both, "remote")).toBe(false);
  });

  it("inRegion unassigned holds jobs in no region", () => {
    expect(inRegion(tagged("a", "active", []), "unassigned")).toBe(true);
    expect(inRegion(tagged("b", "active", ["bay"]), "unassigned")).toBe(false);
  });

  it("inRegion null keeps every job", () => {
    expect(inRegion(tagged("a", "active", []), null)).toBe(true);
  });

  it("viewCounts counts an applied two-region job in both regions", () => {
    const jobs = [
      tagged("a", "applied", ["bay", "omaha"]),
      tagged("b", "active", ["bay"]),
      tagged("c", "archived", ["omaha"]),
    ];
    expect(viewCounts(jobs, "bay")).toEqual({
      active: 1,
      applied: 1,
      archived: 0,
    });
    expect(viewCounts(jobs, "omaha")).toEqual({
      active: 0,
      applied: 1,
      archived: 1,
    });
  });
});

describe("trail headers", () => {
  it("prefixes configured trail names with 'Trail: '", () => {
    expect(
      sectionOf(job("a", "active", "secplat"), "active", ["secplat"]).label,
    ).toBe("Trail: secplat");
  });
});
