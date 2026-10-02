import { render } from "ink";
import React from "react";
import { openDb } from "../db.ts";
import { formatGitVersion, gitVersion } from "../version.ts";
import JobBrowser from "./App.tsx";

export interface TuiOptions {
  db: string;
}

export async function runTui(options: TuiOptions): Promise<void> {
  const db = openDb(options.db);
  const git = gitVersion();
  const version = git ? formatGitVersion(git) : null;

  const { waitUntilExit } = render(
    React.createElement(JobBrowser, { db, dbPath: options.db, version }),
    { exitOnCtrlC: true },
  );

  await waitUntilExit();
  db.close();
}
