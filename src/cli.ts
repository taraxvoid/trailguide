#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { Command, Option } from "commander";
import { delegateTarget, runDelegate } from "./checkout.ts";
import {
  parseBoundary,
  parseRange,
  truncateWords,
  weekRange,
} from "./dateRange.ts";
import {
  allJobs,
  clearJobs,
  jobsByState,
  jobsInStateBetween,
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
import { tailorOrRegenerate } from "./tailor/index.ts";
import { runTui } from "./tui/index.ts";
import { stripTrackingParams } from "./url.ts";

const INTERNSHIP_PATTERN = /\bintern(?:ship)?s?\b/i;
const GOVMIL_PATTERN =
  /\b(?:Lockheed|Raytheon|Deloitte|Leidos|Offutt|military|warfighter|clearance|DoD|department of defense|department of war|SCI|Top Secret|clearance)\b/i;

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

const LISTING_STATES: ListingState[] = [
  "active",
  "archived",
  "inactive",
  "applied",
];

export interface JobsCliOptions {
  db: string;
  state: string;
  when?: string;
  since?: string;
  until?: string;
  words: number;
}

/** Emits jobs in a state as JSON, filtered by when they entered that state. */
export function runJobs(options: JobsCliOptions, now = new Date()): void {
  if (!LISTING_STATES.includes(options.state as ListingState)) {
    throw new Error(
      `Unknown state "${options.state}". Use one of: ${LISTING_STATES.join(", ")}`,
    );
  }
  const state = options.state as ListingState;
  let from: Date | null = null;
  let to: Date | null = null;
  if (options.when) {
    ({ from, to } = parseRange(options.when, now));
  } else if (options.since || options.until) {
    if (options.since) from = parseBoundary(options.since, now);
    if (options.until) to = parseBoundary(options.until, now);
  } else if (state === "applied") {
    // Default for applied: the last full Sunday-to-Saturday week.
    ({ from, to } = weekRange(now, -1));
  }

  const db = openDb(options.db);
  const jobs = jobsInStateBetween(db, state, from, to).map((job) => ({
    ...job,
    description: truncateWords(job.description, options.words),
  }));
  db.close();
  console.log(JSON.stringify(jobs, null, 2));
}

export interface TailorCliOptions {
  db: string;
  listingId: string;
  resume?: string;
  outputDir?: string;
  ollamaHost?: string;
  ollamaModel?: string;
  fresh?: boolean;
}

export async function runTailor(options: TailorCliOptions): Promise<void> {
  const db = openDb(options.db);
  const result = await tailorOrRegenerate(db, options.listingId, {
    fresh: options.fresh,
    resumePath: options.resume,
    outputDir: options.outputDir,
    ollamaHost: options.ollamaHost,
    ollamaModel: options.ollamaModel,
  });
  db.close();

  for (const warning of result.warnings) console.warn(`warning: ${warning}`);

  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  if (result.action === "regenerated") {
    console.log(`Regenerated from ${result.markdownPath}`);
  } else {
    console.log(`Wrote ${result.markdownPath}`);
  }
  if (result.pdfPath) console.log(`Wrote ${result.pdfPath}`);
}

export function createProgram(
  searchAction: (options: SearchOptions) => Promise<void> = runSearch,
  clearAction: (options: { db: string }) => Promise<void> = runClear,
  refreshAction: (options: { db: string }) => Promise<void> = runRefresh,
  tailorAction: (options: TailorCliOptions) => Promise<void> = runTailor,
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

  program
    .command("jobs")
    .description(
      "Emit stored jobs in a state as JSON, filtered by when they entered that state (applied defaults to last Sunday-Saturday week)",
    )
    .argument("[state]", `one of: ${LISTING_STATES.join(", ")}`, "applied")
    .option(
      "--when <range>",
      'mnemonic range: "today", "yesterday", "this week", "last week", "this month", "last month", "last 7 days"',
    )
    .option("--since <date>", "start (inclusive), e.g. 2026-09-01")
    .option("--until <date>", "end (exclusive), e.g. 2026-09-08")
    .option(
      "--words <n>",
      "truncate descriptions to this many words",
      (v) => Number.parseInt(v, 10),
      200,
    )
    .option("--db <path>", "path to sqlite db", "igor.db")
    .action((stateArg: string, options: Omit<JobsCliOptions, "state">) => {
      try {
        runJobs({ ...options, state: stateArg });
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });

  program
    .command("tailor")
    .description(
      "Tailor your resume (input/<name>.md) to a stored job listing and render a PDF; if the job already has a tailored .md, re-render the PDF from it instead",
    )
    .argument("<listingId>", "listing id, e.g. greenhouse:1234 (see --json)")
    .option("--db <path>", "path to sqlite db", "igor.db")
    .option(
      "--resume <path>",
      "resume master path (default: the one .md file under input/)",
    )
    .option(
      "--output-dir <path>",
      "where to write the tailored .md/.pdf",
      "output/resumes",
    )
    .option(
      "--ollama-host <host>",
      "Ollama host (default: $OLLAMA_HOST or 127.0.0.1:11434)",
    )
    .option(
      "--ollama-model <model>",
      "Ollama model (default: $OLLAMA_MODEL or qwen3:8b)",
    )
    .option(
      "--fresh",
      "re-tailor from the resume master even if a tailored .md already exists (overwrites it)",
      false,
    )
    .action(
      async (
        listingIdArg: string,
        options: {
          db: string;
          resume?: string;
          outputDir?: string;
          ollamaHost?: string;
          ollamaModel?: string;
          fresh?: boolean;
        },
      ) => {
        await tailorAction({ ...options, listingId: listingIdArg });
      },
    );

  return program;
}

async function main() {
  if (shouldShowIgor(Bun.argv)) {
    displayIgor();
  }
  await createProgram().parseAsync(Bun.argv);
}

if (import.meta.main) {
  const delegate = delegateTarget(process.cwd(), dirname(import.meta.dir));
  if (delegate) {
    process.exit(await runDelegate(delegate, Bun.argv.slice(2)));
  }
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
