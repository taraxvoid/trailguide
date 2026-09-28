import { describe, expect, it } from "bun:test";
import type { Flexibility, SearchTarget } from "../src/config.ts";
import {
  matches,
  matchesLocation,
  normalizeRemoteType,
  remoteEligible,
} from "../src/sources/location.ts";
import type { RemoteType } from "../src/sources/types.ts";

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

describe("matchesLocation word boundaries", () => {
  it('does not match "us" inside other words', () => {
    expect(matchesLocation("Houston, TX", "us")).toBe(false);
    expect(matchesLocation("Australia", "us")).toBe(false);
    expect(matchesLocation("Remote (US)", "us")).toBe(true);
  });

  it("expands the United States aliases on word boundaries", () => {
    expect(matchesLocation("Remote - USA", "United States")).toBe(true);
    expect(matchesLocation("U.S. only", "United States")).toBe(true);
    expect(matchesLocation("Houston, TX", "United States")).toBe(false);
    expect(matchesLocation("San Francisco, CA", "United States")).toBe(false);
  });
});

describe("remoteEligible", () => {
  const us = (location: string) => remoteEligible(location, "United States");

  it("accepts blank and bare global locations", () => {
    for (const loc of [
      "",
      "Remote",
      "Worldwide",
      "Anywhere",
      " Global ",
      "International",
      "Remote - Worldwide",
      "Anywhere in the World",
    ]) {
      expect(us(loc)).toBe(true);
    }
  });

  it("accepts listings naming the country or an alias", () => {
    expect(us("USA Only")).toBe(true);
    expect(us("Remote (US)")).toBe(true);
    expect(us("North America")).toBe(true);
  });

  it("rejects other regions", () => {
    expect(us("Remote - Europe")).toBe(false);
    expect(us("Australia")).toBe(false);
    expect(us("Houston")).toBe(false);
  });

  it("lets Omaha's metro alias and a region list add remote eligibility", () => {
    expect(remoteEligible("Remote - Nebraska", "Omaha")).toBe(true);
    expect(remoteEligible("Remote - Nebraska", "Lincoln")).toBe(false);
    expect(remoteEligible("Remote - Nebraska", "Lincoln", ["Nebraska"])).toBe(
      true,
    );
    expect(remoteEligible("Remote - TX", "Austin", ["Texas", "TX"])).toBe(true);
  });
});

describe("normalizeRemoteType", () => {
  it("turns unknown plus 'remote' in the location into remote", () => {
    const job = normalizeRemoteType({
      location: "Remote - US",
      remoteType: "unknown" as RemoteType,
    });
    expect(job.remoteType).toBe("remote");
  });

  it("keeps the positive forms remote", () => {
    for (const location of ["Remote", "US (Remote)", "Remote - US"]) {
      expect(
        normalizeRemoteType({ location, remoteType: "unknown" as RemoteType })
          .remoteType,
      ).toBe("remote");
    }
  });

  it("does not treat negated remote as remote", () => {
    for (const location of [
      "Omaha, NE (Non-remote)",
      "No remote",
      "Not remote",
      "Non remote",
    ]) {
      expect(
        normalizeRemoteType({ location, remoteType: "unknown" as RemoteType })
          .remoteType,
      ).toBe("unknown");
    }
  });

  it("leaves everything else alone", () => {
    expect(
      normalizeRemoteType({
        location: "Omaha, NE",
        remoteType: "unknown" as RemoteType,
      }).remoteType,
    ).toBe("unknown");
    expect(
      normalizeRemoteType({
        location: "Remote office, Omaha",
        remoteType: "onsite" as RemoteType,
      }).remoteType,
    ).toBe("onsite");
    expect(
      normalizeRemoteType({
        location: "Remotely, NE",
        remoteType: "unknown" as RemoteType,
      }).remoteType,
    ).toBe("unknown");
  });
});

describe("matches", () => {
  const omaha = (flexibility: Flexibility): SearchTarget => ({
    city: "Omaha",
    flexibility,
    region: [],
  });

  const table: [RemoteType, Flexibility, boolean][] = [
    ["remote", "remote", true],
    ["remote", "in-person", false],
    ["remote", "any", true],
    ["onsite", "remote", false],
    ["onsite", "in-person", true],
    ["onsite", "any", true],
    ["hybrid", "remote", false],
    ["hybrid", "in-person", true],
    ["hybrid", "any", true],
    ["unknown", "remote", false],
    ["unknown", "in-person", true],
    ["unknown", "any", true],
  ];

  for (const [remoteType, flexibility, expected] of table) {
    it(`${remoteType} job in Omaha vs ${flexibility} Omaha is ${expected}`, () => {
      expect(
        matches({ location: "Omaha, NE", remoteType }, omaha(flexibility)),
      ).toBe(expected);
    });
  }

  it("uses Nebraska only for remote eligibility, never for onsite matching", () => {
    expect(
      matches(
        { location: "Remote - Nebraska", remoteType: "remote" },
        omaha("any"),
      ),
    ).toBe(true);
    expect(
      matches(
        { location: "Lincoln, Nebraska", remoteType: "onsite" },
        omaha("in-person"),
      ),
    ).toBe(false);
    const lincoln: SearchTarget = {
      city: "Lincoln",
      flexibility: "any",
      region: ["Nebraska"],
    };
    expect(
      matches({ location: "Remote - Nebraska", remoteType: "remote" }, lincoln),
    ).toBe(true);
    expect(
      matches({ location: "Nebraska", remoteType: "onsite" }, lincoln),
    ).toBe(false);
  });

  it("does not let an unlabeled US job match a city", () => {
    expect(
      matches(
        { location: "United States", remoteType: "unknown" },
        omaha("in-person"),
      ),
    ).toBe(false);
  });

  it("broad regions match onsite jobs only when the text names the region", () => {
    const us: SearchTarget = {
      city: "United States",
      flexibility: "any",
      region: [],
    };
    expect(
      matches({ location: "San Francisco, CA", remoteType: "onsite" }, us),
    ).toBe(false);
    expect(
      matches({ location: "Austin, TX, USA", remoteType: "onsite" }, us),
    ).toBe(true);
  });

  it("skips place checks for scoped sources and for targets without a city", () => {
    expect(
      matches(
        { location: "Dallas, TX", remoteType: "onsite" },
        omaha("in-person"),
        { scoped: true },
      ),
    ).toBe(true);
    const usRemote: SearchTarget = {
      city: "United States",
      flexibility: "remote",
      region: [],
    };
    expect(
      matches({ location: "Remote - Europe", remoteType: "remote" }, usRemote, {
        scoped: true,
      }),
    ).toBe(true);
    expect(
      matches({ location: "Dallas, TX", remoteType: "onsite" }, usRemote, {
        scoped: true,
      }),
    ).toBe(false);
    const anywhere: SearchTarget = {
      city: null,
      flexibility: "remote",
      region: [],
    };
    expect(
      matches({ location: "Remote - Europe", remoteType: "remote" }, anywhere),
    ).toBe(true);
    expect(
      matches({ location: "Dallas, TX", remoteType: "onsite" }, anywhere),
    ).toBe(false);
  });

  it("checks other listed locations too", () => {
    const usRemote: SearchTarget = {
      city: "United States",
      flexibility: "remote",
      region: [],
    };
    expect(
      matches(
        {
          location: "New York, NY (HQ)",
          otherLocations: ["Remote (US)"],
          remoteType: "remote",
        },
        usRemote,
      ),
    ).toBe(true);
  });
});

describe("city normalization for aliases", () => {
  it("treats 'Omaha, NE' as the Omaha metro in person", () => {
    expect(matchesLocation("La Vista, NE", "Omaha, NE")).toBe(true);
    expect(matchesLocation("Omaha, Nebraska", "Omaha, NE")).toBe(true);
    expect(matchesLocation("Omaha, NE", "Omaha, NE")).toBe(true);
  });

  it("makes 'Remote - Nebraska' eligible for 'Omaha, NE' but only remotely", () => {
    expect(remoteEligible("Remote - Nebraska", "Omaha, NE")).toBe(true);
    expect(matchesLocation("Remote - Nebraska", "Omaha, NE")).toBe(false);
    const target: SearchTarget = {
      city: "Omaha, NE",
      flexibility: "in-person",
      region: [],
    };
    expect(
      matches({ location: "Remote - Nebraska", remoteType: "onsite" }, target),
    ).toBe(false);
  });

  it("expands US abbreviations", () => {
    expect(remoteEligible("Remote - U.S.", "USA")).toBe(true);
    expect(remoteEligible("Remote - North America", "US")).toBe(true);
    expect(remoteEligible("Remote - U.S.", "U.S.")).toBe(true);
  });

  it("never matches blank terms", () => {
    expect(remoteEligible("Remote - Europe", "")).toBe(false);
    expect(remoteEligible("Remote - Europe", "  ", [" "])).toBe(false);
    expect(matchesLocation("Anywhere", "")).toBe(false);
  });
});

describe("state-stripped key is not a match term", () => {
  it("does not match a same-named city in another state", () => {
    expect(matchesLocation("Portland, ME", "Portland, OR")).toBe(false);
    expect(matchesLocation("Springfield, MA", "Springfield, IL")).toBe(false);
    expect(matchesLocation("Portland, OR", "Portland, OR")).toBe(true);
  });

  it("expands USA and U.S. cities against United States text", () => {
    expect(matchesLocation("United States", "USA")).toBe(true);
    expect(matchesLocation("United States", "U.S.")).toBe(true);
  });
});
