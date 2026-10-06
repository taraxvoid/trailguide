import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runSearch, type SearchOptions } from "../src/cli.ts";
import { ConfigError } from "../src/config.ts";
import {
  allJobs,
  finishRun,
  getRun,
  openDb,
  SEARCH_RUN_KEY,
  startRun,
} from "../src/db.ts";
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

function fake(
  jobs: NormalizedJob[],
  scoped = false,
  name: NormalizedJob["source"] = "greenhouse",
) {
  const calls: SearchParams[] = [];
  const source: Source = {
    name,
    scoped,
    async search(params) {
      // The runner adds `warn`; tests only care about the query.
      const { warn: _warn, ...query } = params;
      calls.push(query);
      return jobs;
    },
  };
  return { source, calls };
}

function broken(name: NormalizedJob["source"], message: string): Source {
  return {
    name,
    scoped: name === "jsearch" || name === "adzuna",
    async search() {
      throw new Error(message);
    },
  };
}

const flags = (over: Partial<SearchOptions> = {}): SearchOptions => ({
  json: false,
  csv: false,
  clearance: false,
  ...over,
});

let root: string;
let cwd: string;
let env: Record<string, string>;
let spies: { mockRestore(): void }[];

const dbPath = () => join(root, "data", "igor", "igor.db");
const deps = (sources: Source[]) => ({
  sources,
  isUrlDead: async () => false,
  cwd,
  env,
});
const writeGlobal = (text: string) => {
  const path = join(root, "cfg", "igor", "config.toml");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const searchRun = () => {
  const db = openDb(dbPath());
  const run = getRun(db, "search", SEARCH_RUN_KEY);
  db.close();
  return run;
};

const OMAHA_AND_US =
  '[[location]]\ncity = "Omaha"\nflexibility = "in-person"\n[[location]]\ncity = "United States"\nflexibility = "remote"\n[[keywords]]\nrole = "swe"\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "igor-runsearch-"));
  cwd = join(root, "proj");
  mkdirSync(cwd);
  env = {
    XDG_CONFIG_HOME: join(root, "cfg"),
    XDG_DATA_HOME: join(root, "data"),
  };
  spies = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  process.exitCode = 0;
  rmSync(root, { recursive: true, force: true });
});

describe("runSearch from the config", () => {
  it("filters per location, stores jobs, returns and records the summary", async () => {
    writeGlobal(OMAHA_AND_US);
    const source = fake([
      job({
        sourceId: "o",
        location: "Omaha, NE",
        remoteType: "onsite",
        url: "https://e.com/o",
      }),
      job({
        sourceId: "r",
        title: "Remote SWE",
        location: "Remote - USA",
        remoteType: "remote",
        url: "https://e.com/r",
      }),
      job({
        sourceId: "a",
        title: "Austin SWE",
        location: "Austin, TX",
        remoteType: "onsite",
        url: "https://e.com/a",
      }),
    ]);
    const result = await runSearch(flags(), deps([source.source]));
    expect(result).toEqual({ found: 2, new: 2, failures: [] });
    expect(source.calls).toEqual([{ role: ["swe"] }]);
    const db = openDb(dbPath());
    expect(allJobs(db)).toHaveLength(2);
    db.close();
    expect(searchRun()).toMatchObject({ ok: true, message: "2 found, 2 new" });
  });

  it("passes flag overrides through to scoped sources", async () => {
    writeGlobal(OMAHA_AND_US);
    const scoped = fake([], true, "jsearch");
    await runSearch(
      flags({ location: ["Reno"], remote: true }),
      deps([scoped.source]),
    );
    expect(scoped.calls).toEqual([
      { role: "swe", location: "Reno", remote: true },
    ]);
  });

  it("appends failed sources to the message but stays ok", async () => {
    writeGlobal(OMAHA_AND_US);
    const result = await runSearch(
      flags(),
      deps([broken("jsearch", "429"), fake([job({})]).source]),
    );
    expect(result?.failures).toEqual([{ source: "jsearch", message: "429" }]);
    expect(searchRun()).toMatchObject({
      ok: true,
      message: "1 found, 1 new; failed: jsearch: 429",
    });
  });

  it("fails the run when every source fails", async () => {
    writeGlobal(OMAHA_AND_US);
    await runSearch(
      flags(),
      deps([broken("jsearch", "429"), broken("remoteok", "500")]),
    );
    expect(searchRun()?.ok).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});

describe("runSearch config errors", () => {
  it("records a bad config on the run when --db is given (the TUI child)", async () => {
    const file = writeGlobal('[[keyword]]\nrole = "swe"\n');
    await expect(
      runSearch(flags({ db: dbPath() }), deps([fake([]).source])),
    ).rejects.toThrow(ConfigError);
    const run = searchRun();
    expect(run?.ok).toBe(false);
    expect(run?.message).toContain(file);
  });

  it("refuses keywords without a location and never calls a source", async () => {
    writeGlobal('[[keywords]]\nrole = "swe"\n');
    const source = fake([job({})]);
    await expect(runSearch(flags(), deps([source.source]))).rejects.toThrow(
      /\[\[location\]\]/,
    );
    expect(source.calls).toHaveLength(0);
    expect(searchRun()?.ok).toBe(false);
  });

  it("fails fast on a missing --config before any network work", async () => {
    const source = fake([job({})]);
    let deadChecks = 0;
    await expect(
      runSearch(flags({ config: join(root, "nope.toml") }), {
        ...deps([source.source]),
        isUrlDead: async () => {
          deadChecks++;
          return false;
        },
      }),
    ).rejects.toThrow(/config file not found/);
    expect(source.calls).toHaveLength(0);
    expect(deadChecks).toBe(0);
  });

  it("fails fast on a malformed config (with --db) and records it before any source runs", async () => {
    writeGlobal("[[location]\n");
    const source = fake([job({})]);
    await expect(
      runSearch(flags({ db: dbPath() }), deps([source.source])),
    ).rejects.toThrow(ConfigError);
    expect(source.calls).toHaveLength(0);
    expect(searchRun()?.ok).toBe(false);
  });

  it("rejects --remote with --onsite before claiming, leaving the previous run untouched", async () => {
    const db = openDb(dbPath());
    startRun(db, "search", SEARCH_RUN_KEY, process.pid);
    finishRun(db, "search", SEARCH_RUN_KEY, true, "3 found, 1 new");
    const before = getRun(db, "search", SEARCH_RUN_KEY);
    db.close();
    const source = fake([job({})]);
    await expect(
      runSearch(
        flags({ role: ["swe"], remote: true, onsite: true }),
        deps([source.source]),
      ),
    ).rejects.toThrow("--remote and --onsite are mutually exclusive");
    expect(source.calls).toHaveLength(0);
    expect(searchRun()).toEqual(before);
  });

  it("hints at igor init when there is no config and no --role", async () => {
    await expect(runSearch(flags(), deps([]))).rejects.toThrow(/igor init/);
    expect(searchRun()?.message).toMatch(/igor init/);
  });
});

describe("runSearch run registration", () => {
  it("a flag-only run claims and finishes the search run", async () => {
    await runSearch(
      flags({ role: ["swe"], location: ["Omaha"] }),
      deps([fake([job({})]).source]),
    );
    expect(searchRun()).toMatchObject({ ok: true, message: "1 found, 1 new" });
  });

  it("is refused while another live process holds the search run", async () => {
    const db = openDb(dbPath());
    startRun(db, "search", SEARCH_RUN_KEY, 1); // pid 1 is always alive
    db.close();
    const source = fake([job({})]);
    const result = await runSearch(
      flags({ role: ["swe"] }),
      deps([source.source]),
    );
    expect(result).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(source.calls).toHaveLength(0);
    expect(searchRun()?.pid).toBe(1);
  });
});
