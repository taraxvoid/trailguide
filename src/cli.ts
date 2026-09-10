#!/usr/bin/env bun
import { Command, Option } from "commander";
import { allJobs, openDb, upsertJobs } from "./db.ts";
import { dedupe, dedupeKey } from "./dedupe.ts";
import { createAdzunaSource } from "./sources/adzuna.ts";
import { createAshbySource } from "./sources/ashby.ts";
import { createGreenhouseSource } from "./sources/greenhouse.ts";
import { createJSearchSource } from "./sources/jsearch.ts";
import { createLeverSource } from "./sources/lever.ts";
import type { NormalizedJob, RemoteType, Source } from "./sources/types.ts";

const INTERNSHIP_PATTERN = /\bintern(?:ship)?s?\b/i;
const CLEARANCE_PATTERN =
  /\b(?:clearance|DoD|department of defense|department of war)\b/i;

export function isInternship(job: NormalizedJob): boolean {
  return INTERNSHIP_PATTERN.test(job.title);
}

export function requiresClearance(job: NormalizedJob): boolean {
  return (
    CLEARANCE_PATTERN.test(job.title) ||
    CLEARANCE_PATTERN.test(job.description ?? "")
  );
}

export function buildSources(): Source[] {
  const sources: Source[] = [
    createGreenhouseSource(),
    createLeverSource(),
    createAshbySource(),
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
  location?: string;
  remote?: RemoteType;
  role: string;
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
    .filter((job) => options.clearance || !requiresClearance(job));
  const db = openDb(options.db);
  const newJobs = upsertJobs(db, jobs);

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
    const newKeys = new Set(newJobs.map((job) => job.dedupeKey));
    for (const job of jobs) {
      const marker = newKeys.has(dedupeKey(job)) ? "NEW" : "   ";
      console.log(
        `${marker} ${job.title} @ ${job.company} (${job.location}, ${job.remoteType}) - ${job.url}`,
      );
    }
    console.log(
      `\n${jobs.length} jobs found (${newJobs.length} new), stored in ${options.db}`,
    );
  }
}

export function createProgram(
  searchAction: (options: SearchOptions) => Promise<void> = runSearch,
): Command {
  const program = new Command();

  program
    .name("igor")
    .description("A minion to find software engineering jobs");

  program
    .command("search")
    .description("Search job sources and store results")
    .requiredOption("--role <query>", "role/title to search for")
    .option("--location <city>", "location to search in")
    .addOption(
      new Option("--remote <type>", "remote|hybrid|onsite").choices([
        "remote",
        "hybrid",
        "onsite",
      ]),
    )
    .option("--json", "output all stored jobs as JSON", false)
    .option("--csv", "output all stored jobs as CSV", false)
    .option("--db <path>", "path to sqlite db", "igor.db")
    .option("--clearance", "include jobs requiring clearance", false)
    .action(async (options: SearchOptions) => {
      await searchAction(options);
    });

  return program;
}

async function main() {
  await createProgram().parseAsync(Bun.argv);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
