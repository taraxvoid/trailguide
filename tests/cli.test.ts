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
    expect(new Set(names)).toEqual(
      new Set([
        "greenhouse",
        "lever",
        "ashby",
        "remoteok",
        "remotive",
        "jobaps",
        "weworkremotely",
      ]),
    );
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

describe("clear command parsing", () => {
  function programWithSpy() {
    const calls: { db?: string }[] = [];
    const program = createProgram(
      async () => {},
      async (options) => {
        calls.push(options);
      },
    );
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    for (const cmd of program.commands) {
      cmd.exitOverride();
      cmd.configureOutput({ writeErr: () => {} });
    }
    return { program, calls };
  }

  it("parses clear with defaults", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync(["node", "igor", "clear"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.db).toBeUndefined();
  });

  it("parses clear with --db", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync(["node", "igor", "clear", "--db", "test.db"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ db: "test.db" });
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

  it("does not require --role (the config supplies keywords)", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync(["node", "igor", "search"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.role).toBeUndefined();
  });

  it("accepts --remote as a boolean flag", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync([
      "node",
      "igor",
      "search",
      "--role",
      "engineer",
      "--remote",
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.remote).toBe(true);
  });

  it("accepts --onsite as a boolean flag", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync([
      "node",
      "igor",
      "search",
      "--role",
      "engineer",
      "--onsite",
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.onsite).toBe(true);
  });

  it("applies defaults when only --role is given", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync(["node", "igor", "search", "--role", "engineer"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      role: ["engineer"],
      json: false,
      csv: false,
      clearance: false,
    });
    expect(calls[0]?.db).toBeUndefined();
    expect(calls[0]?.remote).toBe(false);
    expect(calls[0]?.onsite).toBe(false);
    expect(calls[0]?.location).toBeUndefined();
  });

  it("accepts --config", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync([
      "node",
      "igor",
      "search",
      "--role",
      "engineer",
      "--config",
      "x.toml",
    ]);
    expect(calls[0]?.config).toBe("x.toml");
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
      "--onsite",
      "--json",
      "--clearance",
      "--db",
      "custom.db",
    ]);

    expect(calls[0]).toMatchObject({
      role: ["engineer"],
      location: ["Seattle"],
      remote: true,
      onsite: true,
      json: true,
      csv: false,
      clearance: true,
      db: "custom.db",
    });
  });

  it("collects multiple --location and --role values", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync([
      "node",
      "igor",
      "search",
      "--role",
      "engineer",
      "manager",
      "--location",
      "Omaha",
      "San Francisco",
    ]);

    expect(calls[0]).toMatchObject({
      role: ["engineer", "manager"],
      location: ["Omaha", "San Francisco"],
    });
  });
});

describe("db and config options", () => {
  it("no command defaults --db, so the shared resolver decides", () => {
    for (const cmd of createProgram().commands) {
      const db = cmd.options.find((o) => o.long === "--db");
      if (db) expect(db.defaultValue).toBeUndefined();
    }
  });

  it("registers igor config and --config on search and tui", () => {
    const program = createProgram();
    const longs = (name: string) =>
      program.commands
        .find((c) => c.name() === name)
        ?.options.map((o) => o.long) ?? [];
    expect(longs("config")).toContain("--config");
    expect(longs("search")).toContain("--config");
    expect(longs("tui")).toContain("--config");
  });
});
describe("init command", () => {
  it("is registered with repeatable prompt-skipping flags", () => {
    const cmd = createProgram().commands.find((c) => c.name() === "init");
    expect(cmd?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining([
        "--location",
        "--keywords",
        "--work",
        "--db",
        "--yes",
      ]),
    );
  });
});
