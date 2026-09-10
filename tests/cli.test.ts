import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type SearchOptions,
  buildSources,
  createProgram,
  isInternship,
  requiresClearance,
} from "../src/cli.ts";
import type { NormalizedJob } from "../src/sources/types.ts";

function job(overrides: Partial<NormalizedJob>): NormalizedJob {
  return {
    sourceId: "1",
    source: "jsearch",
    title: "Software Engineer",
    company: "Acme",
    location: "Remote",
    remoteType: "remote",
    url: "https://example.com",
    postedAt: null,
    description: null,
    ...overrides,
  };
}

describe("isInternship", () => {
  it("flags internship titles", () => {
    expect(isInternship(job({ title: "Software Engineering Intern" }))).toBe(
      true,
    );
    expect(isInternship(job({ title: "Summer Internship - Backend" }))).toBe(
      true,
    );
  });

  it("does not flag regular titles, including near-miss words", () => {
    expect(isInternship(job({ title: "Senior Backend Engineer" }))).toBe(false);
    expect(
      isInternship(job({ title: "International Payments Engineer" })),
    ).toBe(false);
  });
});

describe("requiresClearance", () => {
  it("flags titles or descriptions mentioning clearance requirements", () => {
    expect(
      requiresClearance(job({ title: "Engineer (Security Clearance Req'd)" })),
    ).toBe(true);
    expect(
      requiresClearance(
        job({ title: "Engineer", description: "Must support DoD contracts" }),
      ),
    ).toBe(true);
  });

  it("does not flag jobs with no clearance mention", () => {
    expect(
      requiresClearance(
        job({ title: "Engineer", description: "Build our API" }),
      ),
    ).toBe(false);
  });
});

describe("buildSources", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // biome-ignore lint/performance/noDelete: unset (not blank) env vars so buildSources sees them as absent
    delete process.env.JSEARCH_API_KEY;
    // biome-ignore lint/performance/noDelete: unset (not blank) env vars so buildSources sees them as absent
    delete process.env.ADZUNA_APP_ID;
    // biome-ignore lint/performance/noDelete: unset (not blank) env vars so buildSources sees them as absent
    delete process.env.ADZUNA_APP_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("job sources exist", () => {
    const names = buildSources().map((s) => s.name);
    expect(names).toEqual(["greenhouse", "lever", "ashby"]);
  });

  it("adds jsearch when JSEARCH_API_KEY is set", () => {
    process.env.JSEARCH_API_KEY = "test-key";
    const names = buildSources().map((s) => s.name);
    expect(names).toContain("jsearch");
  });

  it("adds adzuna only when both app id and key are set", () => {
    process.env.ADZUNA_APP_ID = "id";
    expect(buildSources().map((s) => s.name)).not.toContain("adzuna");

    process.env.ADZUNA_APP_KEY = "key";
    expect(buildSources().map((s) => s.name)).toContain("adzuna");
  });
});

describe("search command parsing", () => {
  function programWithSpy() {
    const calls: SearchOptions[] = [];
    const program = createProgram(async (options) => {
      calls.push(options);
    });
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    for (const cmd of program.commands) {
      cmd.exitOverride();
      cmd.configureOutput({ writeErr: () => {} });
    }
    return { program, calls };
  }

  it("requires --role", async () => {
    const { program } = programWithSpy();
    await expect(
      program.parseAsync(["node", "igor", "search"]),
    ).rejects.toThrow(/--role/);
  });

  it("rejects an invalid --remote value", async () => {
    const { program } = programWithSpy();
    await expect(
      program.parseAsync([
        "node",
        "igor",
        "search",
        "--role",
        "engineer",
        "--remote",
        "bogus",
      ]),
    ).rejects.toThrow(/Allowed choices/);
  });

  it("applies defaults when only --role is given", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync(["node", "igor", "search", "--role", "engineer"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      role: "engineer",
      json: false,
      csv: false,
      clearance: false,
      db: "igor.db",
    });
    expect(calls[0]?.remote).toBeUndefined();
    expect(calls[0]?.location).toBeUndefined();
  });

  it("parses all options when provided", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync([
      "node",
      "igor",
      "search",
      "--role",
      "engineer",
      "--location",
      "Seattle",
      "--remote",
      "hybrid",
      "--json",
      "--clearance",
      "--db",
      "custom.db",
    ]);

    expect(calls[0]).toMatchObject({
      role: "engineer",
      location: "Seattle",
      remote: "hybrid",
      json: true,
      csv: false,
      clearance: true,
      db: "custom.db",
    });
  });
});
