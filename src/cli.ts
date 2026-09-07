#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { allJobs, openDb, upsertJobs } from "./db.ts";
import { dedupe, dedupeKey } from "./dedupe.ts";
import { createAdzunaSource } from "./sources/adzuna.ts";
import { createGreenhouseSource } from "./sources/greenhouse.ts";
import { createJSearchSource } from "./sources/jsearch.ts";
import { createLeverSource } from "./sources/lever.ts";
import type { NormalizedJob, RemoteType, Source } from "./sources/types.ts";

const INTERNSHIP_PATTERN = /\bintern(?:ship)?s?\b/i;
const CLEARANCE_PATTERN = /\bclearance\b/i;

function isInternship(job: NormalizedJob): boolean {
  return INTERNSHIP_PATTERN.test(job.title);
}

function requiresClearance(job: NormalizedJob): boolean {
  return (
    CLEARANCE_PATTERN.test(job.title) ||
    CLEARANCE_PATTERN.test(job.description ?? "")
  );
}

function buildSources(): Source[] {
  const sources: Source[] = [createGreenhouseSource(), createLeverSource()];

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

function isRemoteType(value: string): value is RemoteType {
  return value === "remote" || value === "hybrid" || value === "onsite";
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      location: { type: "string" },
      remote: { type: "string" },
      role: { type: "string" },
      json: { type: "boolean", default: false },
      csv: { type: "boolean", default: false },
      db: { type: "string", default: "igor.db" },
      clearance: { type: "boolean", default: false },
    },
  });

  const command = positionals[0];
  if (command !== "search") {
    console.error(
      "Usage: igor search --role <query> [--location <city>] [--remote remote|hybrid|onsite] [--clearance]",
    );
    process.exit(1);
  }

  if (!values.role) {
    console.error("--role is required");
    process.exit(1);
  }
  if (values.remote && !isRemoteType(values.remote)) {
    console.error("--remote must be one of: remote, hybrid, onsite");
    process.exit(1);
  }

  const sources = buildSources();
  const results = await Promise.all(
    sources.map((source) =>
      source
        .search({
          role: values.role as string,
          location: values.location,
          remote: values.remote as RemoteType | undefined,
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
    .filter((job) => values.clearance || !requiresClearance(job));
  const db = openDb(values.db as string);
  const newJobs = upsertJobs(db, jobs);

  if (values.json) {
    console.log(JSON.stringify(allJobs(db), null, 2));
  } else if (values.csv) {
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
      `\n${jobs.length} jobs found (${newJobs.length} new), stored in ${values.db}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
