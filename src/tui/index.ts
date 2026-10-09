import { render } from "ink";
import React from "react";
import { openDb } from "../db.ts";
import { formatGitVersion, gitVersion } from "../version.ts";
import JobBrowser from "./App.tsx";

export interface TuiOptions {
  /** Absolute db path (from resolveDbPath). */
  db: string;
  /** Explicit config file, forwarded to detached `trailguide search` children. */
  config?: string;
}

export async function runTui(options: TuiOptions): Promise<void> {
  const db = openDb(options.db);
  const git = gitVersion();
  const version = git ? formatGitVersion(git) : null;

  const { waitUntilExit } = render(
    React.createElement(JobBrowser, {
      db,
      dbPath: options.db,
      configPath: options.config,
      version,
    }),
    { exitOnCtrlC: true },
  );

  await waitUntilExit();
  db.close();
}
