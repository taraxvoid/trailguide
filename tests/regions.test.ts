import { describe, expect, it } from "bun:test";
import type { RegionEntry } from "../src/config.ts";
import { getJob, openDb, upsertJobs } from "../src/db.ts";
import { regionsFor, tagUntaggedJobs } from "../src/regions.ts";
import type { RemoteType } from "../src/sources/types.ts";

const REGIONS: RegionEntry[] = [
  { name: "bay", work: "in-person", places: ["East Bay", "San Francisco"] },
  { name: "omaha", work: "in-person", places: ["Omaha metro"] },
  { name: "remote", work: "remote", places: ["United States"] },
];

const at = (
  location: string,
  remoteType: RemoteType,
  otherLocations?: string[],
) => ({ location, remoteType, ...(otherLocations && { otherLocations }) });

describe("regionsFor", () => {
  it("puts a hybrid East Bay job in bay", () => {
    expect(regionsFor(at("Oakland, CA", "hybrid"), REGIONS)).toEqual(["bay"]);
  });

  it("puts a remote job in a Bay town only in remote", () => {
    expect(regionsFor(at("San Francisco, CA", "remote"), REGIONS)).toEqual([
      "remote",
    ]);
  });

  it("puts a listing naming two metros in both", () => {
    expect(
      regionsFor(at("San Francisco, CA", "onsite", ["Omaha, NE"]), REGIONS),
    ).toEqual(["bay", "omaha"]);
  });

  it("puts a job elsewhere in none", () => {
    expect(regionsFor(at("Berlin, Germany", "onsite"), REGIONS)).toEqual([]);
  });
});

describe("tagUntaggedJobs", () => {
  const job = (sourceId: string, location: string, regions?: string[]) => ({
    sourceId,
    source: "greenhouse" as const,
    title: `SWE ${sourceId}`,
    company: "Acme",
    location,
    remoteType: "onsite" as const,
    url: `https://e.com/${sourceId}`,
    postedAt: null,
    description: null,
    ...(regions && { regions }),
  });

  it("tags only untagged jobs", () => {
    const db = openDb(":memory:");
    upsertJobs(db, [
      job("a", "Oakland, CA"),
      job("b", "Berlin, Germany"),
      job("c", "Oakland, CA", ["omaha"]),
    ]);
    expect(tagUntaggedJobs(db, REGIONS)).toBe(1);
    expect(getJob(db, "greenhouse:a")?.regions).toEqual(["bay"]);
    expect(getJob(db, "greenhouse:b")?.regions).toEqual([]);
    expect(getJob(db, "greenhouse:c")?.regions).toEqual(["omaha"]);
  });
});
