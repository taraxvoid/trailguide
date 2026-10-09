import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, resolveBoards } from "../src/config.ts";

// The example config is documentation people copy; keep it valid.
describe("igor.example.toml", () => {
  const path = join(import.meta.dir, "..", "igor.example.toml");
  const config = parseConfig(readFileSync(path, "utf8"), path);

  it("parses and exercises every section", () => {
    expect(config.locations?.length).toBeGreaterThan(0);
    expect(config.locations?.[0]?.aliases).toEqual([
      "Round Rock",
      "Cedar Park",
    ]);
    expect(config.keywords?.map((k) => k.lane)).toEqual([
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
