import { describe, expect, it } from "bun:test";
import type { StoredJob } from "../src/db.ts";
import {
  initialRegion,
  nextRegion,
  nextView,
  regionByKey,
  stripRegions,
} from "../src/tui/regions.ts";

const job = (regions: string[]) => ({ regions }) as StoredJob;

describe("initialRegion", () => {
  it("reopens on the saved region", () => {
    expect(initialRegion(["bay", "omaha"], "omaha")).toBe("omaha");
  });

  it("falls back to the first region when the saved one is gone", () => {
    expect(initialRegion(["bay", "omaha"], "seattle")).toBe("bay");
    expect(initialRegion(["bay", "omaha"], null)).toBe("bay");
  });

  it("is null with no regions", () => {
    expect(initialRegion([], "bay")).toBeNull();
  });
});

describe("stripRegions", () => {
  it("appends unassigned only when a job has no region", () => {
    expect(stripRegions(["bay"], [job(["bay"])])).toEqual(["bay"]);
    expect(stripRegions(["bay"], [job(["bay"]), job([])])).toEqual([
      "bay",
      "unassigned",
    ]);
  });

  it("stays empty without configured regions", () => {
    expect(stripRegions([], [job([])])).toEqual([]);
  });
});

describe("nextRegion", () => {
  it("steps and wraps", () => {
    expect(nextRegion(["bay", "omaha", "remote"], "bay")).toBe("omaha");
    expect(nextRegion(["bay", "omaha", "remote"], "remote")).toBe("bay");
  });

  it("steps backwards and wraps", () => {
    expect(nextRegion(["bay", "omaha", "remote"], "omaha", -1)).toBe("bay");
    expect(nextRegion(["bay", "omaha", "remote"], "bay", -1)).toBe("remote");
  });
});

describe("regionByKey", () => {
  const strip = ["bay", "omaha"];
  it("maps 1-9 to regions", () => {
    expect(regionByKey(strip, "1")).toBe("bay");
    expect(regionByKey(strip, "2")).toBe("omaha");
  });

  it("is null past the end or for other keys", () => {
    expect(regionByKey(strip, "9")).toBeNull();
    expect(regionByKey(strip, "0")).toBeNull();
    expect(regionByKey(strip, "x")).toBeNull();
  });
});

describe("nextView", () => {
  it("tab swaps active and applied, and leaves archived for active", () => {
    expect(nextView("active", "tab", "active")).toBe("applied");
    expect(nextView("applied", "tab", "active")).toBe("active");
    expect(nextView("archived", "tab", "applied")).toBe("active");
  });

  it("ctrl-e opens archived and goes back to the previous view", () => {
    expect(nextView("applied", "ctrl-e", "applied")).toBe("archived");
    expect(nextView("archived", "ctrl-e", "applied")).toBe("applied");
    expect(nextView("archived", "ctrl-e", "archived")).toBe("active");
  });
});
