import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { NormalizedJob } from "./sources/types.ts";

export type ListingState = "active" | "archived" | "inactive" | "applied";

export interface StoredJob extends NormalizedJob {
  listingId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastCheckedAt: string;
  state: ListingState;
  /** When the job was marked applied; survives archiving (state is single-valued). */
  appliedAt: string | null;
}

export function listingId(
  job: Pick<NormalizedJob, "source" | "sourceId">,
): string {
  return `${job.source}:${job.sourceId}`;
}

/** One-time move of the old tailor_runs table into runs. Idempotent. */
function migrateTailorRuns(db: Database): void {
  const hasLegacy = () =>
    db
      .query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tailor_runs'",
      )
      .get() !== null;
  if (!hasLegacy()) return;
  // IMMEDIATE plus a re-check, so two processes opening the db at once
  // don't both migrate.
  db.transaction(() => {
    if (!hasLegacy()) return;
    db.run(`
      INSERT OR IGNORE INTO runs (kind, key, pid, started_at, finished_at, ok, message)
      SELECT 'tailor', listing_id, pid, started_at, finished_at, ok, message FROM tailor_runs
    `);
    db.run("DROP TABLE tailor_runs");
  }).immediate();
}

export function openDb(path: string): Database {
  // The global default lives under a data dir that may not exist yet.
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // The TUI and detached igor processes (tailor, search) write the same file.
  db.run("PRAGMA busy_timeout = 5000");
  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      listing_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT NOT NULL,
      remote_type TEXT NOT NULL,
      url TEXT NOT NULL,
      posted_at TEXT,
      description TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_checked_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active'
    )
  `);
  const cols = db.query("PRAGMA table_info(jobs)").all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "state_changed_at")) {
    db.run("ALTER TABLE jobs ADD COLUMN state_changed_at TEXT");
  }
  if (!cols.some((c) => c.name === "applied_at")) {
    db.run("ALTER TABLE jobs ADD COLUMN applied_at TEXT");
    db.run(
      "UPDATE jobs SET applied_at = COALESCE(state_changed_at, last_checked_at) WHERE state = 'applied'",
    );
  }
  // Which tailored markdown file belongs to which listing. That .md is the
  // canonical resume for the job once generated (it's meant to be
  // hand-edited afterwards), so its PDF is regenerated from it rather than
  // re-tailored from the master.
  db.run(`
    CREATE TABLE IF NOT EXISTS tailored_resumes (
      listing_id TEXT PRIMARY KEY,
      markdown_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  // Background igor processes (`igor tailor`, `igor search`), so the TUI can
  // show progress and pick it back up after being restarted. One row per
  // (kind, key), the latest run; finished_at is NULL while running.
  db.run(`
    CREATE TABLE IF NOT EXISTS runs (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      pid INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      ok INTEGER,
      message TEXT,
      PRIMARY KEY (kind, key)
    )
  `);
  migrateTailorRuns(db);
  return db;
}

/** Upserts jobs, returning only the ones not previously seen in this db. */
export function upsertJobs(
  db: Database,
  jobs: NormalizedJob[],
  states?: Map<string, ListingState>,
): StoredJob[] {
  const now = new Date().toISOString();
  const newJobs: StoredJob[] = [];

  const insert = db.prepare(`
    INSERT INTO jobs (listing_id, source_id, source, title, company, location, remote_type, url, posted_at, description, first_seen_at, last_seen_at, last_checked_at, state, applied_at)
    VALUES ($listingId, $sourceId, $source, $title, $company, $location, $remoteType, $url, $postedAt, $description, $firstSeenAt, $lastSeenAt, $lastCheckedAt, $state, $appliedAt)
    ON CONFLICT(listing_id) DO UPDATE SET last_seen_at = $lastSeenAt, last_checked_at = $lastCheckedAt, state = COALESCE($explicitState, state), state_changed_at = CASE WHEN $explicitState IS NOT NULL AND $explicitState != state THEN $lastCheckedAt ELSE state_changed_at END, applied_at = CASE WHEN $explicitState = 'applied' THEN COALESCE(applied_at, $lastCheckedAt) WHEN $explicitState = 'active' THEN NULL ELSE applied_at END
  `);
  const exists = db.prepare("SELECT 1 FROM jobs WHERE listing_id = ?");

  const tx = db.transaction((batch: NormalizedJob[]) => {
    for (const job of batch) {
      const key = listingId(job);
      const isNew = exists.get(key) === null;
      const explicitState = states?.get(key) ?? null;
      const jobState = explicitState ?? "active";
      insert.run({
        $listingId: key,
        $sourceId: job.sourceId,
        $source: job.source,
        $title: job.title,
        $company: job.company,
        $location: job.location,
        $remoteType: job.remoteType,
        $url: job.url,
        $postedAt: job.postedAt,
        $description: job.description,
        $firstSeenAt: now,
        $lastSeenAt: now,
        $lastCheckedAt: now,
        $state: jobState,
        $appliedAt: jobState === "applied" ? now : null,
        $explicitState: explicitState,
      });
      if (isNew) {
        newJobs.push({
          ...job,
          listingId: key,
          firstSeenAt: now,
          lastSeenAt: now,
          lastCheckedAt: now,
          state: jobState,
          appliedAt: jobState === "applied" ? now : null,
        });
      }
    }
  });
  tx(jobs);

  return newJobs;
}

function rowToStoredJob(row: Record<string, string>): StoredJob {
  return {
    listingId: row.listing_id ?? "",
    sourceId: row.source_id ?? "",
    source: row.source as NormalizedJob["source"],
    title: row.title ?? "",
    company: row.company ?? "",
    location: row.location ?? "",
    remoteType: row.remote_type as NormalizedJob["remoteType"],
    url: row.url ?? "",
    postedAt: row.posted_at ?? null,
    description: row.description ?? null,
    firstSeenAt: row.first_seen_at ?? "",
    lastSeenAt: row.last_seen_at ?? "",
    lastCheckedAt: row.last_checked_at ?? "",
    state: (row.state as ListingState) ?? "active",
    appliedAt: row.applied_at ?? null,
  };
}

export function allJobs(db: Database): StoredJob[] {
  const rows = db
    .query("SELECT * FROM jobs ORDER BY last_seen_at DESC")
    .all() as Array<Record<string, string>>;
  return rows.map(rowToStoredJob);
}

export function jobsByState(db: Database, state: ListingState): StoredJob[] {
  const rows = db
    .prepare(
      "SELECT * FROM jobs WHERE state = $state ORDER BY last_seen_at DESC",
    )
    .all({ $state: state }) as Array<Record<string, string>>;
  return rows.map(rowToStoredJob);
}

export function getJob(db: Database, listingId: string): StoredJob | null {
  const row = db
    .prepare("SELECT * FROM jobs WHERE listing_id = $listingId")
    .get({ $listingId: listingId }) as Record<string, string> | null;
  return row ? rowToStoredJob(row) : null;
}

export function setJobState(
  db: Database,
  listingId: string,
  state: ListingState,
  lastCheckedAt: string,
): boolean {
  const result = db
    .prepare(
      "UPDATE jobs SET state_changed_at = CASE WHEN state != $state THEN $lastCheckedAt ELSE state_changed_at END, state = $state, applied_at = CASE WHEN $state = 'applied' THEN COALESCE(applied_at, $lastCheckedAt) WHEN $state = 'active' THEN NULL ELSE applied_at END, last_checked_at = $lastCheckedAt WHERE listing_id = $listingId",
    )
    .run({
      $state: state,
      $lastCheckedAt: lastCheckedAt,
      $listingId: listingId,
    });
  return result.changes > 0;
}

/** Marks or unmarks applied without touching state (e.g. on archived jobs). */
export function setJobApplied(
  db: Database,
  listingId: string,
  applied: boolean,
  now: string,
): boolean {
  const result = db
    .prepare(
      "UPDATE jobs SET applied_at = CASE WHEN $applied THEN COALESCE(applied_at, $now) ELSE NULL END WHERE listing_id = $listingId",
    )
    .run({ $applied: applied ? 1 : 0, $now: now, $listingId: listingId });
  return result.changes > 0;
}

/**
 * Jobs currently in `state` whose last state change falls in [from, to),
 * newest change first. Rows from before state_changed_at existed fall back
 * to last_checked_at. For "applied" this uses applied_at instead, so jobs
 * archived after applying are still included, dated by when they applied.
 */
export function jobsInStateBetween(
  db: Database,
  state: ListingState,
  from: Date | null,
  to: Date | null,
): Array<StoredJob & { stateChangedAt: string }> {
  const byApplied = state === "applied";
  const rows = (
    byApplied
      ? db.prepare("SELECT * FROM jobs WHERE applied_at IS NOT NULL").all()
      : db
          .prepare("SELECT * FROM jobs WHERE state = $state")
          .all({ $state: state })
  ) as Array<Record<string, string>>;
  return rows
    .map((row) => ({
      ...rowToStoredJob(row),
      stateChangedAt:
        (byApplied ? row.applied_at : row.state_changed_at) ??
        row.last_checked_at ??
        "",
    }))
    .filter((job) => {
      const t = new Date(job.stateChangedAt).getTime();
      return (!from || t >= from.getTime()) && (!to || t < to.getTime());
    })
    .sort((a, b) => b.stateChangedAt.localeCompare(a.stateChangedAt));
}

export function clearJobs(db: Database): void {
  db.run("DELETE FROM jobs");
}

export interface TailoredResumeRecord {
  listingId: string;
  markdownPath: string;
  createdAt: string;
  updatedAt: string;
}

export function getTailoredResume(
  db: Database,
  listingId: string,
): TailoredResumeRecord | null {
  const row = db
    .prepare("SELECT * FROM tailored_resumes WHERE listing_id = $listingId")
    .get({ $listingId: listingId }) as Record<string, string> | null;
  if (!row) return null;
  return {
    listingId: row.listing_id ?? "",
    markdownPath: row.markdown_path ?? "",
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

export function tailoredListingIds(db: Database): Set<string> {
  const rows = db.prepare("SELECT listing_id FROM tailored_resumes").all() as {
    listing_id: string;
  }[];
  return new Set(rows.map((r) => r.listing_id));
}

/** Returns the listing whose tailored resume lives at `markdownPath`, if any. */
export function tailoredResumeOwner(
  db: Database,
  markdownPath: string,
): string | null {
  const row = db
    .prepare(
      "SELECT listing_id FROM tailored_resumes WHERE markdown_path = $markdownPath",
    )
    .get({ $markdownPath: markdownPath }) as { listing_id: string } | null;
  return row?.listing_id ?? null;
}

export function setTailoredResume(
  db: Database,
  listingId: string,
  markdownPath: string,
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tailored_resumes (listing_id, markdown_path, created_at, updated_at)
    VALUES ($listingId, $markdownPath, $now, $now)
    ON CONFLICT(listing_id) DO UPDATE SET markdown_path = $markdownPath, updated_at = $now
  `).run({ $listingId: listingId, $markdownPath: markdownPath, $now: now });
}

export type RunKind = "tailor" | "search";

/** The single key used for `kind = "search"` runs (one search per db). */
export const SEARCH_RUN_KEY = "search";

export interface Run {
  kind: RunKind;
  key: string;
  pid: number;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  message: string | null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but isn't ours.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function toRun(row: Record<string, unknown>): Run {
  return {
    kind: row.kind as RunKind,
    key: row.key as string,
    pid: row.pid as number,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
    ok: row.ok === null || row.ok === undefined ? null : row.ok === 1,
    message: (row.message as string | null) ?? null,
  };
}

export function getRun(db: Database, kind: RunKind, key: string): Run | null {
  const row = db
    .prepare("SELECT * FROM runs WHERE kind = $kind AND key = $key")
    .get({ $kind: kind, $key: key }) as Record<string, unknown> | null;
  return row ? toRun(row) : null;
}

/**
 * Marks a run as started by `pid`. Returns false if a different live process
 * already has one running for this (kind, key). Re-claiming with the same pid
 * is fine: the TUI records the child's pid before the child starts.
 */
export function startRun(
  db: Database,
  kind: RunKind,
  key: string,
  pid: number,
  now = new Date().toISOString(),
): boolean {
  const existing = getRun(db, kind, key);
  if (
    existing &&
    existing.finishedAt === null &&
    existing.pid !== pid &&
    pidAlive(existing.pid)
  ) {
    return false;
  }
  db.prepare(
    `INSERT INTO runs (kind, key, pid, started_at, finished_at, ok, message)
     VALUES ($kind, $key, $pid, $now, NULL, NULL, NULL)
     ON CONFLICT(kind, key) DO UPDATE SET pid = $pid, started_at = $now, finished_at = NULL, ok = NULL, message = NULL`,
  ).run({ $kind: kind, $key: key, $pid: pid, $now: now });
  return true;
}

export function finishRun(
  db: Database,
  kind: RunKind,
  key: string,
  ok: boolean,
  message: string,
  now = new Date().toISOString(),
): void {
  db.prepare(
    "UPDATE runs SET finished_at = $now, ok = $ok, message = $message WHERE kind = $kind AND key = $key",
  ).run({
    $kind: kind,
    $key: key,
    $now: now,
    $ok: ok ? 1 : 0,
    $message: message,
  });
}

/**
 * Runs of `kind` in flight. Runs whose process died without finishing
 * (killed, crashed) are closed out as failed here, the only place that
 * happens, rather than showing as running forever.
 */
export function runningRuns(db: Database, kind: RunKind): Run[] {
  const rows = db
    .prepare("SELECT * FROM runs WHERE kind = $kind AND finished_at IS NULL")
    .all({ $kind: kind }) as Record<string, unknown>[];
  const live: Run[] = [];
  for (const row of rows) {
    const run = toRun(row);
    if (pidAlive(run.pid)) live.push(run);
    else
      finishRun(
        db,
        kind,
        run.key,
        false,
        `${kind} process exited unexpectedly`,
      );
  }
  return live;
}

export function getTailorRun(db: Database, listingId: string): Run | null {
  return getRun(db, "tailor", listingId);
}

export function startTailorRun(
  db: Database,
  listingId: string,
  pid: number,
  now?: string,
): boolean {
  return startRun(db, "tailor", listingId, pid, now);
}

export function finishTailorRun(
  db: Database,
  listingId: string,
  ok: boolean,
  message: string,
  now?: string,
): void {
  finishRun(db, "tailor", listingId, ok, message, now);
}

/** Listings with a tailor run in flight. */
export function runningTailorIds(db: Database): Set<string> {
  return new Set(runningRuns(db, "tailor").map((run) => run.key));
}
