import { Database } from "bun:sqlite";
import { dedupeKey } from "./dedupe.ts";
import type { NormalizedJob } from "./sources/types.ts";

export interface StoredJob extends NormalizedJob {
  dedupeKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export function openDb(path = "igor.db"): Database {
  const db = new Database(path);
  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      dedupe_key TEXT PRIMARY KEY,
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
      last_seen_at TEXT NOT NULL
    )
  `);
  return db;
}

/** Upserts jobs, returning only the ones not previously seen in this db. */
export function upsertJobs(db: Database, jobs: NormalizedJob[]): StoredJob[] {
  const now = new Date().toISOString();
  const newJobs: StoredJob[] = [];

  const insert = db.prepare(`
    INSERT INTO jobs (dedupe_key, source_id, source, title, company, location, remote_type, url, posted_at, description, first_seen_at, last_seen_at)
    VALUES ($dedupeKey, $sourceId, $source, $title, $company, $location, $remoteType, $url, $postedAt, $description, $firstSeenAt, $lastSeenAt)
    ON CONFLICT(dedupe_key) DO UPDATE SET last_seen_at = $lastSeenAt
  `);
  const exists = db.prepare("SELECT 1 FROM jobs WHERE dedupe_key = ?");

  const tx = db.transaction((batch: NormalizedJob[]) => {
    for (const job of batch) {
      const key = dedupeKey(job);
      const isNew = exists.get(key) === null;
      insert.run({
        $dedupeKey: key,
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
      });
      if (isNew) {
        newJobs.push({
          ...job,
          dedupeKey: key,
          firstSeenAt: now,
          lastSeenAt: now,
        });
      }
    }
  });
  tx(jobs);

  return newJobs;
}

export function allJobs(db: Database): StoredJob[] {
  const rows = db
    .query("SELECT * FROM jobs ORDER BY last_seen_at DESC")
    .all() as Array<Record<string, string>>;
  return rows.map((row) => ({
    dedupeKey: row.dedupe_key ?? "",
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
  }));
}

export function clearJobs(db: Database): void {
  db.run("DELETE FROM jobs");
}
