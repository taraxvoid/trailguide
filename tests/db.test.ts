import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allJobs,
  clearJobs,
  getJob,
  jobsByState,
  type ListingState,
  listingId,
  openDb,
  setJobApplied,
  setJobLane,
  setJobState,
  upsertJobs,
} from "../src/db.ts";
import type { NormalizedJob } from "../src/sources/types.ts";

let counter = 0;

function freshDb() {
  const path = `/tmp/igor-db-test-${Date.now()}-${++counter}.db`;
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
    const dir = mkdtempSync(join(tmpdir(), "igor-open-"));
    const path = join(dir, "a", "b", "igor.db");
    openDb(path).close();
    expect(existsSync(path)).toBe(true);
    rmSync(dir, { recursive: true });
  });
});

describe("lane", () => {
  it("stores the lane from search and keeps a manual change", () => {
    const db = freshDb();
    upsertJobs(db, [mockJob({ lane: "platform" })]);
    expect(getJob(db, "jsearch:1")?.lane).toBe("platform");

    expect(setJobLane(db, "jsearch:1", "secplat")).toBe(true);
    upsertJobs(db, [mockJob({ lane: "platform" })]);
    expect(getJob(db, "jsearch:1")?.lane).toBe("secplat");

    setJobLane(db, "jsearch:1", null);
    expect(getJob(db, "jsearch:1")?.lane).toBeUndefined();
  });

  it("returns false for an unknown listing", () => {
    expect(setJobLane(freshDb(), "jsearch:nope", "x")).toBe(false);
  });
});
