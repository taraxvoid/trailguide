#!/usr/bin/env bun
import type { Database } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { delegateTarget, runDelegate } from "./checkout.ts";
import {
  ConfigError,
  configuredRegions,
  configuredTrails,
  describeConfig,
  loadConfig,
  type RegionEntry,
  resolveBoards,
  resolveDbPath,
  resolveResumeDir,
  TRAIL_PATTERN,
  toSearchOptions,
} from "./config.ts";
import { parseBoundary, parseRange, truncateWords } from "./dateRange.ts";
import type { ListingState } from "./db.ts";
import {
  allJobs,
  clearJobs,
  finishRun,
  finishTailorRun,
  getJob,
  getTailoredResume,
  jobsByState,
  jobsInStateBetween,
  listingId,
  openDb,
  SEARCH_RUN_KEY,
  type StoredJob,
  setJobState,
  setJobTrail,
  startRun,
  startTailorRun,
  upsertJobs,
} from "./db.ts";
import { httpFetch } from "./http.ts";
import { ImportError, importJob } from "./importUrl.ts";
import { type InitOptions, runInit, terminalIO } from "./init.ts";
import { mapLimit } from "./limit.ts";
import type { Env } from "./paths.ts";
import { tagUntaggedJobs, UNASSIGNED } from "./regions.ts";
import {
  collectJobs,
  formatRunMessage,
  isInternship,
  requiresClearance,
  type SearchResult,
} from "./search.ts";
import { createAdzunaSource } from "./sources/adzuna.ts";
import { createAshbySource } from "./sources/ashby.ts";
import type { Board } from "./sources/boards.ts";
import { createGreenhouseSource } from "./sources/greenhouse.ts";
import { createJobApsSource } from "./sources/jobaps.ts";
import { createJSearchSource } from "./sources/jsearch.ts";
import { createLeverSource } from "./sources/lever.ts";
import { createRemoteOkSource } from "./sources/remoteok.ts";
import { createRemotiveSource } from "./sources/remotive.ts";
import { companiesForAts, defaultBoards } from "./sources/seed.ts";
import type { NormalizedJob, Source } from "./sources/types.ts";
import { createWeWorkRemotelySource } from "./sources/weworkremotely.ts";
import { createWorkableSource } from "./sources/workable.ts";
import { createWorkdaySource } from "./sources/workday.ts";
import { tailorOrRegenerate } from "./tailor/index.ts";
import { runTui } from "./tui/index.ts";

// Re-exported so existing importers (tests/cli.test.ts) keep working.
export { isInternship, requiresClearance };

export function buildSources(boards: Board[] = defaultBoards): Source[] {
  const sources: Source[] = [
    createGreenhouseSource(companiesForAts("greenhouse", boards)),
    createLeverSource(companiesForAts("lever", boards)),
    createAshbySource(companiesForAts("ashby", boards)),
    createRemoteOkSource(),
    createRemotiveSource(),
    createWeWorkRemotelySource(),
    createJobApsSource(),
    createWorkdaySource(companiesForAts("workday", boards)),
    createWorkableSource(companiesForAts("workable", boards)),
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
  /** When given, the flags are the whole search and the config is not read. */
  role?: string[];
  json: boolean;
  csv: boolean;
  db?: string;
  config?: string;
  excludeClearance?: boolean;
  includeClearance?: boolean;
  /** Search only these regions (default: all). */
  region?: string[];
}

export interface SearchDeps {
  sources?: Source[];
  isUrlDead?: (url: string) => Promise<boolean>;
  cwd?: string;
  env?: Env;
}

/** The configured regions, or none when the config is missing or broken. */
function configuredRegionsOrNone(
  config: string | undefined,
  cwd: string,
  env: Env,
) {
  try {
    return configuredRegions(loadConfig({ config, cwd, env }).config);
  } catch {
    return [];
  }
}

/**
 * Runs a search and records it as the db's single `search` run, so a manual
 * run shows in the TUI and a second concurrent one is refused. Returns null
 * when refused.
 */
export async function runSearch(
  options: SearchOptions,
  deps: SearchDeps = {},
): Promise<SearchResult | null> {
  // Validated before the run claim so a typo cannot overwrite the previous
  // search row with a failed run.
  if (options.remote && options.onsite) {
    throw new ConfigError("--remote and --onsite are mutually exclusive");
  }
  if (options.excludeClearance && options.includeClearance) {
    throw new ConfigError(
      "--exclude-clearance and --include-clearance are mutually exclusive",
    );
  }
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  // With --db (the TUI always passes it) this reads no config, so a config
  // error below is recorded on the run instead of escaping before the claim.
  const dbPath = resolveDbPath({
    db: options.db,
    config: options.config,
    cwd,
    env,
  });
  const db = openDb(dbPath);
  if (!startRun(db, "search", SEARCH_RUN_KEY, process.pid)) {
    db.close();
    console.error("error: search already running");
    process.exitCode = 1;
    return null;
  }

  let jobs: NormalizedJob[] = [];
  let newJobs: StoredJob[] = [];
  let stored: StoredJob[] = [];
  let result: SearchResult;
  try {
    const plan = toSearchOptions(options, () =>
      loadConfig({ config: options.config, cwd, env }),
    );
    const sources =
      deps.sources ??
      buildSources(
        resolveBoards(loadConfig({ config: options.config, cwd, env }).config),
      );
    const collected = await collectJobs(plan, sources);
    jobs = collected.jobs;
    const deadCheck = deps.isUrlDead ?? isUrlDead;
    const states = new Map<string, ListingState>();
    await mapLimit(jobs, URL_CHECK_CONCURRENCY, async (job) => {
      if (await deadCheck(job.url)) states.set(listingId(job), "inactive");
    });
    newJobs = upsertJobs(db, jobs, states);
    // Jobs found without a region (--location, --role) get one from their
    // place when a config with regions exists.
    tagUntaggedJobs(db, configuredRegionsOrNone(options.config, cwd, env));
    if (options.json || options.csv) stored = allJobs(db);
    result = {
      found: jobs.length,
      new: newJobs.length,
      failures: collected.failures,
    };
    finishRun(
      db,
      "search",
      SEARCH_RUN_KEY,
      !collected.allFailed,
      formatRunMessage(result),
    );
    if (collected.allFailed) process.exitCode = 1;
  } catch (err) {
    finishRun(
      db,
      "search",
      SEARCH_RUN_KEY,
      false,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  } finally {
    db.close();
  }

  if (options.json) {
    console.log(JSON.stringify(stored, null, 2));
  } else if (options.csv) {
    console.log("title,company,location,remoteType,url");
    for (const job of stored) {
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
      `\n${jobs.length} jobs found (${newJobs.length} new), stored in ${dbPath}`,
    );
  }
  return result;
}

export async function runClear(options: { db?: string }): Promise<void> {
  const dbPath = resolveDbPath({ db: options.db });
  const db = openDb(dbPath);
  clearJobs(db);
  db.close();
  console.log(`Cleared all jobs from ${dbPath}`);
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

/** Listing URLs checked at once, by search and refresh. */
const URL_CHECK_CONCURRENCY = 8;
const URL_CHECK_TIMEOUT_MS = 15_000;

async function isUrlDead(url: string): Promise<boolean> {
  try {
    const res = await httpFetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(URL_CHECK_TIMEOUT_MS),
    });
    if (res.status === 404) return true;
    if (res.status === 410) return true;
    if (res.ok) {
      const body = await res.text();
      return DEAD_PAGE_PATTERNS.some((pattern) => pattern.test(body));
    }
  } catch (err) {
    // A slow host is not a dead listing; anything else (DNS, refused) is.
    return !(err instanceof DOMException && err.name === "TimeoutError");
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

  const due = activeJobs.filter(
    (job) => new Date(job.lastCheckedAt).getTime() <= cutoff,
  );
  skipped = activeJobs.length - due.length;
  await mapLimit(due, URL_CHECK_CONCURRENCY, async (job) => {
    checked++;
    const dead = await isUrlDead(job.url);
    // A job that dies after having been active is auto-archived rather than
    // left "inactive" - "inactive" is reserved for jobs that were already
    // dead the first time we saw them during search.
    const state: ListingState = dead ? "archived" : "active";
    setJobState(db, job.listingId, state, new Date().toISOString());
    if (dead) archived++;
    else activated++;
  });

  return { checked, skipped, activated, archived };
}

export interface TrailCliOptions {
  listingId: string;
  trail?: string;
  clear?: boolean;
  db?: string;
  config?: string;
}

/** The value `--trail` takes for "import with no trail". */
const NO_TRAIL = "none";

/**
 * Turns `--trail` (or, in a terminal, an answer to `ask`) into a trail, or
 * null for `none`. Settled before anything is fetched.
 */
export async function resolveTrailChoice(
  value: string | undefined,
  trails: string[],
  ask?: (choices: string[], hint?: string) => Promise<string>,
): Promise<string | null> {
  const choices = [...trails, NO_TRAIL];
  const pick = (v: string) => (v === NO_TRAIL ? null : v);
  if (value !== undefined) {
    if (!choices.includes(value)) {
      throw new ConfigError(
        `trail ${JSON.stringify(value)} isn't configured; use one of: ${choices.join(", ")}`,
      );
    }
    return pick(value);
  }
  if (!ask) {
    throw new ConfigError(
      `--trail is required when not running in a terminal; use one of: ${choices.join(", ")}`,
    );
  }
  let hint: string | undefined;
  for (;;) {
    const answer = (await ask(choices, hint)).trim();
    // Enter alone, or end of input (Ctrl+D), backs out.
    if (answer === "") {
      throw new ConfigError("no trail chosen; nothing imported");
    }
    const byNumber = choices[Number(answer) - 1];
    if (/^\d+$/.test(answer) && byNumber) return pick(byNumber);
    if (choices.includes(answer)) return pick(answer);
    hint = `pick 1-${choices.length} or a trail name`;
  }
}

/**
 * Numbered trail prompt on the terminal, for `trailguide add` without
 * `--trail`. End of input answers "".
 */
async function askTrail(choices: string[], hint?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<string>((resolve) =>
    rl.once("close", () => resolve("")),
  );
  try {
    const list = choices.map((c, i) => `  ${i + 1}) ${c}`).join("\n");
    const question = hint ? `${hint}\n> ` : `Trail for this job:\n${list}\n> `;
    return await Promise.race([rl.question(question), closed]);
  } finally {
    rl.close();
  }
}

export interface AddCliOptions {
  url: string;
  trail?: string;
  db?: string;
  config?: string;
  /** Region for a job whose location matches none (default: the first). */
  region?: string;
}

export async function runAdd(
  options: AddCliOptions,
  deps: {
    ask?: (choices: string[]) => Promise<string>;
    importJob?: typeof importJob;
  } = { ask: process.stdin.isTTY ? askTrail : undefined },
): Promise<void> {
  const ctx = { db: options.db, config: options.config };
  try {
    const { config } = loadConfig(ctx);
    const regions = configuredRegions(config);
    if (options.region !== undefined) assertRegion(options.region, regions);
    const trail = await resolveTrailChoice(
      options.trail,
      configuredTrails(config),
      deps.ask,
    );
    const db = openDb(resolveDbPath(ctx));
    try {
      const { job, added } = await (deps.importJob ?? importJob)(
        db,
        options.url,
        trail,
        resolveBoards(config),
        regions,
        options.region ?? regions[0]?.name,
      );
      console.log(
        `${added ? "Added" : "Already tracked"} ${job.listingId}: ${job.title} @ ${job.company} (${job.location}), ${job.trail ? `trail ${job.trail}` : "no trail"}`,
      );
    } finally {
      db.close();
    }
  } catch (err) {
    if (!(err instanceof ConfigError || err instanceof ImportError)) throw err;
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}

export function runTrail(options: TrailCliOptions): void {
  if (options.trail && options.clear) {
    throw new ConfigError("pass a trail or --clear, not both");
  }
  if (options.trail && !TRAIL_PATTERN.test(options.trail)) {
    throw new ConfigError(
      `trail ${JSON.stringify(options.trail)} must be lowercase letters, digits, - or _`,
    );
  }
  const db = openDb(resolveDbPath({ db: options.db, config: options.config }));
  try {
    const job = getJob(db, options.listingId);
    if (!job) {
      console.error(`error: no job found with id ${options.listingId}`);
      process.exitCode = 1;
      return;
    }
    if (!options.trail && !options.clear) {
      console.log(job.trail ?? "(no trail)");
      return;
    }
    const trail = options.clear ? null : (options.trail ?? null);
    setJobTrail(db, options.listingId, trail);
    console.log(
      trail
        ? `${options.listingId}: trail ${trail}`
        : `${options.listingId}: trail cleared`,
    );
  } finally {
    db.close();
  }
}

export async function runRefresh(options: { db?: string }): Promise<void> {
  const db = openDb(resolveDbPath({ db: options.db }));
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
  db?: string;
  state: string;
  when?: string;
  since?: string;
  until?: string;
  words: number;
  /** Only jobs in this region (`unassigned`: jobs in none). */
  region?: string;
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
  }

  const db = openDb(resolveDbPath({ db: options.db }));
  const region = options.region;
  const inRegion = (regions: string[]) =>
    region === undefined ||
    (region === UNASSIGNED ? regions.length === 0 : regions.includes(region));
  const jobs = jobsInStateBetween(db, state, from, to)
    .filter((job) => inRegion(job.regions))
    .map((job) => ({
      ...job,
      description: truncateWords(job.description, options.words),
    }));
  db.close();
  console.log(JSON.stringify(jobs, null, 2));
}

/** An error naming the configured regions when `name` is not one of them. */
function assertRegion(name: string, regions: RegionEntry[]): void {
  if (!regions.some((r) => r.name === name)) {
    throw new ConfigError(
      `unknown region ${JSON.stringify(name)} (configured: ${regions.map((r) => r.name).join(", ") || "none"})`,
    );
  }
}

/**
 * The region whose resume masters a tailor run uses: --region, else the
 * job's first region in config order, else none (the plain resume dir).
 */
export function chooseTailorRegion(
  jobRegions: string[],
  regions: RegionEntry[],
  flag?: string,
): string | undefined {
  if (flag !== undefined) {
    assertRegion(flag, regions);
    return flag;
  }
  return regions.find((r) => jobRegions.includes(r.name))?.name;
}

export interface TailorCliOptions {
  db?: string;
  config?: string;
  listingId: string;
  resume?: string;
  outputDir?: string;
  ollamaHost?: string;
  ollamaModel?: string;
  fresh?: boolean;
  /** Use this region's resume masters (default: the job's first region). */
  region?: string;
}

export async function runTailor(options: TailorCliOptions): Promise<void> {
  const db = openDb(resolveDbPath({ db: options.db, config: options.config }));
  if (!startTailorRun(db, options.listingId, process.pid)) {
    db.close();
    console.error(
      `error: a tailor run for ${options.listingId} is already in progress`,
    );
    process.exitCode = 1;
    return;
  }
  let result: Awaited<ReturnType<typeof tailorOrRegenerate>>;
  try {
    const ctx = { config: options.config };
    const region = chooseTailorRegion(
      getJob(db, options.listingId)?.regions ?? [],
      configuredRegions(loadConfig(ctx).config),
      options.region,
    );
    result = await tailorOrRegenerate(db, options.listingId, {
      fresh: options.fresh,
      resumePath: options.resume,
      resumeDir: options.resume ? undefined : resolveResumeDir(ctx, region),
      outputDir: options.outputDir,
      ollamaHost: options.ollamaHost,
      ollamaModel: options.ollamaModel,
      region,
    });
  } catch (err) {
    finishTailorRun(db, options.listingId, false, (err as Error).message);
    db.close();
    throw err;
  }
  const warningSuffix =
    result.warnings.length > 0 ? ` (${result.warnings.join("; ")})` : "";
  if (result.ok) {
    const verb = result.action === "regenerated" ? "Regenerated" : "Wrote";
    const usedRegion = getTailoredResume(db, options.listingId)?.region;
    finishTailorRun(
      db,
      options.listingId,
      true,
      `${verb} ${result.pdfPath ?? result.markdownPath}${usedRegion ? ` (${usedRegion} resume)` : ""}${warningSuffix}`,
    );
  } else {
    finishTailorRun(
      db,
      options.listingId,
      false,
      `${result.error}${warningSuffix}`,
    );
  }
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

const DB_HELP =
  "path to sqlite db (default: [db] path from the config, else the global db; see `trailguide config`)";
const CONFIG_HELP =
  "config file to use instead of the global config plus ./trailguide.toml";

/** Commander reducer for repeatable options. */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function createProgram(
  searchAction: (options: SearchOptions) => Promise<unknown> = runSearch,
  clearAction: (options: { db?: string }) => Promise<void> = runClear,
  refreshAction: (options: { db?: string }) => Promise<void> = runRefresh,
  tailorAction: (options: TailorCliOptions) => Promise<void> = runTailor,
  addAction: (options: AddCliOptions) => Promise<void> = runAdd,
): Command {
  const program = new Command();

  program
    .name("trailguide")
    .description(
      "Job search and resume tailoring that only rearranges what you've already written",
    )
    .version(pkg.version);

  program
    .command("search")
    .description(
      "Search job sources (from the config, or --role) and store results",
    )
    .option(
      "--role <query...>",
      "role/title to search for (accepts multiple values); omit to use the config's [[keywords]]",
    )
    .option(
      "--location <city...>",
      "location(s) to search in (accepts multiple values)",
    )
    .option(
      "--region <name...>",
      "search only these [region.<name>] regions (default: all)",
    )
    .option("--remote", "only search for remote jobs", false)
    .option("--onsite", "only search for onsite/hybrid jobs", false)
    .option("--json", "output all stored jobs as JSON", false)
    .option("--csv", "output all stored jobs as CSV", false)
    .option("--db <path>", DB_HELP)
    .option("--config <path>", CONFIG_HELP)
    .option(
      "--exclude-clearance",
      "drop jobs that require a security clearance",
    )
    .option(
      "--include-clearance",
      "keep jobs that require a clearance, even if the config excludes them",
    )
    .action(async (options: SearchOptions) => {
      await searchAction(options);
    });

  program
    .command("tui")
    .description("Browse jobs in an interactive TUI")
    .option("--db <path>", DB_HELP)
    .option("--config <path>", CONFIG_HELP)
    .action(async (options: { db?: string; config?: string }) => {
      // The TUI resolves paths only; the spawned search reads the settings.
      const config =
        options.config ?? (process.env.TRAILGUIDE_CONFIG || undefined);
      await runTui({
        db: resolveDbPath({ db: options.db, config }),
        config: config ? resolve(config) : undefined,
      });
    });

  program
    .command("clear")
    .description("Clear all stored jobs from the database")
    .option("--db <path>", DB_HELP)
    .action(async (options: { db?: string }) => {
      await clearAction(options);
    });

  program
    .command("refresh")
    .description("Check all active listings to see if they're still live")
    .option("--db <path>", DB_HELP)
    .action(async (options: { db?: string }) => {
      await refreshAction(options);
    });

  program
    .command("jobs")
    .description(
      "Emit stored jobs in a state as JSON, optionally filtered by when they entered that state",
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
    .option(
      "--region <name>",
      'only jobs in this region ("unassigned": jobs in none)',
    )
    .option("--db <path>", DB_HELP)
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
      "Tailor your resume (<trail>.md from the resume dir) to a stored job listing and render a PDF; if the job already has a tailored .md, re-render the PDF from it instead",
    )
    .argument("<listingId>", "listing id, e.g. greenhouse:1234 (see --json)")
    .option("--db <path>", DB_HELP)
    .option("--config <path>", CONFIG_HELP)
    .option(
      "--resume <path>",
      "resume master path (default: the job's <trail>.md, else default.md or the one .md in the resume dir)",
    )
    .option(
      "--output-dir <path>",
      "where to write the tailored .md/.pdf (default: ~/.local/share/trailguide/resumes)",
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
    .option(
      "--region <name>",
      "use this region's resume folder (default: the job's first region)",
    )
    .action(
      async (
        listingIdArg: string,
        options: {
          db?: string;
          config?: string;
          resume?: string;
          outputDir?: string;
          ollamaHost?: string;
          ollamaModel?: string;
          fresh?: boolean;
          region?: string;
        },
      ) => {
        await tailorAction({ ...options, listingId: listingIdArg });
      },
    );

  program
    .command("add")
    .description(
      "Import one job from a link (a job board posting or any page with schema.org JobPosting data), skipping search filters",
    )
    .argument("<url>", "link to a single job posting")
    .option(
      "--trail <trail>",
      'resume trail for the job, or "none" (asked in a terminal; required otherwise)',
    )
    .option(
      "--region <name>",
      "region for a job whose location matches none (default: the first)",
    )
    .option("--db <path>", DB_HELP)
    .option("--config <path>", CONFIG_HELP)
    .action(
      async (
        url: string,
        options: {
          trail?: string;
          db?: string;
          config?: string;
          region?: string;
        },
      ) => {
        await addAction({ ...options, url });
      },
    );

  program
    .command("trail")
    .description(
      "Show a job's resume trail, set it, or clear it with --clear (tailor uses <trail>.md)",
    )
    .argument("<listingId>", "listing id, e.g. greenhouse:1234 (see --json)")
    .argument("[trail]", "trail to set")
    .option("--clear", "remove the job's trail", false)
    .option("--db <path>", DB_HELP)
    .option("--config <path>", CONFIG_HELP)
    .action(
      (
        listingIdArg: string,
        trail: string | undefined,
        options: { clear?: boolean; db?: string; config?: string },
      ) => {
        runTrail({ ...options, listingId: listingIdArg, trail });
      },
    );

  program
    .command("config")
    .description(
      "Show the config files in use, the database path, and the merged config",
    )
    .option("--config <path>", CONFIG_HELP)
    .action((options: { config?: string }) => {
      console.log(describeConfig({ config: options.config }));
    });

  program
    .command("init")
    .description(
      "Create the global config and database, prompting for locations, keywords, and work type",
    )
    .option(
      "--location <place>",
      "a location to search; repeat for more (skips the prompt)",
      collect,
    )
    .option(
      "--keywords <role>",
      "a role to search for; repeat for more (skips the prompt)",
      collect,
    )
    .option(
      "--work <type>",
      "remote, in-person, or any for every location, or <location>:<type> for one; repeatable (skips the prompt)",
      collect,
    )
    .option("--db <path>", DB_HELP)
    .option("-y, --yes", "overwrite an existing global config without asking")
    .action(async (options: InitOptions) => {
      const io = terminalIO();
      try {
        await runInit(options, io);
      } finally {
        io.close();
      }
    });

  return program;
}

async function main() {
  await createProgram().parseAsync(Bun.argv);
}

if (import.meta.main) {
  const delegate = delegateTarget(process.cwd(), dirname(import.meta.dir));
  if (delegate) {
    process.exit(await runDelegate(delegate, Bun.argv.slice(2)));
  }
  main().catch((err) => {
    // Config and link problems are user errors: print the message, not a stack.
    console.error(
      err instanceof ConfigError || err instanceof ImportError
        ? `error: ${err.message}`
        : err,
    );
    process.exit(1);
  });
}
