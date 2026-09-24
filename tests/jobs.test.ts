import { describe, expect, it } from "bun:test";
import { parseRange, truncateWords, weekRange } from "../src/dateRange.ts";
import {
  jobsInStateBetween,
  openDb,
  setJobState,
  upsertJobs,
} from "../src/db.ts";
import type { NormalizedJob } from "../src/sources/types.ts";

// Thursday 2026-09-24 local
const now = new Date(2026, 8, 24, 15, 0);

function job(sourceId: string): NormalizedJob {
  return {
    sourceId,
    source: "jsearch",
    title: `Job ${sourceId}`,
    company: "Acme",
    location: "Remote",
    remoteType: "remote",
    url: `https://example.com/${sourceId}`,
    postedAt: null,
    description: null,
  };
}

describe("parseRange", () => {
  it("uses Sunday to Saturday weeks", () => {
    const last = parseRange("last week", now);
    expect(last.from).toEqual(new Date(2026, 8, 13));
    expect(last.to).toEqual(new Date(2026, 8, 20));
    expect(weekRange(now, 0).from).toEqual(new Date(2026, 8, 20));
  });

  it("handles yesterday and last N days", () => {
    expect(parseRange("Yesterday", now).from).toEqual(new Date(2026, 8, 23));
    expect(parseRange("last 7 days", now).from).toEqual(new Date(2026, 8, 17));
  });

  it("rejects unknown input", () => {
    expect(() => parseRange("someday", now)).toThrow(/Unrecognized/);
  });
});

describe("truncateWords", () => {
  it("cuts to the word limit", () => {
    const text = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
    const out = truncateWords(text, 200) ?? "";
    expect(out.replace(/\.\.\.$/, "").split(" ").length).toBe(200);
    expect(truncateWords("a b", 200)).toBe("a b");
    expect(truncateWords(null, 200)).toBeNull();
  });
});

describe("jobsInStateBetween", () => {
  it("filters by when the job entered the state", () => {
    const db = openDb(":memory:");
    upsertJobs(db, [job("1"), job("2")]);
    setJobState(
      db,
      "jsearch:1",
      "applied",
      new Date(2026, 8, 15).toISOString(),
    );
    setJobState(
      db,
      "jsearch:2",
      "applied",
      new Date(2026, 8, 22).toISOString(),
    );
    const { from, to } = parseRange("last week", now);
    const got = jobsInStateBetween(db, "applied", from, to);
    expect(got.map((j) => j.listingId)).toEqual(["jsearch:1"]);
  });
});
