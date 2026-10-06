import type { Database } from "bun:sqlite";
import { closeSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NO_DELEGATE_ENV } from "../checkout.ts";
import {
  exitedUnexpectedly,
  type Run,
  runningRuns,
  SEARCH_RUN_KEY,
  startRun,
} from "../db.ts";
import { IGOR_DISABLE_FLAG } from "../igorArt.ts";

export interface SpawnRequest {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdio: ["ignore", number, number];
  detached: true;
}

export interface SpawnedProcess {
  pid: number;
  unref(): void;
  /** Used to reap the child when its run could not be recorded. */
  kill?(): void;
}

export type SpawnFn = (request: SpawnRequest) => SpawnedProcess;

const defaultSpawn: SpawnFn = (request) =>
  Bun.spawn({ ...request, stdio: [...request.stdio] });

/** The detached search's stdout and stderr, next to the db. */
export function searchLogPath(dbPath: string): string {
  return join(dirname(dbPath), "igor-search.log");
}

export interface BackgroundSearchOptions {
  db: Database;
  dbPath: string;
  /** Only an explicit config (--config or IGOR_CONFIG) is forwarded. */
  configPath?: string;
  cwd?: string;
  spawn?: SpawnFn;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts a detached `igor search` that outlives the TUI. The TUI only
 * resolves paths; the child reads the search settings and reports any
 * problem through its run row. Never throws: failures come back as a
 * refusal, with no orphaned child and no claimed run row.
 */
export function startBackgroundSearch(options: BackgroundSearchOptions): {
  started: boolean;
  message: string;
} {
  const { db, spawn = defaultSpawn } = options;
  const cwd = options.cwd ?? process.cwd();
  const fail = (error: unknown) => ({
    started: false,
    message: `could not start search: ${errorText(error)}`,
  });
  try {
    if (runningRuns(db, "search").length > 0) {
      return { started: false, message: "search already running" };
    }
    const dbPath = resolve(cwd, options.dbPath);
    const logPath = searchLogPath(dbPath);
    // "w" truncates, so the log holds only the latest run.
    const log = openSync(logPath, "w");
    let child: SpawnedProcess;
    try {
      // IGOR_NO_DELEGATE keeps the recorded pid the real worker rather than a
      // checkout-delegating wrapper.
      child = spawn({
        cmd: [
          process.execPath,
          `${import.meta.dir}/../cli.ts`,
          IGOR_DISABLE_FLAG,
          "search",
          "--db",
          dbPath,
          ...(options.configPath
            ? ["--config", resolve(cwd, options.configPath)]
            : []),
        ],
        cwd,
        env: { ...process.env, [NO_DELEGATE_ENV]: "1" },
        stdio: ["ignore", log, log],
        detached: true,
      });
    } finally {
      // The child has its own copy of the descriptor.
      closeSync(log);
    }
    child.unref();
    // Record the child's pid now so the indicator shows immediately.
    let claimed = false;
    let claimError: unknown;
    try {
      claimed = startRun(db, "search", SEARCH_RUN_KEY, child.pid, undefined, {
        forChild: true,
      });
    } catch (error) {
      claimError = error;
    }
    if (!claimed) {
      try {
        child.kill?.();
      } catch {
        // already gone
      }
      return claimError === undefined
        ? { started: false, message: "search already running" }
        : fail(claimError);
    }
    return {
      started: true,
      message: `Searching in the background (survives quitting); log: ${logPath}`,
    };
  } catch (error) {
    return fail(error);
  }
}

export function describeSearchRun(run: Run, dbPath: string): string {
  const message = run.message ?? "";
  if (run.ok) return `Search done: ${message}`;
  const hint =
    message === exitedUnexpectedly("search")
      ? ` (see ${searchLogPath(resolve(dbPath))})`
      : "";
  return `Search failed: ${message}${hint}`;
}
