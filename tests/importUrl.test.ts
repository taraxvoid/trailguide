import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allJobs, openDb } from "../src/db.ts";
import {
  ImportError,
  importJob,
  parseJobUrl,
  resolveJobUrl,
} from "../src/importUrl.ts";
import type { Board } from "../src/sources/boards.ts";
import greenhouseJob from "./fixtures/greenhouse-codeorg-job.json";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const UUID = "4f16ada0-a2da-4509-9016-ed4879d2fe67";
const GREENHOUSE = {
  kind: "greenhouse",
  slug: "codeorg",
  id: "4727981005",
} as const;
const WORKDAY = {
  kind: "workday",
  slug: "cisco",
  host: "wd5",
  site: "Cisco_Careers",
  externalPath: "/job/San-Jose/Engineer_2001234",
} as const;

describe("parseJobUrl", () => {
  const cases: [string, unknown][] = [
    ["https://job-boards.greenhouse.io/codeorg/jobs/4727981005", GREENHOUSE],
    [
      "https://boards.greenhouse.io/codeorg/jobs/4727981005?gh_src=x#app",
      GREENHOUSE,
    ],
    [
      "https://boards.greenhouse.io/embed/job_app?for=codeorg&token=4727981005",
      GREENHOUSE,
    ],
    [
      `https://jobs.lever.co/netflix/${UUID}/apply`,
      { kind: "lever", slug: "netflix", id: UUID },
    ],
    [
      `https://jobs.ashbyhq.com/openai-foundation/${UUID}/application`,
      { kind: "ashby", slug: "openai-foundation", id: UUID },
    ],
    [
      "https://apply.workable.com/example/j/ABC123/",
      { kind: "workable", slug: "example", shortcode: "ABC123" },
    ],
    [
      "https://cisco.wd5.myworkdayjobs.com/en-US/Cisco_Careers/job/San-Jose/Engineer_2001234",
      WORKDAY,
    ],
    [
      "https://cisco.wd5.myworkdayjobs.com/Cisco_Careers/job/San-Jose/Engineer_2001234",
      WORKDAY,
    ],
    [
      "https://cisco.wd5.myworkdayjobs.com/Cisco_Careers/job/San-Jose/Engineer_2001234/apply",
      WORKDAY,
    ],
    [
      "https://cisco.wd5.myworkdayjobs.com/en-US/Cisco_Careers/job/San-Jose/Engineer_2001234/apply/applyManually",
      WORKDAY,
    ],
    [
      "https://openaifoundation.org/careers/x",
      { kind: "web", url: "https://openaifoundation.org/careers/x" },
    ],
  ];
  for (const [url, ref] of cases) {
    it(`parses ${url}`, () => {
      expect(parseJobUrl(url)).toEqual(ref as ReturnType<typeof parseJobUrl>);
    });
  }

  for (const url of [
    "https://jobs.ashbyhq.com/openai",
    "https://job-boards.greenhouse.io/codeorg",
    "https://apply.workable.com/example/",
  ]) {
    it(`asks for a single job instead of ${url}`, () => {
      expect(() => parseJobUrl(url)).toThrow(ImportError);
      expect(() => parseJobUrl(url)).toThrow(/single job/);
    });
  }

  for (const url of ["ftp://x", "not a url"]) {
    it(`rejects ${url}`, () => {
      expect(() => parseJobUrl(url)).toThrow(/not a web link/);
    });
  }
});

function serve(handler: (url: string) => Response) {
  const urls: string[] = [];
  globalThis.fetch = mock(async (input: string | URL) => {
    urls.push(String(input));
    return handler(String(input));
  }) as unknown as typeof fetch;
  return urls;
}

const BOARDS: Board[] = [
  { company: "CodeAI Board", ats: "greenhouse", slug: "codeorg" },
  {
    company: "Cisco",
    ats: "workday",
    slug: "cisco",
    host: "wd5",
    site: "Cisco_Careers",
  },
];

const jsonLd = `<html><script type="application/ld+json">${JSON.stringify({
  "@type": "JobPosting",
  title: "AI Deployment Engineer",
  hiringOrganization: { name: "OpenAI Foundation" },
})}</script></html>`;

describe("resolveJobUrl", () => {
  it("uses the board's company name for a known greenhouse board", async () => {
    const urls = serve(() => new Response(JSON.stringify(greenhouseJob)));
    const job = await resolveJobUrl(
      "https://job-boards.greenhouse.io/codeorg/jobs/4727981005",
      BOARDS,
    );
    expect(urls).toEqual([
      "https://boards-api.greenhouse.io/v1/boards/codeorg/jobs/4727981005",
    ]);
    expect(job.company).toBe("CodeAI Board");
  });

  it("takes the workday site from the link and the company from a matching board", async () => {
    const detail = JSON.stringify({
      jobPostingInfo: { title: "Engineer", jobReqId: "R1" },
    });
    const urls = serve(() => new Response(detail));
    const url =
      "https://cisco.wd5.myworkdayjobs.com/en-US/Cisco_Careers/job/San-Jose/Engineer_2001234";
    const job = await resolveJobUrl(url, BOARDS);
    expect(urls).toEqual([
      "https://cisco.wd5.myworkdayjobs.com/wday/cxs/cisco/Cisco_Careers/job/San-Jose/Engineer_2001234",
    ]);
    expect(job).toMatchObject({ company: "Cisco", sourceId: "cisco:R1" });
    expect((await resolveJobUrl(url, [])).company).toBe("cisco");
  });

  it("reads JSON-LD from any other page", async () => {
    serve(() => new Response(jsonLd));
    const job = await resolveJobUrl("https://openaifoundation.org/x", []);
    expect(job).toMatchObject({
      source: "web",
      title: "AI Deployment Engineer",
    });
  });

  it("explains what it can read when a page has no posting", async () => {
    serve(() => new Response("<html></html>"));
    const err = await resolveJobUrl("https://example.org/x", []).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ImportError);
    expect(String(err)).toContain("https://example.org/x");
    expect(String(err)).toContain(
      "Greenhouse, Lever, Ashby, Workable, Workday",
    );
  });

  it("wraps fetch failures and HTTP errors", async () => {
    serve(() => new Response("gone", { status: 404 }));
    const url = "https://job-boards.greenhouse.io/codeorg/jobs/1";
    await expect(resolveJobUrl(url, [])).rejects.toThrow(
      `could not fetch ${url}: HTTP 404`,
    );
    globalThis.fetch = mock(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await expect(resolveJobUrl("https://example.org/x", [])).rejects.toThrow(
      "could not fetch https://example.org/x: connection refused",
    );
  });
});

describe("importJob", () => {
  const dbPath = () =>
    join(mkdtempSync(join(tmpdir(), "trailguide-import-")), "t.db");

  it("adds, then reports an existing listing", async () => {
    serve(() => new Response(JSON.stringify(greenhouseJob)));
    const db = openDb(dbPath());
    const url = "https://job-boards.greenhouse.io/codeorg/jobs/4727981005";
    const first = await importJob(db, url, "platform", BOARDS);
    expect(first.added).toBe(true);
    expect(first.job).toMatchObject({
      listingId: "greenhouse:4727981005",
      trail: "platform",
    });
    expect((await importJob(db, url, null, BOARDS)).added).toBe(false);
  });

  it("tags the job with the regions its location matches", async () => {
    serve(() => new Response(JSON.stringify(greenhouseJob)));
    const db = openDb(dbPath());
    const url = "https://job-boards.greenhouse.io/codeorg/jobs/4727981005";
    const { job } = await importJob(db, url, null, BOARDS, [
      { name: "far", work: "in-person", places: ["Berlin"] },
      { name: "sea", work: "any", places: ["Seattle"] },
    ]);
    expect(job.regions).toEqual(["sea"]);
  });

  it("falls back to the given region when none match", async () => {
    serve(() => new Response(JSON.stringify(greenhouseJob)));
    const db = openDb(dbPath());
    const url = "https://job-boards.greenhouse.io/codeorg/jobs/4727981005";
    const regions = [
      { name: "far", work: "in-person" as const, places: ["Berlin"] },
    ];
    const { job } = await importJob(db, url, null, BOARDS, regions, "home");
    expect(job.regions).toEqual(["home"]);
  });

  it("asks which region when none match, and stores nothing if declined", async () => {
    serve(() => new Response(JSON.stringify(greenhouseJob)));
    const db = openDb(dbPath());
    const url = "https://job-boards.greenhouse.io/codeorg/jobs/4727981005";
    const regions = [
      { name: "far", work: "in-person" as const, places: ["Berlin"] },
    ];
    const { job } = await importJob(
      db,
      url,
      null,
      BOARDS,
      regions,
      undefined,
      async () => "far",
    );
    expect(job.regions).toEqual(["far"]);
    const none = await importJob(
      db,
      url,
      null,
      BOARDS,
      regions,
      undefined,
      async () => null,
    );
    expect(none.job.regions).toEqual(["far"]);
    const db2 = openDb(dbPath());
    await expect(
      importJob(db2, url, null, BOARDS, regions, undefined, async () => {
        throw new ImportError("no region chosen");
      }),
    ).rejects.toThrow("no region chosen");
    expect(allJobs(db2)).toEqual([]);
  });

  it("writes nothing when the link can't be read", async () => {
    serve(() => new Response("<html></html>"));
    const db = openDb(dbPath());
    await expect(
      importJob(db, "https://example.org/x", null, []),
    ).rejects.toThrow(ImportError);
    expect(allJobs(db)).toEqual([]);
  });
});
