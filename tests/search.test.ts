import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { SearchPlan } from "../src/config.ts";
import { collectJobs, formatRunMessage } from "../src/search.ts";
import type {
  NormalizedJob,
  SearchParams,
  Source,
} from "../src/sources/types.ts";

function job(overrides: Partial<NormalizedJob>): NormalizedJob {
  return {
    sourceId: "1",
    source: "greenhouse",
    title: "Software Engineer",
    company: "Acme",
    location: "Omaha, NE",
    remoteType: "onsite",
    url: "https://example.com/1",
    postedAt: null,
    description: null,
    ...overrides,
  };
}

const NO_FILTER = { excludeClearance: false, excludeTerms: [] };

function fake(
  name: NormalizedJob["source"],
  scoped: boolean,
  respond: (params: SearchParams) => NormalizedJob[],
) {
  const calls: SearchParams[] = [];
  const source: Source = {
    name,
    scoped,
    async search(params) {
      // The runner adds `warn`; tests only care about the query.
      const { warn: _warn, ...query } = params;
      calls.push(query);
      return respond(params);
    },
  };
  return { source, calls };
}

function failing(
  name: NormalizedJob["source"],
  scoped: boolean,
  message: string,
): Source {
  return {
    name,
    scoped,
    async search() {
      throw new Error(message);
    },
  };
}

const OMAHA_AND_US: SearchPlan = {
  keywords: ["swe"],
  trails: {},
  filter: NO_FILTER,
  targets: [
    {
      city: "Omaha",
      flexibility: "in-person",
      region: [],
      aliases: ["La Vista"],
    },
    { city: "United States", flexibility: "remote", region: [] },
  ],
};

const ids = (jobs: NormalizedJob[]) => jobs.map((j) => j.sourceId).sort();

let errorSpy: { mockRestore(): void };
beforeEach(() => {
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe("collectJobs source calls", () => {
  const plan: SearchPlan = { ...OMAHA_AND_US, keywords: ["swe", "devops"] };

  it("calls unscoped sources once with every keyword and no location", async () => {
    const loose = fake("greenhouse", false, () => []);
    await collectJobs(plan, [loose.source]);
    expect(loose.calls).toEqual([{ role: ["swe", "devops"] }]);
  });

  it("skips sources that never label remote jobs for remote targets", async () => {
    const adzuna = fake("adzuna", true, () => []);
    adzuna.source.labelsRemote = false;
    await collectJobs(plan, [adzuna.source]);
    expect(adzuna.calls.map((c) => c.location).sort()).toEqual([
      "Omaha",
      "Omaha",
    ]);
  });

  it("calls scoped sources once per keyword and location", async () => {
    const scoped = fake("jsearch", true, () => []);
    await collectJobs(plan, [scoped.source]);
    const seen = scoped.calls
      .map((c) => `${c.role}|${c.location}|${c.remote === true}`)
      .sort();
    expect(seen).toEqual([
      "devops|Omaha|false",
      "devops|United States|true",
      "swe|Omaha|false",
      "swe|United States|true",
    ]);
  });
});

describe("collectJobs filtering", () => {
  it("filters each location with its own flexibility", async () => {
    const loose = fake("greenhouse", false, () =>
      [
        job({ sourceId: "a", location: "Omaha, NE", remoteType: "onsite" }),
        job({ sourceId: "b", location: "La Vista, NE", remoteType: "unknown" }),
        job({ sourceId: "c", location: "Remote - USA", remoteType: "remote" }),
        job({
          sourceId: "d",
          location: "Remote - Europe",
          remoteType: "remote",
        }),
        job({ sourceId: "e", location: "Austin, TX", remoteType: "onsite" }),
        job({ sourceId: "f", location: "Remote", remoteType: "unknown" }),
        job({ sourceId: "g", location: "Omaha, NE", remoteType: "remote" }),
        job({ sourceId: "h", location: "Omaha, NE", remoteType: "hybrid" }),
      ].map((j) => ({
        ...j,
        title: `SWE ${j.sourceId}`,
        url: `https://e.com/${j.sourceId}`,
      })),
    );
    const { jobs } = await collectJobs(OMAHA_AND_US, [loose.source]);
    // a, b, h: in-person Omaha. c, f, g: remote and eligible for the US
    // (g is located in a US state). d: remote Europe. e: wrong city.
    expect(ids(jobs)).toEqual(["a", "b", "c", "f", "g", "h"]);
    expect(jobs.find((j) => j.sourceId === "f")?.remoteType).toBe("remote");
  });

  it("trusts scoped sources for place and checks only the work type", async () => {
    const scoped = fake("jsearch", true, (params) =>
      params.location === "Omaha"
        ? [
            job({
              sourceId: "s1",
              source: "jsearch",
              location: "Dallas, TX",
              remoteType: "unknown",
              url: "https://e.com/s1",
            }),
          ]
        : [
            job({
              sourceId: "s2",
              source: "jsearch",
              title: "Remote SWE",
              location: "Remote - Europe",
              remoteType: "remote",
              url: "https://e.com/s2",
            }),
            job({
              sourceId: "s3",
              source: "jsearch",
              title: "Chicago SWE",
              location: "Chicago, IL",
              remoteType: "unknown",
              url: "https://e.com/s3",
            }),
          ],
    );
    const { jobs } = await collectJobs(OMAHA_AND_US, [scoped.source]);
    expect(ids(jobs)).toEqual(["s1", "s2"]);
  });

  it("checks only the work type when no location was given", async () => {
    const plan: SearchPlan = {
      keywords: ["swe"],
      trails: {},
      filter: NO_FILTER,
      targets: [{ city: null, flexibility: "remote", region: [] }],
    };
    const loose = fake("greenhouse", false, () => [
      job({
        sourceId: "r",
        location: "Remote - Europe",
        remoteType: "remote",
        url: "https://e.com/r",
      }),
      job({ sourceId: "o", title: "Onsite SWE", url: "https://e.com/o" }),
    ]);
    expect(ids((await collectJobs(plan, [loose.source])).jobs)).toEqual(["r"]);
  });

  it("dedupes, drops internships, and drops clearance jobs only when asked", async () => {
    const respond = () => [
      job({ sourceId: "h" }),
      job({ sourceId: "h2" }), // same company/title/location as h
      job({ sourceId: "i", title: "SWE Intern", url: "https://e.com/i" }),
      job({
        sourceId: "c",
        title: "SWE (Security Clearance)",
        url: "https://e.com/c",
      }),
    ];
    const kept = await collectJobs(OMAHA_AND_US, [
      fake("greenhouse", false, respond).source,
    ]);
    expect(kept.jobs.map((j) => j.title).sort()).toEqual([
      "SWE (Security Clearance)",
      "Software Engineer",
    ]);
    const dropped = await collectJobs(
      {
        ...OMAHA_AND_US,
        filter: { excludeClearance: true, excludeTerms: [] },
      },
      [fake("greenhouse", false, respond).source],
    );
    expect(dropped.jobs.map((j) => j.title)).toEqual(["Software Engineer"]);
  });

  it("drops listings that mention a configured term, as a whole word", async () => {
    const respond = () => [
      job({ sourceId: "a", title: "Backend Engineer", company: "Lockheed Co" }),
      job({
        sourceId: "b",
        title: "SWE",
        description: "Onsite at Offutt AFB",
        url: "https://e.com/b",
      }),
      job({
        sourceId: "c",
        title: "SWE II",
        description: "We love C++ and offuttish things",
        url: "https://e.com/c",
      }),
    ];
    const result = await collectJobs(
      {
        ...OMAHA_AND_US,
        filter: {
          excludeClearance: false,
          excludeTerms: ["lockheed", "Offutt"],
        },
      },
      [fake("greenhouse", false, respond).source],
    );
    expect(result.jobs.map((j) => j.sourceId)).toEqual(["c"]);
  });
});

describe("collectJobs failures", () => {
  it("records each failing source once and keeps the others' results", async () => {
    const plan: SearchPlan = { ...OMAHA_AND_US, keywords: ["swe", "devops"] };
    const result = await collectJobs(plan, [
      failing("jsearch", true, "JSearch request failed: 429"),
      fake("greenhouse", false, () => [job({})]).source,
    ]);
    expect(result.failures).toEqual([
      { source: "jsearch", message: "JSearch request failed: 429" },
    ]);
    expect(result.jobs).toHaveLength(1);
    expect(result.allFailed).toBe(false);
  });

  it("reports allFailed when every call fails", async () => {
    const result = await collectJobs(OMAHA_AND_US, [
      failing("jsearch", true, "429"),
      failing("remoteok", false, "500"),
    ]);
    expect(result.allFailed).toBe(true);
    expect(result.failures.map((f) => f.source).sort()).toEqual([
      "jsearch",
      "remoteok",
    ]);
  });

  it("is not allFailed with no sources at all", async () => {
    expect((await collectJobs(OMAHA_AND_US, [])).allFailed).toBe(false);
  });
});

describe("formatRunMessage", () => {
  it("summarizes counts and failed sources", () => {
    expect(formatRunMessage({ found: 3, new: 1, failures: [] })).toBe(
      "3 found, 1 new",
    );
    expect(
      formatRunMessage({
        found: 3,
        new: 1,
        failures: [
          { source: "jsearch", message: "429" },
          { source: "adzuna", message: "timeout" },
        ],
      }),
    ).toBe("3 found, 1 new; failed: jsearch: 429, adzuna: timeout");
  });
});

describe("trails", () => {
  const plan: SearchPlan = {
    keywords: ["Platform Engineer", "Security Engineer"],
    trails: { "Platform Engineer": "platform", "Security Engineer": "secplat" },
    filter: NO_FILTER,
    targets: [{ city: null, flexibility: "any", region: [] }],
  };

  it("tags scoped results with their keyword's trail", async () => {
    const scoped = fake("jsearch", true, (params) => [
      job({
        sourceId: String(params.role),
        title: "Engineer",
        company: String(params.role),
        url: `https://e.com/${params.role}`,
      }),
    ]);
    const { jobs } = await collectJobs(plan, [scoped.source]);
    expect(Object.fromEntries(jobs.map((j) => [j.sourceId, j.trail]))).toEqual({
      "Platform Engineer": "platform",
      "Security Engineer": "secplat",
    });
  });

  it("tags unscoped results by the first keyword in the title", async () => {
    const loose = fake("greenhouse", false, () => [
      job({
        sourceId: "s",
        title: "Senior Security Engineer",
        url: "https://e.com/s",
      }),
      job({ sourceId: "n", title: "Data Analyst", url: "https://e.com/n" }),
      job({
        sourceId: "w",
        title: "Platform Engineering Manager",
        url: "https://e.com/w",
      }),
    ]);
    const { jobs } = await collectJobs(plan, [loose.source]);
    expect(Object.fromEntries(jobs.map((j) => [j.sourceId, j.trail]))).toEqual({
      s: "secplat",
      n: undefined,
      w: undefined,
    });
  });
});
