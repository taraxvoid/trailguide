import { Database } from "bun:sqlite";
import type { NormalizedJob } from "./sources/types.ts";

export type ListingState = "active" | "archived" | "inactive" | "applied";

export interface StoredJob extends NormalizedJob {
  listingId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastCheckedAt: string;
  state: ListingState;
}

export function listingId(
  job: Pick<NormalizedJob, "source" | "sourceId">,
): string {
  return `${job.source}:${job.sourceId}`;
}

export function openDb(path = "igor.db"): Database {
  const db = new Database(path);
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
    INSERT INTO jobs (listing_id, source_id, source, title, company, location, remote_type, url, posted_at, description, first_seen_at, last_seen_at, last_checked_at, state)
    VALUES ($listingId, $sourceId, $source, $title, $company, $location, $remoteType, $url, $postedAt, $description, $firstSeenAt, $lastSeenAt, $lastCheckedAt, $state)
    ON CONFLICT(listing_id) DO UPDATE SET last_seen_at = $lastSeenAt, last_checked_at = $lastCheckedAt, state = COALESCE($explicitState, state)
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
      "UPDATE jobs SET state = $state, last_checked_at = $lastCheckedAt WHERE listing_id = $listingId",
    )
    .run({
      $state: state,
      $lastCheckedAt: lastCheckedAt,
      $listingId: listingId,
    });
  return result.changes > 0;
}

export function clearJobs(db: Database): void {
  db.run("DELETE FROM jobs");
}
