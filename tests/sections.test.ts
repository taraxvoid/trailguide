import { describe, expect, it } from "bun:test";
import type { StoredJob } from "../src/db.ts";
import {
  NO_TRAIL_LABEL,
  orderJobs,
  sectionCounts,
  sectionOf,
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

  it("pins applied, then groups by config trail order, then the rest", () => {
    const ids = orderJobs(jobs, "active", ["secplat", "platform"], none).map(
      (j) => j.listingId,
    );
    expect(ids).toEqual(["c", "d", "b", "a", "f"]);
  });

  it("keeps one flat list when no trails are configured", () => {
    const ids = orderJobs(jobs, "active", [], none).map((j) => j.listingId);
    expect(ids).toEqual(["c", "a", "b", "d", "f"]);
    expect(sectionOf(jobs[0] as StoredJob, "active", []).label).toBe("Active");
  });

  it("puts tailored applied jobs first", () => {
    const applied = [job("x", "applied"), job("y", "applied")];
    const ids = orderJobs(applied, "active", [], new Set(["y"])).map(
      (j) => j.listingId,
    );
    expect(ids).toEqual(["y", "x"]);
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

describe("trail headers", () => {
  it("prefixes configured trail names with 'Trail: '", () => {
    expect(
      sectionOf(job("a", "active", "secplat"), "active", ["secplat"]).label,
    ).toBe("Trail: secplat");
  });
});
