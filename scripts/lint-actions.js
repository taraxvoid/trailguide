#!/usr/bin/env bun

// Lints all GitHub Actions workflow YAML files using actionlint (WASM port).
// Replaces the need for a globally-installed actionlint binary.
//
// Usage: bun run lint:actions

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLinter } from "actionlint";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");

const lint = await createLinter();

const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml"));
if (files.length === 0) {
  console.log("lint:actions: no workflow files found");
  process.exit(0);
}

const errors = [];
for (const file of files) {
  const path = join(WORKFLOWS_DIR, file);
  const input = readFileSync(path, "utf8");
  const results = lint(input, path);
  for (const r of results) {
    const severity = r.kind === "warning" ? "⚠" : "✗";
    errors.push(
      `  ${severity} ${path}:${r.line}:${r.column} — ${r.message} (${r.kind})`,
    );
  }
}

if (errors.length === 0) {
  console.log(`lint:actions: all ${files.length} workflow file(s) passed`);
} else {
  console.error(`lint:actions: ${errors.length} issue(s) found:`);
  for (const e of errors) console.error(e);
  process.exit(1);
}
