import { afterEach, describe, expect, it, mock } from "bun:test";
import { createAdzunaSource } from "../src/sources/adzuna.ts";
import { createAshbySource } from "../src/sources/ashby.ts";
import { createGreenhouseSource } from "../src/sources/greenhouse.ts";
import { createJSearchSource } from "../src/sources/jsearch.ts";
import { createLeverSource } from "../src/sources/lever.ts";
import { companiesForAts } from "../src/sources/seed.ts";
import adzunaFixture from "./fixtures/adzuna-search.json";
import ashbyFixture from "./fixtures/ashby-ramp.json";
import greenhouseFixture from "./fixtures/greenhouse-figma.json";
import jsearchFixture from "./fixtures/jsearch-search.json";
import leverFixture from "./fixtures/lever-netflix.json";

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

    const source = createAshbySource();
    const jobs = await source.search({ role: "engineer" });

    expect(jobs).toHaveLength(companiesForAts("ashby").length);
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
