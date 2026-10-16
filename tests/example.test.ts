import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, resolveBoards } from "../src/config.ts";
import { matchesLocation } from "../src/sources/location.ts";

// The example config is documentation people copy; keep it valid.
describe("trailguide.example.toml", () => {
  const path = join(import.meta.dir, "..", "trailguide.example.toml");
  const config = parseConfig(readFileSync(path, "utf8"), path);

  it("parses and exercises every section", () => {
    expect(config.locations?.length).toBeGreaterThan(0);
    expect(config.locations?.[0]?.aliases).toEqual([
      "Round Rock",
      "Cedar Park",
    ]);
    expect(config.keywords?.map((k) => k.trail)).toEqual([
      "platform",
      "security",
    ]);
    expect(config.clearance).toBe("include");
    expect(config.excludeTerms).toEqual(["Some Staffing Co"]);
    expect(config.boards?.map((b) => b.ats)).toEqual(["greenhouse", "workday"]);
  });

  it("adds its boards to the built-in set", () => {
    expect(resolveBoards(config).length).toBe(resolveBoards({}).length + 2);
  });
});

// A second, region-specific example; keep it valid and its comments true.
describe("examples/bay-area.toml", () => {
  const path = join(import.meta.dir, "..", "examples", "bay-area.toml");
  const config = parseConfig(readFileSync(path, "utf8"), path);
  const onsite = (config.locations ?? [])
    .filter((l) => l.flexibility === "in-person")
    .flatMap((l) => [l.city, ...(l.aliases ?? [])]);
  const matches = (job: string) => matchesLocation(job, onsite);

  it("parses, with a trail on every keyword", () => {
    expect(config.locations?.length).toBe(4);
    expect(config.keywords?.every((k) => k.trail)).toBe(true);
    expect(resolveBoards(config).length).toBe(
      resolveBoards({}).length + (config.boards?.length ?? 0),
    );
  });

  it("matches the commute and nothing that shares its town names", () => {
    for (const job of [
      "Pleasanton, CA",
      "Hybrid - Dublin",
      "Fremont, California",
      "Oakland, CA",
      "San Francisco, CA",
      "San Jose, CA",
      "Milpitas, CA",
    ]) {
      expect(matches(job)).toBe(true);
    }
    for (const job of [
      "Dublin, Ireland",
      "Fremont, NE",
      "San Jose, Costa Rica",
      "Sunnyvale, CA",
      "San Mateo, CA",
    ]) {
      expect(matches(job)).toBe(false);
    }
  });
});
