import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import {
  finishRun,
  finishTailorRun,
  getRun,
  getTailorRun,
  openDb,
  runningRuns,
  runningTailorIds,
  SEARCH_RUN_KEY,
  startRun,
  startTailorRun,
} from "../src/db.ts";

let counter = 0;

function freshDb() {
  const path = `/tmp/trailguide-runs-test-${Date.now()}-${++counter}.db`;
  rmSync(path, { force: true });
  return openDb(path);
}

// A pid that is certainly dead: spawn and reap a short-lived process.
async function deadPid(): Promise<number> {
  const proc = Bun.spawn({ cmd: ["true"] });
  await proc.exited;
  return proc.pid;
}

describe("tailor runs", () => {
  it("tracks a live run until it finishes", () => {
    const db = freshDb();
    expect(startTailorRun(db, "a:1", process.pid)).toBe(true);
    expect(runningTailorIds(db).has("a:1")).toBe(true);

    finishTailorRun(db, "a:1", true, "Wrote x.pdf");
    expect(runningTailorIds(db).size).toBe(0);
    expect(getTailorRun(db, "a:1")).toMatchObject({
      ok: true,
      message: "Wrote x.pdf",
    });
  });

  it("refuses a second run while another live process owns one", () => {
    const db = freshDb();
    // pid 1 is always alive (and not ours).
    expect(startTailorRun(db, "a:1", 1)).toBe(true);
    expect(startTailorRun(db, "a:1", process.pid)).toBe(false);
  });

  it("lets the same pid re-claim (TUI records the child's pid first)", () => {
    const db = freshDb();
    expect(startTailorRun(db, "a:1", process.pid)).toBe(true);
    expect(startTailorRun(db, "a:1", process.pid)).toBe(true);
  });

  it("with forChild, keeps a same-pid finished outcome instead of resurrecting it", () => {
    const db = freshDb();
    startTailorRun(db, "a:1", process.pid);
    finishTailorRun(db, "a:1", true, "Wrote x.pdf");
    expect(
      startTailorRun(db, "a:1", process.pid, undefined, { forChild: true }),
    ).toBe(true);
    expect(getTailorRun(db, "a:1")).toMatchObject({
      ok: true,
      message: "Wrote x.pdf",
    });
    expect(runningTailorIds(db).size).toBe(0);
    // The default claim still resets the row.
    expect(startTailorRun(db, "a:1", process.pid)).toBe(true);
    expect(runningTailorIds(db).has("a:1")).toBe(true);
  });

  it("closes out runs whose process died as failed", async () => {
    const db = freshDb();
    const pid = await deadPid();
    startTailorRun(db, "a:1", pid);
    expect(runningTailorIds(db).size).toBe(0);
    expect(getTailorRun(db, "a:1")).toMatchObject({ ok: false });
  });

  it("takes over a dead run", async () => {
    const db = freshDb();
    startTailorRun(db, "a:1", await deadPid());
    expect(startTailorRun(db, "a:1", process.pid)).toBe(true);
  });
});

describe("runs", () => {
  it("keeps kinds independent even with the same key", () => {
    const db = freshDb();
    expect(startRun(db, "search", SEARCH_RUN_KEY, process.pid)).toBe(true);
    expect(startRun(db, "tailor", SEARCH_RUN_KEY, process.pid)).toBe(true);
    finishRun(db, "search", SEARCH_RUN_KEY, true, "3 found, 1 new");
    expect(getRun(db, "search", SEARCH_RUN_KEY)).toMatchObject({
      kind: "search",
      ok: true,
      message: "3 found, 1 new",
    });
    expect(runningRuns(db, "search")).toEqual([]);
    expect(runningRuns(db, "tailor").map((r) => r.key)).toEqual([
      SEARCH_RUN_KEY,
    ]);
  });

  it("refuses a concurrent claim from a different live pid", () => {
    const db = freshDb();
    expect(startRun(db, "search", SEARCH_RUN_KEY, 1)).toBe(true); // pid 1 is always alive
    expect(startRun(db, "search", SEARCH_RUN_KEY, process.pid)).toBe(false);
    expect(getRun(db, "search", SEARCH_RUN_KEY)?.pid).toBe(1);
  });

  it("claims atomically: a racing claim from another connection cannot also win", async () => {
    const path = `/tmp/trailguide-runs-race-${Date.now()}-${++counter}.db`;
    rmSync(path, { force: true });
    const a = openDb(path);
    const b = openDb(path);
    b.run("PRAGMA busy_timeout = 0");
    startRun(a, "search", SEARCH_RUN_KEY, await deadPid());
    // Interleave: while `a` is checking whether the stale pid is alive,
    // `b` makes its own claim for a different pid.
    let bWon: boolean | null = null;
    const realKill = process.kill.bind(process);
    const spy = spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: string | number,
    ) => {
      if (bWon === null) {
        bWon = false;
        try {
          bWon = startRun(b, "search", SEARCH_RUN_KEY, 1);
        } catch {
          bWon = false; // SQLITE_BUSY: the claim is held by `a`
        }
      }
      return realKill(pid, signal);
    }) as typeof process.kill);
    let aWon: boolean;
    try {
      aWon = startRun(a, "search", SEARCH_RUN_KEY, process.pid);
    } finally {
      spy.mockRestore();
    }
    expect(bWon).not.toBeNull();
    expect(aWon && bWon).toBe(false);
    a.close();
    b.close();
  });

  it("does not close out a run that another process re-claimed after the read", async () => {
    const path = `/tmp/trailguide-runs-reclaim-${Date.now()}-${++counter}.db`;
    rmSync(path, { force: true });
    const a = openDb(path);
    const b = openDb(path);
    startRun(a, "search", SEARCH_RUN_KEY, await deadPid());
    const realKill = process.kill.bind(process);
    let reclaimed = false;
    const spy = spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: string | number,
    ) => {
      if (!reclaimed) {
        reclaimed = true;
        startRun(b, "search", SEARCH_RUN_KEY, process.pid);
      }
      return realKill(pid, signal);
    }) as typeof process.kill);
    try {
      runningRuns(a, "search");
    } finally {
      spy.mockRestore();
    }
    expect(reclaimed).toBe(true);
    expect(getRun(a, "search", SEARCH_RUN_KEY)).toMatchObject({
      pid: process.pid,
      finishedAt: null,
      ok: null,
    });
    a.close();
    b.close();
  });

  it("closes out a dead run as failed, naming its kind", async () => {
    const db = freshDb();
    startRun(db, "search", SEARCH_RUN_KEY, await deadPid());
    startTailorRun(db, "a:1", await deadPid());
    expect(runningRuns(db, "search")).toEqual([]);
    expect(runningTailorIds(db).size).toBe(0);
    expect(getRun(db, "search", SEARCH_RUN_KEY)).toMatchObject({
      ok: false,
      message: "search process exited unexpectedly",
    });
    expect(getTailorRun(db, "a:1")).toMatchObject({
      ok: false,
      message: "tailor process exited unexpectedly",
    });
  });
});

describe("tailor_runs migration", () => {
  function legacyDb(): string {
    const path = `/tmp/trailguide-legacy-test-${Date.now()}-${++counter}.db`;
    rmSync(path, { force: true });
    const legacy = new Database(path);
    legacy.run(`CREATE TABLE tailor_runs (
      listing_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at TEXT NOT NULL,
      finished_at TEXT, ok INTEGER, message TEXT)`);
    legacy.run(
      "INSERT INTO tailor_runs VALUES ('live:1', ?, '2026-09-01T00:00:00Z', NULL, NULL, NULL)",
      [process.pid],
    );
    legacy.run(
      "INSERT INTO tailor_runs VALUES ('done:2', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:01:00Z', 1, 'Wrote x.pdf')",
    );
    legacy.close();
    return path;
  }

  const hasLegacyTable = (db: Database) =>
    db.query("SELECT 1 FROM sqlite_master WHERE name = 'tailor_runs'").get() !==
    null;

  it("moves rows into runs, keeps a live run live, and drops the old table", () => {
    const db = openDb(legacyDb());
    expect(runningTailorIds(db).has("live:1")).toBe(true);
    expect(getTailorRun(db, "done:2")).toMatchObject({
      ok: true,
      message: "Wrote x.pdf",
    });
    expect(hasLegacyTable(db)).toBe(false);
    db.close();
  });

  it("is idempotent when rerun, and never recreates tailor_runs", () => {
    const path = legacyDb();
    openDb(path).close();
    const db = openDb(path);
    expect(getTailorRun(db, "done:2")).not.toBeNull();
    expect(hasLegacyTable(db)).toBe(false);
    db.close();
    expect(hasLegacyTable(freshDb())).toBe(false);
  });

  it("keeps an existing runs row over a legacy row with the same key", () => {
    const path = legacyDb();
    const first = openDb(path);
    finishTailorRun(first, "done:2", false, "newer");
    first.run(
      "CREATE TABLE tailor_runs (listing_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, ok INTEGER, message TEXT)",
    );
    first.run(
      "INSERT INTO tailor_runs VALUES ('done:2', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', 1, 'older')",
    );
    first.close();
    const db = openDb(path);
    expect(getTailorRun(db, "done:2")?.message).toBe("newer");
    db.close();
  });
});
