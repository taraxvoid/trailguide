import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, resolveBoards } from "../src/config.ts";

// The example config is documentation people copy; keep it valid.
describe("trailguide.example.toml", () => {
  const path = join(import.meta.dir, "..", "trailguide.example.toml");
  const config = parseConfig(readFileSync(path, "utf8"), path);

  it("parses and exercises every section", () => {
    expect(config.regions?.map((r) => r.name)).toEqual(["austin", "remote"]);
    expect(config.regions?.[0]?.places).toEqual([
      "Austin, TX",
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

describe("examples/nonprofits.toml", () => {
  const path = join(import.meta.dir, "..", "examples", "nonprofits.toml");
  const config = parseConfig(readFileSync(path, "utf8"), path);

  it("parses and lists only board systems trailguide reads", () => {
    expect(config.boards?.map((b) => b.ats)).toEqual([
      "greenhouse",
      "greenhouse",
      "greenhouse",
      "workable",
      "workable",
    ]);
  });

  it("adds its boards to the built-in set", () => {
    expect(resolveBoards(config).length).toBe(resolveBoards({}).length + 5);
  });
});
