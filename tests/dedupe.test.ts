import { describe, expect, it } from "bun:test";
import { dedupe } from "../src/dedupe.ts";
import type { NormalizedJob } from "../src/sources/types.ts";

function job(overrides: Partial<NormalizedJob>): NormalizedJob {
  return {
    sourceId: "1",
    source: "jsearch",
    title: "Software Engineer",
    company: "Acme",
    location: "Remote",
    remoteType: "remote",
    url: "https://example.com",
    postedAt: null,
    description: null,
    ...overrides,
  };
}

describe("dedupe regions", () => {
  it("unions regions whichever copy wins", () => {
    const [kept] = dedupe([
      job({ sourceId: "1", regions: ["bay"] }),
      job({ sourceId: "2", regions: ["omaha"], description: "longer" }),
    ]);
    expect(kept?.regions).toEqual(["bay", "omaha"]);
  });
});

describe("dedupe", () => {
  it("collapses the same job seen across different sources", () => {
    const jobs = [
      job({ source: "jsearch", sourceId: "1" }),
      job({
        source: "adzuna",
        sourceId: "abc",
        description: "Full description here.",
      }),
    ];

    const result = dedupe(jobs);

    expect(result).toHaveLength(1);
    expect(result[0]?.description).toBe("Full description here.");
  });

  it("keeps genuinely different jobs separate", () => {
    const jobs = [
      job({ title: "Software Engineer" }),
      job({ title: "Staff Engineer" }),
    ];

    expect(dedupe(jobs)).toHaveLength(2);
  });

  it("treats casing/whitespace differences as the same job", () => {
    const jobs = [job({ company: "Acme" }), job({ company: "  ACME  " })];

    expect(dedupe(jobs)).toHaveLength(1);
  });
});
