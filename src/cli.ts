#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { Command, Option } from "commander";
import {
  allJobs,
  clearJobs,
  jobsByState,
  listingId,
  openDb,
  setJobState,
  upsertJobs,
} from "./db.ts";
import type { ListingState } from "./db.ts";
import { dedupe } from "./dedupe.ts";
import { IGOR_DISABLE_FLAG, displayIgor, shouldShowIgor } from "./igorArt.ts";
import { createAdzunaSource } from "./sources/adzuna.ts";
import { createAshbySource } from "./sources/ashby.ts";
import { createGreenhouseSource } from "./sources/greenhouse.ts";
import { createJobApsSource } from "./sources/jobaps.ts";
import { createJSearchSource } from "./sources/jsearch.ts";
import { createLeverSource } from "./sources/lever.ts";
import { createRemoteOkSource } from "./sources/remoteok.ts";
import { createRemotiveSource } from "./sources/remotive.ts";
import type { NormalizedJob, Source } from "./sources/types.ts";
import { createWeWorkRemotelySource } from "./sources/weworkremotely.ts";
import { runTui } from "./tui/index.ts";
import { stripTrackingParams } from "./url.ts";

const INTERNSHIP_PATTERN = /\bintern(?:ship)?s?\b/i;
const GOVMIL_PATTERN =
  /\b(?:Lockheed|Raytheon|Deloitte|Leidos|Offutt|military|warfighter|clearance|DoD|department of defense|department of war)\b/i;

export function isInternship(job: NormalizedJob): boolean {
  return INTERNSHIP_PATTERN.test(job.title);
}

export function requiresClearance(job: NormalizedJob): boolean {
  return (
    GOVMIL_PATTERN.test(job.title) || GOVMIL_PATTERN.test(job.description ?? "")
  );
}

export function buildSources(): Source[] {
  const sources: Source[] = [
    createGreenhouseSource(),
    createLeverSource(),
    createAshbySource(),
    createRemoteOkSource(),
    createRemotiveSource(),
    createWeWorkRemotelySource(),
    createJobApsSource(),
  ];

  if (process.env.JSEARCH_API_KEY) {
    sources.push(createJSearchSource(process.env.JSEARCH_API_KEY));
  }
  if (process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) {
    sources.push(
      createAdzunaSource(process.env.ADZUNA_APP_ID, process.env.ADZUNA_APP_KEY),
    );
  }

  return sources;
}

export interface SearchOptions {
  location?: string[];
  remote?: boolean;
  onsite?: boolean;
  role: string[];
  json: boolean;
  csv: boolean;
  db: string;
  clearance: boolean;
}

export async function runSearch(options: SearchOptions): Promise<void> {
  const sources = buildSources();
  const results = await Promise.all(
    sources.map((source) =>
      source
        .search({
          role: options.role,
          location: options.location,
          remote: options.remote,
          onsite: options.onsite,
        })
        .catch((err) => {
          console.error(
            `[${source.name}] search failed: ${err instanceof Error ? err.message : err}`,
          );
          return [];
        }),
    ),
  );

  const jobs = dedupe(results.flat())
    .filter((job) => !isInternship(job))
    .filter((job) => options.clearance || !requiresClearance(job))
    .filter((job) => {
      if (options.remote && job.remoteType !== "remote") return false;
      if (options.onsite && job.remoteType === "remote") return false;
      return true;
    })
    .map((job) => ({ ...job, url: stripTrackingParams(job.url) }));
  const states = new Map<string, ListingState>();
  await Promise.all(
    jobs.map(async (job) => {
      if (await isUrlDead(job.url)) {
        states.set(listingId(job), "inactive");
      }
    }),
  );
  const db = openDb(options.db);
  const newJobs = upsertJobs(db, jobs, states);

  if (options.json) {
    console.log(JSON.stringify(allJobs(db), null, 2));
  } else if (options.csv) {
    const rows = allJobs(db);
    console.log("title,company,location,remoteType,url");
    for (const job of rows) {
      console.log(
        [job.title, job.company, job.location, job.remoteType, job.url]
          .map((v) => `"${v.replace(/"/g, '""')}"`)
          .join(","),
      );
    }
  } else {
    const newKeys = new Set(newJobs.map((job) => job.listingId));
    for (const job of jobs) {
      const marker = newKeys.has(listingId(job)) ? "NEW" : "   ";
      console.log(
        `${marker} ${job.title} @ ${job.company} (${job.location}, ${job.remoteType}) - ${job.url}`,
      );
    }
    console.log(
      `\n${jobs.length} jobs found (${newJobs.length} new), stored in ${options.db}`,
    );
  }
}

export async function runClear(options: { db: string }): Promise<void> {
  const db = openDb(options.db);
  clearJobs(db);
  db.close();
  console.log(`Cleared all jobs from ${options.db}`);
}

const DEAD_PAGE_PATTERNS = [
  /404/i,
  /page not found/i,
  /not found/i,
  /this page doesn't exist/i,
  /no longer available/i,
  /expired/i,
  /job no longer available/i,
  /this job has been removed/i,
  /position has been filled/i,
  /this listing has expired/i,
];

async function isUrlDead(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (res.status === 404) return true;
    if (res.status === 410) return true;
    if (res.ok) {
      const body = await res.text();
      return DEAD_PAGE_PATTERNS.some((pattern) => pattern.test(body));
    }
  } catch {
    return true;
  }
  return false;
}

export async function refreshListings(db: Database): Promise<{
  checked: number;
  skipped: number;
  activated: number;
  archived: number;
}> {
  const activeJobs = jobsByState(db, "active");
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  let checked = 0;
  let skipped = 0;
  let activated = 0;
  let archived = 0;

  for (const job of activeJobs) {
    const lastChecked = new Date(job.lastCheckedAt).getTime();
    if (lastChecked > cutoff) {
      skipped++;
      continue;
    }
    checked++;
    const dead = await isUrlDead(job.url);
    // A job that dies after having been active is auto-archived rather than
    // left "inactive" - "inactive" is reserved for jobs that were already
    // dead the first time we saw them during search.
    const state: ListingState = dead ? "archived" : "active";
    setJobState(db, job.listingId, state, new Date().toISOString());
    if (dead) archived++;
    else activated++;
  }

  return { checked, skipped, activated, archived };
}

export async function runRefresh(options: { db: string }): Promise<void> {
  const db = openDb(options.db);
  const result = await refreshListings(db);
  db.close();
  console.log(
    `Refreshed ${result.checked} listings (${result.skipped} skipped within 24h): ${result.activated} active, ${result.archived} archived`,
  );
}

export function createProgram(
  searchAction: (options: SearchOptions) => Promise<void> = runSearch,
  clearAction: (options: { db: string }) => Promise<void> = runClear,
  refreshAction: (options: { db: string }) => Promise<void> = runRefresh,
): Command {
  const program = new Command();

  program
    .name("igor")
    .description("A minion to find software engineering jobs")
    .option(IGOR_DISABLE_FLAG, "Disable Igor ASCII art");

  program
    .command("search")
    .description("Search job sources and store results")
    .requiredOption(
      "--role <query...>",
      "role/title to search for (accepts multiple values)",
    )
    .option(
      "--location <city...>",
      "location(s) to search in (accepts multiple values)",
    )
    .option("--remote", "only search for remote jobs", false)
    .option("--onsite", "only search for onsite/hybrid jobs", false)
    .option("--json", "output all stored jobs as JSON", false)
    .option("--csv", "output all stored jobs as CSV", false)
    .option("--db <path>", "path to sqlite db", "igor.db")
    .option("--clearance", "include jobs requiring clearance", false)
    .action(async (options: SearchOptions) => {
      await searchAction(options);
    });

  program
    .command("tui")
    .description("Browse jobs in an interactive TUI")
    .option("--db <path>", "path to sqlite db", "igor.db")
    .action(async (options: { db: string }) => {
      await runTui({ db: options.db });
    });

  program
    .command("clear")
    .description("Clear all stored jobs from the database")
    .option("--db <path>", "path to sqlite db", "igor.db")
    .action(async (options: { db: string }) => {
      await clearAction(options);
    });

  program
    .command("refresh")
    .description("Check all active listings to see if they're still live")
    .option("--db <path>", "path to sqlite db", "igor.db")
    .action(async (options: { db: string }) => {
      await refreshAction(options);
    });

  return program;
}

async function main() {
  if (shouldShowIgor(Bun.argv)) {
    displayIgor();
  }
  await createProgram().parseAsync(Bun.argv);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
