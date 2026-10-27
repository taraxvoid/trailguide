import { afterEach, describe, expect, it, mock } from "bun:test";
import { companiesForAts } from "../src/sources/seed.ts";
import {
  createWorkdaySource,
  fetchWorkdayJob,
  workdayRemoteType,
} from "../src/sources/workday.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const postings = [
  {
    title: "Staff Platform Engineer",
    externalPath: "/job/USA-CA-Pleasanton/Staff-Platform-Engineer_JR-1",
    locationsText: "USA, CA, Pleasanton",
    bulletFields: ["JR-1"],
  },
  {
    title: "Account Executive",
    externalPath: "/job/USA-CA-Pleasanton/Account-Executive_JR-2",
    locationsText: "USA, CA, Pleasanton",
    bulletFields: ["JR-2"],
  },
];

function fakeWorkday(detail: (url: string) => Response) {
  const calls: { url: string; body?: unknown }[] = [];
  globalThis.fetch = mock(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (init?.method === "POST") {
      return new Response(
        JSON.stringify({ total: postings.length, jobPostings: postings }),
      );
    }
    return detail(url);
  }) as unknown as typeof fetch;
  return calls;
}

describe("workday source", () => {
  const boards = companiesForAts("workday");

  it("searches each board per keyword and keeps title matches with details", async () => {
    const calls = fakeWorkday(
      () =>
        new Response(
          JSON.stringify({
            jobPostingInfo: {
              jobReqId: "JR-1",
              location: "Pleasanton, CA",
              additionalLocations: ["San Jose, CA"],
              remoteType: "Hybrid",
              startDate: "2026-10-01",
              jobDescription: "<p>Build the <b>platform</b>.</p>",
            },
          }),
        ),
    );
    const jobs = await createWorkdaySource().search({
      role: "platform engineer",
    });

    expect(jobs).toHaveLength(boards.length);
    const [first] = jobs;
    const board = boards[0];
    expect(first).toMatchObject({
      source: "workday",
      sourceId: `${board?.slug}:JR-1`,
      title: "Staff Platform Engineer",
      company: board?.company,
      location: "Pleasanton, CA",
      otherLocations: ["San Jose, CA"],
      remoteType: "hybrid",
      postedAt: "2026-10-01",
      url: `https://${board?.slug}.${board?.host}.myworkdayjobs.com/${board?.site}/job/USA-CA-Pleasanton/Staff-Platform-Engineer_JR-1`,
    });
    expect(first?.description).toContain("Build the platform");
    const search = calls.find((c) => c.body);
    expect(search?.url).toBe(
      `https://${board?.slug}.${board?.host}.myworkdayjobs.com/wday/cxs/${board?.slug}/${board?.site}/jobs`,
    );
    expect(search?.body).toMatchObject({
      searchText: "platform engineer",
      offset: 0,
    });
  });

  it("falls back to search fields when a detail request fails", async () => {
    fakeWorkday(() => new Response("nope", { status: 500 }));
    const [job] = await createWorkdaySource().search({ role: "platform" });
    expect(job).toMatchObject({
      sourceId: `${boards[0]?.slug}:JR-1`,
      location: "USA, CA, Pleasanton",
      remoteType: "unknown",
      description: null,
    });
  });

  it("dedupes postings found by more than one keyword", async () => {
    fakeWorkday(() => new Response("{}"));
    const jobs = await createWorkdaySource().search({
      role: ["platform", "staff"],
    });
    expect(jobs).toHaveLength(boards.length);
  });
});

describe("fetchWorkdayJob", () => {
  const board = {
    company: "Workday",
    ats: "workday" as const,
    slug: "workday",
    host: "wd5",
    site: "Workday",
  };
  const path = "/job/USA-CA-Pleasanton/Staff-Platform-Engineer_JR-1";

  it("reads one posting from the detail endpoint", async () => {
    const calls = fakeWorkday(
      () =>
        new Response(
          JSON.stringify({
            jobPostingInfo: {
              title: "Staff Platform Engineer",
              jobReqId: "JR-1",
              location: "Pleasanton, CA",
              remoteType: "Hybrid",
              jobDescription: "<p>Build the <b>platform</b>.</p>",
            },
          }),
        ),
    );
    const job = await fetchWorkdayJob(board, path);
    expect(calls.map((c) => c.url)).toEqual([
      `https://workday.wd5.myworkdayjobs.com/wday/cxs/workday/Workday${path}`,
    ]);
    expect(job).toMatchObject({
      source: "workday",
      sourceId: "workday:JR-1",
      title: "Staff Platform Engineer",
      company: "Workday",
      location: "Pleasanton, CA",
      remoteType: "hybrid",
      url: `https://workday.wd5.myworkdayjobs.com/Workday${path}`,
    });
  });

  it("rejects when the detail request fails", async () => {
    fakeWorkday(() => new Response("nope", { status: 500 }));
    await expect(fetchWorkdayJob(board, path)).rejects.toThrow("HTTP 500");
  });
});

describe("workdayRemoteType", () => {
  it("maps Workday's free-text values", () => {
    expect(workdayRemoteType("Fully Remote")).toBe("remote");
    expect(workdayRemoteType("Hybrid")).toBe("hybrid");
    expect(workdayRemoteType("Flexible")).toBe("hybrid");
    expect(workdayRemoteType("On-site")).toBe("onsite");
    expect(workdayRemoteType(undefined)).toBe("unknown");
  });
});
