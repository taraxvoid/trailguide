import { afterEach, describe, expect, it, mock } from "bun:test";
import { createAdzunaSource } from "../src/sources/adzuna.ts";
import { createAshbySource } from "../src/sources/ashby.ts";
import type { Board } from "../src/sources/boards.ts";
import { createGreenhouseSource } from "../src/sources/greenhouse.ts";
import { createJobApsSource } from "../src/sources/jobaps.ts";
import { createJSearchSource } from "../src/sources/jsearch.ts";
import { createLeverSource } from "../src/sources/lever.ts";
import { createRemoteOkSource } from "../src/sources/remoteok.ts";
import { createRemotiveSource } from "../src/sources/remotive.ts";
import { companiesForAts } from "../src/sources/seed.ts";
import { createWeWorkRemotelySource } from "../src/sources/weworkremotely.ts";
import adzunaFixture from "./fixtures/adzuna-search.json";
import ashbyFixture from "./fixtures/ashby-ramp.json";
import greenhouseFixture from "./fixtures/greenhouse-figma.json";
import jobApsFixture from "./fixtures/jobaps-alameda.rss" with { type: "text" };
import jsearchFixture from "./fixtures/jsearch-search.json";
import leverFixture from "./fixtures/lever-netflix.json";
import remoteokFixture from "./fixtures/remoteok-search.json";
import remotiveFixture from "./fixtures/remotive-search.json";
import weworkremotelyFixture from "./fixtures/weworkremotely-programming.rss" with {
  type: "text",
};

// No ashby board ships by default; the fixture stands in for these two.
const ASHBY_BOARDS: Board[] = [
  { company: "One", ats: "ashby", slug: "one" },
  { company: "Two", ats: "ashby", slug: "two" },
];

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("greenhouse source", () => {
  it("normalizes jobs and filters by role", async () => {
    // The fixture stands in for every seeded greenhouse company, so one
    // matching job per company is expected back.
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(greenhouseFixture)),
    ) as unknown as typeof fetch;

    const source = createGreenhouseSource();
    const jobs = await source.search({ role: "engineer" });

    expect(jobs).toHaveLength(companiesForAts("greenhouse").length);
    expect(jobs[0]?.title).toBe("Senior Software Engineer, Backend");
    expect(jobs[0]?.source).toBe("greenhouse");
    expect(jobs[0]?.remoteType).toBe("remote");
  });

  it("matches any of multiple roles", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(greenhouseFixture)),
    ) as unknown as typeof fetch;

    const source = createGreenhouseSource();
    const jobs = await source.search({ role: ["engineer", "designer"] });

    expect(jobs).toHaveLength(companiesForAts("greenhouse").length * 2);
    expect(jobs.map((j) => j.title)).toContain("Product Designer");
  });

  it("strips HTML markup from the job description", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(greenhouseFixture)),
    ) as unknown as typeof fetch;

    const source = createGreenhouseSource();
    const jobs = await source.search({ role: "engineer" });

    expect(jobs[0]?.description).toBe(
      "Build backend systems at Figma.\nOwn services end to end",
    );
  });
});

describe("lever source", () => {
  it("normalizes jobs and filters by role", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(leverFixture)),
    ) as unknown as typeof fetch;

    const source = createLeverSource();
    const jobs = await source.search({ role: "engineer" });

    expect(jobs).toHaveLength(companiesForAts("lever").length);
    expect(jobs[0]?.title).toBe("Senior Software Engineer, Streaming");
    expect(jobs[0]?.source).toBe("lever");
    expect(jobs[0]?.remoteType).toBe("remote");
  });
});

describe("ashby source", () => {
  it("normalizes jobs and filters by role", async () => {
    // The fixture stands in for every seeded ashby company, so one
    // matching job per company is expected back.
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(ashbyFixture)),
    ) as unknown as typeof fetch;

    const source = createAshbySource(ASHBY_BOARDS);
    const jobs = await source.search({ role: "engineer" });

    expect(jobs).toHaveLength(ASHBY_BOARDS.length);
    expect(jobs[0]?.title).toBe("Senior Software Engineer, Infrastructure");
    expect(jobs[0]?.source).toBe("ashby");
    expect(jobs[0]?.remoteType).toBe("remote");
  });
});

describe("jsearch source", () => {
  it("normalizes jobs, joining location parts and marking remote status", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(jsearchFixture)),
    ) as unknown as typeof fetch;

    const source = createJSearchSource("test-api-key");
    const jobs = await source.search({ role: "engineer" });

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      sourceId: "jsearch-1",
      source: "jsearch",
      title: "Senior Software Engineer, Platform",
      company: "Stripe",
      location: "San Francisco, CA, US",
      remoteType: "remote",
      url: "https://stripe.com/jobs/platform-1",
    });
  });

  it("falls back to 'unknown' location and non-remote when fields are missing", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(jsearchFixture)),
    ) as unknown as typeof fetch;

    const source = createJSearchSource("test-api-key");
    const jobs = await source.search({ role: "engineer" });

    expect(jobs[1]).toMatchObject({
      sourceId: "jsearch-2",
      location: "unknown",
      remoteType: "unknown",
      postedAt: null,
      description: null,
    });
  });

  it("sends the API key and host headers, and includes role/location/remote in the query", async () => {
    let requestedUrl: string | undefined;
    let requestedHeaders: Record<string, string> | undefined;
    globalThis.fetch = mock(
      async (input: unknown, init?: { headers?: Record<string, string> }) => {
        requestedUrl = String(input);
        requestedHeaders = init?.headers;
        return new Response(JSON.stringify({ data: { jobs: [] } }));
      },
    ) as unknown as typeof fetch;

    const source = createJSearchSource("secret-key");
    await source.search({ role: "engineer", location: "Omaha", remote: true });

    expect(requestedUrl).toContain("query=engineer+in+Omaha");
    expect(requestedUrl).toContain("remote_jobs_only=true");
    expect(requestedHeaders).toMatchObject({ "X-RapidAPI-Key": "secret-key" });
  });

  it("throws when the request fails", async () => {
    globalThis.fetch = mock(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;

    const source = createJSearchSource("test-api-key");
    await expect(source.search({ role: "engineer" })).rejects.toThrow(
      "JSearch request failed: 500",
    );
  });

  it("issues one request per role/location combination and merges results", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify(jsearchFixture));
    }) as unknown as typeof fetch;

    const source = createJSearchSource("test-api-key");
    const jobs = await source.search({
      role: ["engineer", "manager"],
      location: ["Omaha", "San Francisco"],
    });

    expect(requestedUrls).toHaveLength(4);
    expect(
      requestedUrls.some((url) => url.includes("query=engineer+in+Omaha")),
    ).toBe(true);
    expect(
      requestedUrls.some((url) =>
        url.includes("query=manager+in+San+Francisco"),
      ),
    ).toBe(true);
    expect(jobs).toHaveLength(2 * 4);
  });
});

describe("adzuna source", () => {
  it("normalizes jobs", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(adzunaFixture)),
    ) as unknown as typeof fetch;

    const source = createAdzunaSource("app-id", "app-key");
    const jobs = await source.search({ role: "engineer", location: "Omaha" });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      sourceId: "adzuna-1",
      source: "adzuna",
      title: "Backend Engineer",
      company: "Acme Corp",
      location: "Omaha, NE",
      remoteType: "unknown",
      url: "https://adzuna.com/land/ad/adzuna-1?utm_source=api",
    });
  });

  it("includes app credentials, country, and search params in the request URL", async () => {
    let requestedUrl: string | undefined;
    globalThis.fetch = mock(async (input: unknown) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ results: [] }));
    }) as unknown as typeof fetch;

    const source = createAdzunaSource("app-id", "app-key", "gb");
    await source.search({ role: "engineer", location: "London" });

    expect(requestedUrl).toContain("/v1/api/jobs/gb/search/1");
    expect(requestedUrl).toContain("app_id=app-id");
    expect(requestedUrl).toContain("app_key=app-key");
    expect(requestedUrl).toContain("what=engineer");
    expect(requestedUrl).toContain("where=London");
  });

  it("throws when the request fails", async () => {
    globalThis.fetch = mock(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof fetch;

    const source = createAdzunaSource("app-id", "app-key");
    await expect(source.search({ role: "engineer" })).rejects.toThrow(
      "Adzuna request failed: 503",
    );
  });

  it("issues one request per role/location combination and merges results", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify(adzunaFixture));
    }) as unknown as typeof fetch;

    const source = createAdzunaSource("app-id", "app-key");
    const jobs = await source.search({
      role: ["engineer", "manager"],
      location: ["Omaha", "London"],
    });

    expect(requestedUrls).toHaveLength(4);
    expect(
      requestedUrls.some(
        (url) => url.includes("what=engineer") && url.includes("where=Omaha"),
      ),
    ).toBe(true);
    expect(
      requestedUrls.some(
        (url) => url.includes("what=manager") && url.includes("where=London"),
      ),
    ).toBe(true);
    expect(jobs).toHaveLength(1 * 4);
  });
});

describe("jobaps source", () => {
  it("normalizes jobs and filters by role", async () => {
    globalThis.fetch = mock(
      async () => new Response(jobApsFixture),
    ) as unknown as typeof fetch;

    const source = createJobApsSource();
    const jobs = await source.search({ role: "recreation" });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      sourceId:
        "https://www.jobapscloud.com/Alameda/sup/BulPreview.asp?R1=26&R2=0512&R3=01",
      source: "jobaps",
      title: "Recreation Program Assistant - #26-0512-01",
      company: "Alameda County",
      location: "San Leandro, CA",
      remoteType: "onsite",
      url: "https://www.jobapscloud.com/Alameda/sup/BulPreview.asp?R1=26&R2=0512&R3=01",
    });
    expect(jobs[0]?.description).toContain("Salary: $24.00 - $29.00/hour.");
  });

  it("prefers the posting's own work-location city over the agency default", async () => {
    globalThis.fetch = mock(
      async () => new Response(jobApsFixture),
    ) as unknown as typeof fetch;

    const source = createJobApsSource();
    const jobs = await source.search({
      role: "supervisor",
      location: "Oakland",
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.title).toBe("Contract Compliance Supervisor - #26-0451-02");
  });

  it("filters out postings whose work location doesn't match", async () => {
    globalThis.fetch = mock(
      async () => new Response(jobApsFixture),
    ) as unknown as typeof fetch;

    const source = createJobApsSource();
    const jobs = await source.search({
      role: "supervisor",
      location: "San Leandro",
    });

    expect(jobs).toHaveLength(0);
  });

  it("returns no jobs when the request fails", async () => {
    globalThis.fetch = mock(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;

    const source = createJobApsSource();
    const jobs = await source.search({ role: "engineer" });

    expect(jobs).toHaveLength(0);
  });
});

describe("remoteok source", () => {
  it("skips the legal notice entry and normalizes jobs", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(remoteokFixture)),
    ) as unknown as typeof fetch;

    const source = createRemoteOkSource();
    const jobs = await source.search({ role: "engineer" });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      sourceId: "remoteok-1",
      source: "remoteok",
      title: "Senior Backend Engineer",
      company: "Acme Remote Co",
      location: "Worldwide",
      remoteType: "remote",
      url: "https://remoteok.com/remote-jobs/remoteok-1",
    });
    expect(jobs[0]?.description).toBe(
      "Build backend systems.\nFully distributed team.",
    );
  });

  it("matches role against tags as well as the title", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(remoteokFixture)),
    ) as unknown as typeof fetch;

    const source = createRemoteOkSource();
    const jobs = await source.search({ role: "golang" });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.title).toBe("Senior Backend Engineer");
  });

  it("throws when the request fails", async () => {
    globalThis.fetch = mock(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;

    const source = createRemoteOkSource();
    await expect(source.search({ role: "engineer" })).rejects.toThrow(
      "RemoteOK request failed: 500",
    );
  });
});

describe("remotive source", () => {
  it("normalizes jobs and includes the role in the query", async () => {
    let requestedUrl: string | undefined;
    globalThis.fetch = mock(async (input: unknown) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify(remotiveFixture));
    }) as unknown as typeof fetch;

    const source = createRemotiveSource();
    const jobs = await source.search({ role: "engineer" });

    expect(requestedUrl).toContain("search=engineer");
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      sourceId: "4242",
      source: "remotive",
      title: "Backend Engineer",
      company: "Remotive Corp",
      location: "USA Only",
      remoteType: "remote",
      url: "https://remotive.com/remote-jobs/software-dev/backend-engineer-4242",
    });
    expect(jobs[0]?.description).toBe(
      "Build backend systems at Remotive Corp.",
    );
  });

  it("searches every role and dedupes the merged jobs", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify(remotiveFixture));
    }) as unknown as typeof fetch;

    const jobs = await createRemotiveSource().search({
      role: ["engineer", "developer"],
    });

    expect(urls.some((u) => u.includes("search=engineer"))).toBe(true);
    expect(urls.some((u) => u.includes("search=developer"))).toBe(true);
    expect(jobs).toHaveLength(2);
  });

  it("filters by location", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(remotiveFixture)),
    ) as unknown as typeof fetch;

    const source = createRemotiveSource();
    const jobs = await source.search({
      role: "engineer",
      location: "worldwide",
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.company).toBe("Worldwide Corp");
  });

  it("throws when the request fails", async () => {
    globalThis.fetch = mock(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;

    const source = createRemotiveSource();
    await expect(source.search({ role: "engineer" })).rejects.toThrow(
      "Remotive request failed: 500",
    );
  });
});

describe("weworkremotely source", () => {
  it("parses RSS items, splitting company from title", async () => {
    globalThis.fetch = mock(
      async () => new Response(weworkremotelyFixture),
    ) as unknown as typeof fetch;

    const source = createWeWorkRemotelySource();
    const jobs = await source.search({ role: "engineer" });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      sourceId:
        "https://weworkremotely.com/remote-jobs/acme-co-backend-engineer",
      source: "weworkremotely",
      title: "Backend Engineer",
      company: "Acme Co",
      location: "Anywhere in the World",
      remoteType: "remote",
      url: "https://weworkremotely.com/remote-jobs/acme-co-backend-engineer",
    });
    expect(jobs[0]?.description).toBe(
      "Build backend systems.\nOwn services end to end.",
    );
  });

  it("filters by location", async () => {
    globalThis.fetch = mock(
      async () => new Response(weworkremotelyFixture),
    ) as unknown as typeof fetch;

    const source = createWeWorkRemotelySource();
    const jobs = await source.search({ role: "designer", location: "usa" });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.company).toBe("Widgets Inc");
  });

  it("throws when the request fails", async () => {
    globalThis.fetch = mock(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;

    const source = createWeWorkRemotelySource();
    await expect(source.search({ role: "engineer" })).rejects.toThrow(
      "We Work Remotely request failed: 500",
    );
  });
});

describe("source scoping", () => {
  it("skips only adzuna for remote-only targets", () => {
    expect(createAdzunaSource("id", "key").labelsRemote).toBe(false);
    expect(createJSearchSource("key").labelsRemote).not.toBe(false);
  });

  it("marks only the location-aware APIs as scoped", () => {
    const all = [
      createGreenhouseSource(),
      createLeverSource(),
      createAshbySource(ASHBY_BOARDS),
      createRemoteOkSource(),
      createRemotiveSource(),
      createWeWorkRemotelySource(),
      createJobApsSource(),
      createJSearchSource("key"),
      createAdzunaSource("id", "key"),
    ];
    expect(
      all
        .filter((s) => s.scoped)
        .map((s) => s.name)
        .sort(),
    ).toEqual(["adzuna", "jsearch"]);
  });

  it("reports ashby secondary locations for matching", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(ashbyFixture)),
    ) as unknown as typeof fetch;
    const jobs = await createAshbySource(ASHBY_BOARDS).search({
      role: "engineer",
    });
    expect(jobs[0]?.location).toBe("New York, NY (HQ)");
    expect(jobs[0]?.otherLocations).toEqual(["Remote (US)"]);
  });
});
