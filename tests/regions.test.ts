import { describe, expect, it } from "bun:test";
import type { RegionEntry } from "../src/config.ts";
import { regionsFor } from "../src/regions.ts";
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
