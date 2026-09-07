#!/usr/bin/env bun
/**
 * Detect GPL kudzu
 *
 * Usage: bun run check:licenses
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const FAIL_ON = [
  "GPL-1.0",
  "GPL-1.0-only",
  "GPL-1.0-or-later",
  "GPL-2.0",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "AGPL-1.0",
  "AGPL-1.0-only",
  "AGPL-1.0-or-later",
  "AGPL-2.0",
  "AGPL-2.0-only",
  "AGPL-2.0-or-later",
  "AGPL-3.0",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "SSPL-1.0",
  "OSL-2.1",
  "OSL-3.0",
  "CPAL-1.0",
  "EUPL-1.1",
  "EUPL-1.2",
  "CECILL-2.1",
  // LGPL is deliberately NOT in this list - it only imposes obligations on
  // modifying/statically linking the library, not on depending on it as-is.
].join(";");

const BIN = join(ROOT, "node_modules", ".bin", "license-checker");

const result = spawnSync(BIN, ["--summary", "--failOn", FAIL_ON], {
  cwd: ROOT,
  stdio: "inherit",
});

if (result.error) {
  console.error(
    `\ncheck:licenses failed - could not run ${BIN}: ${result.error.message}`,
  );
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    "\ncheck:licenses failed - at least one disallowed license was found.",
  );
  process.exit(1);
}

console.log(
  "\ncheck:licenses passed - no blocked licenses found in any workspace.",
);
