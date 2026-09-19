import { describe, expect, it } from "bun:test";
import { matchesLocation } from "../src/sources/location.ts";

describe("matchesLocation", () => {
  it("matches when the job location contains the query, case-insensitively", () => {
    expect(matchesLocation("San Francisco, CA", "san francisco")).toBe(true);
    expect(matchesLocation("Austin, TX", "austin")).toBe(true);
  });

  it("does not match unrelated locations", () => {
    expect(matchesLocation("Austin, TX", "omaha")).toBe(false);
  });

  it("expands metro aliases for known metros", () => {
    expect(matchesLocation("La Vista, NE", "omaha")).toBe(true);
    expect(matchesLocation("Elkhorn, NE", "omaha")).toBe(true);
    expect(matchesLocation("Ralston, NE", "omaha")).toBe(true);
  });

  it("does not expand aliases for unrelated queries", () => {
    expect(matchesLocation("La Vista, NE", "chicago")).toBe(false);
  });

  it("matches when any query in a list of locations matches", () => {
    expect(
      matchesLocation("San Francisco, CA", ["omaha", "san francisco"]),
    ).toBe(true);
    expect(matchesLocation("La Vista, NE", ["chicago", "omaha"])).toBe(true);
    expect(matchesLocation("Austin, TX", ["omaha", "chicago"])).toBe(false);
  });
});
