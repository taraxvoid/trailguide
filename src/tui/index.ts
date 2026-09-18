import { render } from "ink";
import React from "react";
import { openDb } from "../db.ts";
import JobBrowser from "./App.tsx";

export interface TuiOptions {
  db: string;
}

export async function runTui(options: TuiOptions): Promise<void> {
  const db = openDb(options.db);

  const { unmount, waitUntilExit } = render(
    React.createElement(JobBrowser, { db }),
    { exitOnCtrlC: true },
  );

  await waitUntilExit();
  db.close();
}
