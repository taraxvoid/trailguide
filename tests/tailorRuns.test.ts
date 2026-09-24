import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import {
  finishTailorRun,
  getTailorRun,
  openDb,
  runningTailorIds,
  startTailorRun,
} from "../src/db.ts";

let counter = 0;

function freshDb() {
  const path = `/tmp/igor-runs-test-${Date.now()}-${++counter}.db`;
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
