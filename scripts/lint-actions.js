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

let files;
try {
  files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml"));
} catch (err) {
  if (err.code === "ENOENT") {
    console.log(
      `lint:actions: no workflow directory at ${WORKFLOWS_DIR}, skipping`,
    );
    process.exit(0);
  }
  throw err;
}

if (files.length === 0) {
  console.log("lint:actions: no workflow files found");
  process.exit(0);
}

const errors = [];
const warnings = [];
for (const file of files) {
  const path = join(WORKFLOWS_DIR, file);
  const input = readFileSync(path, "utf8");
  let results;
  try {
    results = lint(input, path);
  } catch (err) {
    // The actionlint WASM module throws a RuntimeError (a C++ exception)
    // on unrecoverable YAML/parsing errors such as malformed indentation.
    errors.push(
      `  ✗ ${path} — actionlint could not parse this file (${err.message || err}). Check indentation and YAML syntax.`,
    );
    continue;
  }
  for (const r of results) {
    const line = `  ${r.kind === "warning" ? "⚠" : "✗"} ${path}:${r.line}:${r.column} — ${r.message} (${r.kind})`;
    // actionlint's "warning" kind covers shellcheck-style style nits that
    // aren't wrong workflow syntax — only "error" should block the gate.
    (r.kind === "warning" ? warnings : errors).push(line);
  }
}

if (warnings.length > 0) {
  console.warn(`lint:actions: ${warnings.length} warning(s) (non-blocking):`);
  for (const w of warnings) console.warn(w);
}

if (errors.length === 0) {
  console.log(`lint:actions: all ${files.length} workflow file(s) passed`);
} else {
  console.error(`lint:actions: ${errors.length} error(s) found:`);
  for (const e of errors) console.error(e);
  process.exit(1);
}
