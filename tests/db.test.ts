import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allJobs,
  clearJobs,
  getJob,
  getSetting,
  getTailoredResume,
  jobsByState,
  type ListingState,
  listingId,
  openDb,
  saveImportedJob,
  setJobApplied,
  setJobState,
  setJobTrail,
  setSetting,
  setTailoredResume,
  upsertJobs,
} from "../src/db.ts";
import type { NormalizedJob } from "../src/sources/types.ts";

let counter = 0;

function freshDb() {
  const path = `${tmpdir()}/trailguide-db-test-${Date.now()}-${++counter}.db`;
  rmSync(path, { force: true });
  return openDb(path);
}

function first<T extends object>(items: T[]): T {
  const [item] = items;
  if (!item) throw new Error("Expected at least one item");
  return item;
}

function mockJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
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

describe("listingId", () => {
  it("combines source and sourceId with colon", () => {
    expect(listingId({ source: "greenhouse", sourceId: "42" })).toBe(
      "greenhouse:42",
    );
  });

  it("produces unique IDs for same job from different sources", () => {
    const a = listingId({ source: "greenhouse", sourceId: "1" });
    const b = listingId({ source: "lever", sourceId: "1" });
    expect(a).not.toBe(b);
  });
});

describe("openDb", () => {
  it("creates a database with the jobs table", () => {
    const db = freshDb();
    const rows = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'",
      )
      .all();
    expect(rows.length).toBe(1);
    db.close();
  });

  it("uses listing_id as primary key", () => {
    const db = freshDb();
    const sql = db
      .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'")
      .get() as { sql: string };
    expect(sql.sql).toContain("listing_id TEXT PRIMARY KEY");
    expect(sql.sql).not.toContain("dedupe_key");
    db.close();
  });
});

describe("upsertJobs", () => {
  it("inserts jobs with listingId from source+sourceId", () => {
    const db = freshDb();
    const jobs = [mockJob({ sourceId: "job-1", source: "jsearch" })];
    const newJobs = upsertJobs(db, jobs);

    expect(newJobs).toHaveLength(1);
    expect(first(newJobs).listingId).toBe("jsearch:job-1");
    db.close();
  });

  it("sets state to active by default", () => {
    const db = freshDb();
    const jobs = [mockJob()];
    const newJobs = upsertJobs(db, jobs);

    expect(first(newJobs).state).toBe("active");
    db.close();
  });

  it("sets lastCheckedAt to insertion time", () => {
    const db = freshDb();
    const jobs = [mockJob()];
    const newJobs = upsertJobs(db, jobs);

    const job = first(newJobs);
    expect(job.lastCheckedAt).toBe(job.firstSeenAt);
    db.close();
  });

  it("applies states from the map", () => {
    const db = freshDb();
    const jobs = [mockJob({ sourceId: "job-1", source: "jsearch" })];
    const states = new Map<string, ListingState>([
      ["jsearch:job-1", "inactive"],
    ]);
    const newJobs = upsertJobs(db, jobs, states);

    expect(first(newJobs).state).toBe("inactive");
    db.close();
  });

  it("returns only new jobs", () => {
    const db = freshDb();
    const jobs = [mockJob()];
    const first = upsertJobs(db, jobs);
    const second = upsertJobs(db, jobs);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    db.close();
  });

  it("updates existing jobs on conflict", () => {
    const db = freshDb();
    const jobs = [mockJob()];
    upsertJobs(db, jobs);
    upsertJobs(db, jobs);

    expect(allJobs(db)).toHaveLength(1);
    db.close();
  });

  it("does not overwrite an existing job's state on re-search without an explicit override", () => {
    const db = freshDb();
    const jobs = [mockJob({ sourceId: "job-1", source: "jsearch" })];
    upsertJobs(db, jobs);
    setJobState(db, "jsearch:job-1", "applied", "2024-01-01T00:00:00Z");

    upsertJobs(db, jobs);

    expect(first(allJobs(db)).state).toBe("applied");
    db.close();
  });

  it("still applies an explicit state override on conflict", () => {
    const db = freshDb();
    const jobs = [mockJob({ sourceId: "job-1", source: "jsearch" })];
    upsertJobs(db, jobs);
    setJobState(db, "jsearch:job-1", "applied", "2024-01-01T00:00:00Z");

    const states = new Map<string, ListingState>([
      ["jsearch:job-1", "inactive"],
    ]);
    upsertJobs(db, jobs, states);

    expect(first(allJobs(db)).state).toBe("inactive");
    db.close();
  });
});

describe("appliedAt", () => {
  const id = "jsearch:job-1";
  const seed = () => {
    const db = freshDb();
    upsertJobs(db, [mockJob({ sourceId: "job-1", source: "jsearch" })]);
    return db;
  };

  it("is set when applied and kept when archived", () => {
    const db = seed();
    setJobState(db, id, "applied", "2024-01-01T00:00:00Z");
    setJobState(db, id, "archived", "2024-02-01T00:00:00Z");
    const job = getJob(db, id);
    expect(job?.state).toBe("archived");
    expect(job?.appliedAt).toBe("2024-01-01T00:00:00Z");
    db.close();
  });

  it("is cleared when set back to active", () => {
    const db = seed();
    setJobState(db, id, "applied", "2024-01-01T00:00:00Z");
    setJobState(db, id, "active", "2024-02-01T00:00:00Z");
    expect(getJob(db, id)?.appliedAt).toBeNull();
    db.close();
  });

  it("setJobApplied toggles without changing state", () => {
    const db = seed();
    setJobState(db, id, "archived", "2024-01-01T00:00:00Z");
    setJobApplied(db, id, true, "2024-02-01T00:00:00Z");
    expect(getJob(db, id)?.appliedAt).toBe("2024-02-01T00:00:00Z");
    expect(getJob(db, id)?.state).toBe("archived");
    setJobApplied(db, id, false, "2024-03-01T00:00:00Z");
    expect(getJob(db, id)?.appliedAt).toBeNull();
    db.close();
  });
});

describe("allJobs", () => {
  it("returns all jobs with listingId, state, and lastCheckedAt", () => {
    const db = freshDb();
    const jobs = [mockJob({ sourceId: "j1", source: "jsearch" })];
    upsertJobs(db, jobs);

    const all = allJobs(db);
    expect(all).toHaveLength(1);
    expect(first(all).listingId).toBe("jsearch:j1");
    expect(first(all).state).toBe("active");
    expect(first(all).lastCheckedAt).toBeDefined();
    db.close();
  });

  it("returns empty array for empty db", () => {
    const db = freshDb();
    const all = allJobs(db);
    expect(all).toHaveLength(0);
    db.close();
  });
});

describe("jobsByState", () => {
  it("filters jobs by state", () => {
    const db = freshDb();
    const active = [mockJob({ sourceId: "a1", source: "jsearch" })];
    const inactive = [mockJob({ sourceId: "a2", source: "jsearch" })];

    upsertJobs(db, active, new Map([["jsearch:a1", "active"]]));
    upsertJobs(db, inactive, new Map([["jsearch:a2", "inactive"]]));

    const activeJobs = jobsByState(db, "active");
    expect(activeJobs).toHaveLength(1);
    expect(first(activeJobs).listingId).toBe("jsearch:a1");

    const inactiveJobs = jobsByState(db, "inactive");
    expect(inactiveJobs).toHaveLength(1);
    expect(first(inactiveJobs).listingId).toBe("jsearch:a2");

    db.close();
  });
});

describe("getJob", () => {
  it("returns the job matching listingId", () => {
    const db = freshDb();
    upsertJobs(db, [
      mockJob({ sourceId: "j1", source: "jsearch", title: "Backend Engineer" }),
    ]);

    const job = getJob(db, "jsearch:j1");
    expect(job?.title).toBe("Backend Engineer");
    db.close();
  });

  it("returns null for an unknown listingId", () => {
    const db = freshDb();
    expect(getJob(db, "jsearch:missing")).toBeNull();
    db.close();
  });
});

describe("setJobState", () => {
  it("updates state for existing job", () => {
    const db = freshDb();
    const jobs = [mockJob()];
    upsertJobs(db, jobs);

    const result = setJobState(
      db,
      "jsearch:1",
      "inactive",
      "2024-01-01T00:00:00Z",
    );
    expect(result).toBe(true);

    const all = allJobs(db);
    expect(first(all).state).toBe("inactive");
    expect(first(all).lastCheckedAt).toBe("2024-01-01T00:00:00Z");
    db.close();
  });

  it("returns false when job does not exist", () => {
    const db = freshDb();
    const result = setJobState(
      db,
      "nonexistent:job",
      "inactive",
      "2024-01-01T00:00:00Z",
    );
    expect(result).toBe(false);
    db.close();
  });
});

describe("clearJobs", () => {
  it("removes all jobs", () => {
    const db = freshDb();
    const jobs = [mockJob({ sourceId: "j1", source: "jsearch" })];
    upsertJobs(db, jobs);

    expect(allJobs(db)).toHaveLength(1);

    clearJobs(db);
    expect(allJobs(db)).toHaveLength(0);
    db.close();
  });
});

describe("openDb paths", () => {
  it("creates missing parent directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "trailguide-open-"));
    const path = join(dir, "a", "b", "trailguide.db");
    openDb(path).close();
    expect(existsSync(path)).toBe(true);
    rmSync(dir, { recursive: true });
  });
});

describe("trail", () => {
  it("stores the trail from search and keeps a manual change", () => {
    const db = freshDb();
    upsertJobs(db, [mockJob({ trail: "platform" })]);
    expect(getJob(db, "jsearch:1")?.trail).toBe("platform");

    expect(setJobTrail(db, "jsearch:1", "secplat")).toBe(true);
    upsertJobs(db, [mockJob({ trail: "platform" })]);
    expect(getJob(db, "jsearch:1")?.trail).toBe("secplat");

    setJobTrail(db, "jsearch:1", null);
    expect(getJob(db, "jsearch:1")?.trail).toBeUndefined();
  });

  it("returns false for an unknown listing", () => {
    expect(setJobTrail(freshDb(), "jsearch:nope", "x")).toBe(false);
  });
});

describe("openDb legacy lane column", () => {
  it("renames jobs.lane to jobs.trail and keeps the data", () => {
    const path = `${tmpdir()}/trailguide-db-test-legacy-${Date.now()}.db`;
    rmSync(path, { force: true });
    const legacy = new Database(path);
    legacy.run(
      "CREATE TABLE jobs (listing_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, company TEXT NOT NULL, location TEXT, remote_type TEXT, url TEXT NOT NULL, posted_at TEXT, description TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_checked_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', lane TEXT)",
    );
    legacy.run(
      "INSERT INTO jobs (listing_id, source_id, source, title, company, url, first_seen_at, last_seen_at, last_checked_at, lane) VALUES ('a', '1', 's', 't', 'c', 'u', 'x', 'x', 'x', 'secplat')",
    );
    legacy.close();
    const db = openDb(path);
    expect(getJob(db, "a")?.trail).toBe("secplat");
    rmSync(path, { force: true });
  });
});

describe("saveImportedJob", () => {
  function tmpDbPath() {
    return join(mkdtempSync(join(tmpdir(), "trailguide-import-")), "t.db");
  }
  const imported = (overrides: Partial<NormalizedJob> = {}) =>
    mockJob({ source: "greenhouse", sourceId: "1", ...overrides });

  it("adds a new job with trail and imported_at", () => {
    const db = openDb(tmpDbPath());
    expect(saveImportedJob(db, imported(), "platform")).toEqual({
      listingId: "greenhouse:1",
      added: true,
    });
    const job = getJob(db, "greenhouse:1");
    expect(job?.trail).toBe("platform");
    expect(job?.state).toBe("active");
    expect(job?.importedAt).not.toBeNull();
  });

  it("updates an existing searched job without touching state", () => {
    const db = openDb(tmpDbPath());
    upsertJobs(db, [imported()]);
    setJobState(db, "greenhouse:1", "applied", "2026-01-01T00:00:00.000Z");
    const appliedAt = getJob(db, "greenhouse:1")?.appliedAt;
    expect(appliedAt).not.toBeNull();
    const result = saveImportedJob(
      db,
      imported({ title: "Renamed Engineer" }),
      "ai-infra",
    );
    expect(result.added).toBe(false);
    const job = getJob(db, "greenhouse:1");
    expect(job?.title).toBe("Renamed Engineer");
    expect(job?.state).toBe("applied");
    expect(job?.appliedAt).toBe(appliedAt ?? null);
    expect(job?.trail).toBe("ai-infra");
    expect(job?.importedAt).not.toBeNull();
  });

  it("null trail clears an existing trail", () => {
    const db = openDb(tmpDbPath());
    saveImportedJob(db, imported(), "platform");
    saveImportedJob(db, imported(), null);
    expect(getJob(db, "greenhouse:1")?.trail).toBeUndefined();
  });

  it("keeps the first imported_at on re-import", async () => {
    const db = openDb(tmpDbPath());
    saveImportedJob(db, imported(), null);
    const firstAt = getJob(db, "greenhouse:1")?.importedAt;
    await Bun.sleep(5);
    saveImportedJob(db, imported(), null);
    expect(getJob(db, "greenhouse:1")?.importedAt).toBe(firstAt ?? null);
  });

  it("openDb migrates a db without imported_at", () => {
    const path = tmpDbPath();
    const legacy = new Database(path);
    legacy.run(
      "CREATE TABLE jobs (listing_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, company TEXT NOT NULL, location TEXT NOT NULL, remote_type TEXT NOT NULL, url TEXT NOT NULL, posted_at TEXT, description TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_checked_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active')",
    );
    legacy.close();
    openDb(path).close();
    const db = openDb(path);
    const cols = db.query("PRAGMA table_info(jobs)").all() as {
      name: string;
    }[];
    expect(cols.some((c) => c.name === "imported_at")).toBe(true);
  });
});

describe("job regions", () => {
  it("upsertJobs stores regions and later searches add to them", () => {
    const db = freshDb();
    upsertJobs(db, [mockJob({ regions: ["bay"] })]);
    upsertJobs(db, [mockJob({ regions: ["omaha"] })]);
    const job = getJob(db, "jsearch:1");
    expect(job?.regions.slice().sort()).toEqual(["bay", "omaha"]);
    expect(first(allJobs(db)).regions.slice().sort()).toEqual(["bay", "omaha"]);
  });

  it("jobs without regions read back as []", () => {
    const db = freshDb();
    upsertJobs(db, [mockJob()]);
    expect(getJob(db, "jsearch:1")?.regions).toEqual([]);
    expect(first(jobsByState(db, "active")).regions).toEqual([]);
  });
});

describe("settings", () => {
  it("round-trips", () => {
    const db = freshDb();
    expect(getSetting(db, "tui.region")).toBeNull();
    setSetting(db, "tui.region", "omaha");
    expect(getSetting(db, "tui.region")).toBe("omaha");
    setSetting(db, "tui.region", "bay");
    expect(getSetting(db, "tui.region")).toBe("bay");
  });
});

describe("tailored resume region", () => {
  it("setTailoredResume records the region", () => {
    const db = freshDb();
    setTailoredResume(db, "a", "/x/a.md", "bay");
    setTailoredResume(db, "b", "/x/b.md");
    expect(getTailoredResume(db, "a")?.region).toBe("bay");
    expect(getTailoredResume(db, "b")?.region).toBeNull();
  });

  it("opening an old db adds the new tables and column", () => {
    const path = join(mkdtempSync(join(tmpdir(), "trailguide-old-")), "t.db");
    const old = new Database(path);
    old.run(
      "CREATE TABLE tailored_resumes (listing_id TEXT PRIMARY KEY, markdown_path TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    old.close();
    const db = openDb(path);
    setTailoredResume(db, "a", "/x/a.md", "bay");
    expect(getTailoredResume(db, "a")?.region).toBe("bay");
    setSetting(db, "k", "v");
    expect(getSetting(db, "k")).toBe("v");
  });
});
