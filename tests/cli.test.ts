import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSources,
  createProgram,
  isInternship,
  requiresClearance,
  resolveTrailChoice,
  runAdd,
  type SearchOptions,
} from "../src/cli.ts";
import { ConfigError, configuredTrails } from "../src/config.ts";
import { ImportError, type importJob } from "../src/importUrl.ts";
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

  it("flags defense contractors by employer", () => {
    expect(requiresClearance(job({ company: "Booz Allen Hamilton" }))).toBe(
      true,
    );
    expect(requiresClearance(job({ company: "Northrop Grumman" }))).toBe(true);
  });

  it("flags clearance terms and acronyms", () => {
    for (const description of [
      "Active TS/SCI required",
      "Must be able to obtain a clearance",
      "Full-scope polygraph",
    ]) {
      expect(requiresClearance(job({ description }))).toBe(true);
    }
  });

  it("ignores EEO boilerplate and look-alike words", () => {
    for (const description of [
      "We do not discriminate on the basis of veteran or military status.",
      "Join our Data Science team as an IC.",
      "Clearance of tech debt is part of the job.",
      "Our customers include Fortune 500 companies.",
    ]) {
      expect(requiresClearance(job({ description }))).toBe(false);
    }
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
    delete process.env.JSEARCH_API_KEY;
    delete process.env.ADZUNA_APP_ID;
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
        "workday",
        "workable",
      ]),
    );
  });

  it("gives each board source only its own boards", async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response("[]");
    }) as unknown as typeof fetch;
    try {
      const sources = buildSources([
        { company: "Mine", ats: "lever", slug: "mine" },
      ]);
      for (const name of ["lever", "greenhouse"]) {
        await sources.find((s) => s.name === name)?.search({ role: "x" });
      }
    } finally {
      globalThis.fetch = original;
    }
    expect(urls).toEqual(["https://api.lever.co/v0/postings/mine?mode=json"]);
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
    await program.parseAsync(["node", "trailguide", "clear"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.db).toBeUndefined();
  });

  it("parses clear with --db", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync([
      "node",
      "trailguide",
      "clear",
      "--db",
      "test.db",
    ]);

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
    await program.parseAsync(["node", "trailguide", "search"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.role).toBeUndefined();
  });

  it("accepts --remote as a boolean flag", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync([
      "node",
      "trailguide",
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
      "trailguide",
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
    await program.parseAsync([
      "node",
      "trailguide",
      "search",
      "--role",
      "engineer",
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      role: ["engineer"],
      json: false,
      csv: false,
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
      "trailguide",
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
      "trailguide",
      "search",
      "--role",
      "engineer",
      "--location",
      "Seattle",
      "--remote",
      "--onsite",
      "--json",
      "--exclude-clearance",
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
      excludeClearance: true,
      db: "custom.db",
    });
  });

  it("collects multiple --location and --role values", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync([
      "node",
      "trailguide",
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

  it("registers trailguide config and --config on search and tui", () => {
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

describe("configuredTrails", () => {
  it("lists each keyword trail once, in config order", () => {
    expect(
      configuredTrails({
        keywords: [
          { role: "a", trail: "secplat" },
          { role: "b" },
          { role: "c", trail: "platform" },
          { role: "d", trail: "secplat" },
        ],
      }),
    ).toEqual(["secplat", "platform"]);
    expect(configuredTrails({})).toEqual([]);
  });
});

describe("resolveTrailChoice", () => {
  const trails = ["secplat", "platform"];

  it("accepts a configured trail, or none for no trail", async () => {
    expect(await resolveTrailChoice("platform", trails)).toBe("platform");
    expect(await resolveTrailChoice("none", trails)).toBeNull();
    expect(await resolveTrailChoice("none", [])).toBeNull();
  });

  it("rejects an unknown trail and lists the valid ones", async () => {
    await expect(resolveTrailChoice("nope", ["secplat"])).rejects.toThrow(
      new ConfigError(
        `trail "nope" isn't configured; use one of: secplat, none`,
      ),
    );
  });

  it("requires --trail when it can't ask", async () => {
    await expect(resolveTrailChoice(undefined, trails)).rejects.toThrow(
      new ConfigError(
        "--trail is required when not running in a terminal; use one of: secplat, platform, none",
      ),
    );
    await expect(resolveTrailChoice(undefined, [])).rejects.toThrow(
      "use one of: none",
    );
  });

  it("asks with none as the last choice", async () => {
    let offered: string[] = [];
    const ask = async (choices: string[]) => {
      offered = choices;
      return "2";
    };
    expect(await resolveTrailChoice(undefined, trails, ask)).toBe("platform");
    expect(offered).toEqual(["secplat", "platform", "none"]);
  });

  it("says why it asks again after a bad answer", async () => {
    const answers = ["9", "secplat"];
    const hints: string[] = [];
    const ask = async (_choices: string[], hint?: string) => {
      if (hint) hints.push(hint);
      return answers.shift() ?? "";
    };
    expect(await resolveTrailChoice(undefined, trails, ask)).toBe("secplat");
    expect(hints).toEqual(["pick 1-3 or a trail name"]);
  });

  it("gives up on an empty answer (Enter or end of input)", async () => {
    await expect(
      resolveTrailChoice(undefined, trails, async () => ""),
    ).rejects.toThrow(new ConfigError("no trail chosen; nothing imported"));
  });
});

describe("add command", () => {
  const LINK = "https://job-boards.greenhouse.io/codeorg/jobs/4727981005";
  let dir = "";
  let logs: string[] = [];
  let errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trailguide-add-"));
    writeFileSync(
      join(dir, "config.toml"),
      '[[location]]\ncity = "Remote"\nflexibility = "remote"\n\n[[keywords]]\nrole = "Platform Engineer"\ntrail = "platform"\n',
    );
    logs = [];
    errors = [];
    console.log = (msg: string) => logs.push(msg);
    console.error = (msg: string) => errors.push(msg);
    process.exitCode = 0;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = 0;
  });

  const options = (trail?: string) => ({
    url: LINK,
    trail,
    db: join(dir, "t.db"),
    config: join(dir, "config.toml"),
  });

  function fakeImport(added: boolean, trail?: string) {
    const calls: unknown[][] = [];
    const fn = (async (...args: unknown[]) => {
      calls.push(args);
      return {
        added,
        job: {
          listingId: "greenhouse:4727981005",
          title: "Software Engineer, Teacher Experience",
          company: "CodeAI",
          location: "Remote or Seattle, WA",
          ...(trail ? { trail } : {}),
        },
      };
    }) as unknown as typeof importJob;
    return { fn, calls };
  }

  it("fails before importing when --trail is missing outside a terminal", async () => {
    const { fn, calls } = fakeImport(true);
    await runAdd(options(), { importJob: fn });
    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("use one of: platform, none");
  });

  it("reports an added job with its trail", async () => {
    const { fn, calls } = fakeImport(true, "platform");
    await runAdd(options("platform"), { importJob: fn });
    expect(calls[0]?.[1]).toBe(LINK);
    expect(calls[0]?.[2]).toBe("platform");
    expect(logs).toEqual([
      "Added greenhouse:4727981005: Software Engineer, Teacher Experience @ CodeAI (Remote or Seattle, WA), trail platform",
    ]);
  });

  it("reports a job it already tracks, and no trail", async () => {
    const { fn, calls } = fakeImport(false);
    await runAdd(options("none"), { importJob: fn });
    expect(calls[0]?.[2]).toBeNull();
    expect(logs).toEqual([
      "Already tracked greenhouse:4727981005: Software Engineer, Teacher Experience @ CodeAI (Remote or Seattle, WA), no trail",
    ]);
  });

  it("prints an import error and exits 1", async () => {
    const fn = (async () => {
      throw new ImportError("could not fetch x: HTTP 404");
    }) as unknown as typeof importJob;
    await runAdd(options("platform"), { importJob: fn });
    expect(errors).toEqual(["error: could not fetch x: HTTP 404"]);
    expect(process.exitCode).toBe(1);
  });

  it("is registered with --trail, --db and --config", () => {
    const cmd = createProgram().commands.find((c) => c.name() === "add");
    expect(cmd?.registeredArguments.map((a) => a.name())).toEqual(["url"]);
    expect(cmd?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(["--trail", "--db", "--config"]),
    );
  });
});
