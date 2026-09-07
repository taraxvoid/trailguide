import { afterEach, describe, expect, it, mock } from "bun:test";
import { createGreenhouseSource } from "../src/sources/greenhouse.ts";
import { createLeverSource } from "../src/sources/lever.ts";
import { companiesForAts } from "../src/sources/seed.ts";
import greenhouseFixture from "./fixtures/greenhouse-figma.json";
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
    );

    const source = createGreenhouseSource();
    const jobs = await source.search({ role: "engineer" });

    expect(jobs).toHaveLength(companiesForAts("greenhouse").length);
    expect(jobs[0]?.title).toBe("Senior Software Engineer, Backend");
    expect(jobs[0]?.source).toBe("greenhouse");
    expect(jobs[0]?.remoteType).toBe("remote");
  });
});

describe("lever source", () => {
  it("normalizes jobs and filters by role", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(leverFixture)),
    );

    const source = createLeverSource();
    const jobs = await source.search({ role: "engineer" });

    expect(jobs).toHaveLength(companiesForAts("lever").length);
    expect(jobs[0]?.title).toBe("Senior Software Engineer, Streaming");
    expect(jobs[0]?.source).toBe("lever");
    expect(jobs[0]?.remoteType).toBe("remote");
  });
});
