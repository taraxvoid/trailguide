import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEARCH_RUN_KEY, finishRun, getRun, openDb } from "../src/db.ts";
import {
  type SpawnRequest,
  describeSearchRun,
  searchLogPath,
  startBackgroundSearch,
} from "../src/tui/search.ts";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "igor-tui-"));
  const dbPath = join(dir, "igor.db");
  const db = openDb(dbPath);
  const requests: SpawnRequest[] = [];
  let killed = 0;
  // Returning our own pid keeps the recorded run live for the whole test.
  const spawn = (request: SpawnRequest) => {
    requests.push(request);
    return {
      pid: process.pid,
      unref() {},
      kill() {
        killed++;
      },
    };
  };
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, db, dbPath, requests, spawn, cleanup, killed: () => killed };
}

const argAfter = (cmd: string[], flag: string) =>
  cmd.includes(flag) ? cmd[cmd.indexOf(flag) + 1] : undefined;

describe("startBackgroundSearch", () => {
  it("spawns a detached igor search with absolute paths and records the run", () => {
    const h = harness();
    const result = startBackgroundSearch({
      db: h.db,
      dbPath: "igor.db",
      configPath: "my.toml",
      cwd: h.dir,
      spawn: h.spawn,
    });
    expect(result.started).toBe(true);
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0] as SpawnRequest;
    expect(request.cmd).toContain("search");
    expect(argAfter(request.cmd, "--db")).toBe(join(h.dir, "igor.db"));
    expect(argAfter(request.cmd, "--config")).toBe(join(h.dir, "my.toml"));
    expect(request.cwd).toBe(h.dir);
    expect(request.detached).toBe(true);
    expect(request.env.IGOR_NO_DELEGATE).toBe("1");
    expect(getRun(h.db, "search", SEARCH_RUN_KEY)).toMatchObject({
      pid: process.pid,
      finishedAt: null,
    });
    h.cleanup();
  });

  it("passes no --config when the TUI has none, so the child reads the same chain", () => {
    const h = harness();
    startBackgroundSearch({
      db: h.db,
      dbPath: h.dbPath,
      cwd: h.dir,
      spawn: h.spawn,
    });
    expect(h.requests[0]?.cmd).not.toContain("--config");
    h.cleanup();
  });

  it("sends output to a log next to the db, truncated per run", () => {
    const h = harness();
    const log = searchLogPath(h.dbPath);
    expect(log).toBe(join(h.dir, "igor-search.log"));
    writeFileSync(log, "output from an older run\n");
    startBackgroundSearch({
      db: h.db,
      dbPath: h.dbPath,
      cwd: h.dir,
      spawn: h.spawn,
    });
    expect(readFileSync(log, "utf8")).toBe("");
    const [stdin, stdout, stderr] = h.requests[0]?.stdio ?? [];
    expect(stdin).toBe("ignore");
    expect(typeof stdout).toBe("number");
    expect(stderr).toBe(stdout);
    h.cleanup();
  });

  it("refuses to start a second search while one is running", () => {
    const h = harness();
    startBackgroundSearch({
      db: h.db,
      dbPath: h.dbPath,
      cwd: h.dir,
      spawn: h.spawn,
    });
    expect(
      startBackgroundSearch({
        db: h.db,
        dbPath: h.dbPath,
        cwd: h.dir,
        spawn: h.spawn,
      }),
    ).toEqual({ started: false, message: "search already running" });
    expect(h.requests).toHaveLength(1);
    h.cleanup();
  });

  it("allows a new search once the previous one finished", () => {
    const h = harness();
    startBackgroundSearch({
      db: h.db,
      dbPath: h.dbPath,
      cwd: h.dir,
      spawn: h.spawn,
    });
    finishRun(h.db, "search", SEARCH_RUN_KEY, true, "3 found, 1 new");
    expect(
      startBackgroundSearch({
        db: h.db,
        dbPath: h.dbPath,
        cwd: h.dir,
        spawn: h.spawn,
      }).started,
    ).toBe(true);
    expect(h.requests).toHaveLength(2);
    h.cleanup();
  });

  it("treats a startRun failure as a refusal and kills the spawned child", () => {
    const h = harness();
    // Simulates SQLITE_BUSY from the claim transaction.
    const busy = new Proxy(h.db, {
      get(target, prop) {
        if (prop === "transaction") {
          const boom = () => {
            throw new Error("database is locked");
          };
          return () => Object.assign(boom, { immediate: boom });
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Database;
    const result = startBackgroundSearch({
      db: busy,
      dbPath: h.dbPath,
      cwd: h.dir,
      spawn: h.spawn,
    });
    expect(result.started).toBe(false);
    expect(result.message).toContain("database is locked");
    expect(h.killed()).toBe(1);
    expect(getRun(h.db, "search", SEARCH_RUN_KEY)).toBeNull();
    h.cleanup();
  });

  it("leaves no run row when spawn throws", () => {
    const h = harness();
    const result = startBackgroundSearch({
      db: h.db,
      dbPath: h.dbPath,
      cwd: h.dir,
      spawn: () => {
        throw new Error("ENOENT");
      },
    });
    expect(result.started).toBe(false);
    expect(result.message).toContain("ENOENT");
    expect(getRun(h.db, "search", SEARCH_RUN_KEY)).toBeNull();
    h.cleanup();
  });
});

describe("describeSearchRun", () => {
  const run = (ok: boolean, message: string) => ({
    kind: "search" as const,
    key: SEARCH_RUN_KEY,
    pid: 1,
    startedAt: "",
    finishedAt: "",
    ok,
    message,
  });

  it("shows the summary or the failure", () => {
    expect(describeSearchRun(run(true, "3 found, 1 new"), "/d/igor.db")).toBe(
      "Search done: 3 found, 1 new",
    );
    expect(describeSearchRun(run(false, "bad config"), "/d/igor.db")).toBe(
      "Search failed: bad config",
    );
  });

  it("points at the log when the process died", () => {
    expect(
      describeSearchRun(
        run(false, "search process exited unexpectedly"),
        "/d/igor.db",
      ),
    ).toBe(
      "Search failed: search process exited unexpectedly (see /d/igor-search.log)",
    );
  });
});
