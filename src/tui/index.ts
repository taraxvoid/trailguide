import { render } from "ink";
import React from "react";
import { allJobs, openDb } from "../db.ts";
import JobBrowser from "./App.tsx";

export interface TuiOptions {
  db: string;
}

export async function runTui(options: TuiOptions): Promise<void> {
  const db = openDb(options.db);
  const jobs = allJobs(db);

  const { unmount, waitUntilExit } = render(
    React.createElement(JobBrowser, { jobs }),
    { exitOnCtrlC: true },
  );

  await waitUntilExit();
  db.close();
}
