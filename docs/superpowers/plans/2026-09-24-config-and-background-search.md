# TOML Config and Background Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a TOML config (global plus local override), `igor init`, and a Ctrl+S TUI search that runs as a detached `igor search` process tracked in a generalized `runs` table.

**Architecture:** A pure `config.ts` (parse, validate, merge, group) sits under an IO layer `settings.ts` (file chain, env, db path). `tailor_runs` becomes a generic `runs(kind, key)` table; `igor search` claims a `search` run, records its summary, and the TUI only spawns it and polls the table. Per-location `flexibility` splits a search into up to three `SearchParams` groups that reuse the existing sources unchanged.

**Tech Stack:** Bun 1.4 (`Bun.TOML.parse`, `bun:sqlite`, `bun test`), commander, Ink 7 (React 19), biome, TypeScript strict with `noUncheckedIndexedAccess`.

**Spec:** `docs/superpowers/specs/2026-09-24-config-and-background-search-design.md`

## Global Constraints

- Use `bun` for everything (`bun test`, `bun run typecheck`, `bunx @biomejs/biome ...`); no npm/node commands. No new dependencies (TOML comes from `Bun.TOML.parse`).
- Config files: global `${XDG_CONFIG_HOME:-~/.config}/igor/config.toml`; local `./igor.toml` merged over it. DB default `${XDG_DATA_HOME:-~/.local/share}/igor/igor.db`. Hard switch: no fallback to `./igor.db`.
- Config keys: `[job] govmil`, `[db] path`, `[[location]] city` + `flexibility` (`"remote" | "in-person" | "any"`, default `"any"`), `[[keywords]] role`. At least one location and one keyword are required for a search.
- `[[location]]` and `[[keywords]]` in a local file replace the global lists (never concatenate). `[job]` scalars override per key.
- Precedence, high to low: CLI flags, `IGOR_*` env (`IGOR_DB`, `IGOR_CONFIG`), local `igor.toml`, global `config.toml`, defaults. `--config <path>` (or `IGOR_CONFIG`) replaces the whole file chain.
- `runs` table: `PRIMARY KEY (kind, key)`; `kind` is `tailor` (key = listing id) or `search` (key = `search`).
- Every commit must leave `bun run typecheck` passing (the pre-commit hook runs project-wide `tsc`) and biome clean: run `bunx @biomejs/biome check --write <changed files>` before committing.
- Commit only on this worktree branch. Commit messages end with the trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` (pass it as a second `-m`).
- Prefer quiet output: pipe test runs through `2>&1 | tail -15`.
- Prose in docs and comments: no em dashes, no unicode arrows, no filler words.

## Review Focus

Inputs the spec implies but a plain happy-path test would miss. Each has a test in the task named in brackets.

- Config with keywords but no `[[location]]` (or the reverse) must fail loudly instead of running an unbounded search. [Task 2, Task 3, Task 6]
- A typo like `[[keyword]]` or `[[locations]]`, or malformed TOML, must produce an error naming the file and the key, not a silent empty config. [Task 2]
- A second `igor search` while one is live must be refused without hitting any source, and a bad config discovered by a TUI-launched child must land in the run's message rather than "exited unexpectedly". [Task 6]
- A legacy DB with a live in-flight `tailor_runs` row must migrate without losing it, and opening twice must be idempotent. [Task 4]
- A relative `[db] path` must resolve against the config file's directory, not the cwd (the sandbox use case). [Task 3]

---

## File Structure

- Create `src/paths.ts`: XDG/global/local path helpers. One responsibility: where files live.
- Create `src/config.ts`: pure config model (types, `parseConfig`, `mergeConfigs`, `resolveConfig`, `groupByFlexibility`, `serializeConfig`, `ConfigError`).
- Create `src/settings.ts`: disk and env layer (`loadConfigChain`, `resolveDbPath`, `loadSearchConfig`, `describeConfig`).
- Create `src/init.ts`: `igor init` flow with injected IO.
- Create `src/tui/search.ts`: `startBackgroundSearch` with injected spawn (keeps `App.tsx` thin and testable).
- Modify `src/db.ts`: `runs` table, migration, generic run API, tailor wrappers, `mkdir` in `openDb`.
- Modify `src/sources/location.ts` and five sources: loose remote location matching.
- Modify `src/cli.ts`: search planning and run tracking, db resolution on every command, `config` and `init` commands, friendly `ConfigError` output.
- Modify `src/tui/index.ts`, `src/tui/App.tsx`: Ctrl+S, header indicator, poll `runs`.
- Create `igor.example.toml`; modify `README.md`, `.env.example`.
- Tests: `tests/paths.test.ts`, `tests/config.test.ts`, `tests/settings.test.ts`, `tests/runs.test.ts`, `tests/search.test.ts`, `tests/init.test.ts`, `tests/tuiSearch.test.ts`; extend `tests/location.test.ts`, `tests/cli.test.ts`.

---

### Task 1: Path helpers

**Files:**
- Create: `src/paths.ts`
- Test: `tests/paths.test.ts`

**Interfaces:**
- Produces: `type Env = Record<string, string | undefined>`; `globalConfigPath(env?: Env): string`; `globalDbPath(env?: Env): string`; `localConfigPath(cwd: string): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/paths.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  globalConfigPath,
  globalDbPath,
  localConfigPath,
} from "../src/paths.ts";

describe("paths", () => {
  it("honors absolute XDG overrides", () => {
    const env = { XDG_CONFIG_HOME: "/x/cfg", XDG_DATA_HOME: "/x/data" };
    expect(globalConfigPath(env)).toBe("/x/cfg/igor/config.toml");
    expect(globalDbPath(env)).toBe("/x/data/igor/igor.db");
  });

  it("falls back to ~/.config and ~/.local/share", () => {
    const env = { HOME: "/home/t" };
    expect(globalConfigPath(env)).toBe("/home/t/.config/igor/config.toml");
    expect(globalDbPath(env)).toBe("/home/t/.local/share/igor/igor.db");
  });

  it("ignores relative XDG values, as the XDG spec requires", () => {
    const env = { HOME: "/home/t", XDG_CONFIG_HOME: "relative/dir" };
    expect(globalConfigPath(env)).toBe("/home/t/.config/igor/config.toml");
  });

  it("puts the local override in the cwd", () => {
    expect(localConfigPath("/work/proj")).toBe("/work/proj/igor.toml");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/paths.test.ts 2>&1 | tail -15`
Expected: FAIL, cannot find module `../src/paths.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/paths.ts`:

```ts
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Env = Record<string, string | undefined>;

function xdgDir(env: Env, key: string, homeRelative: string): string {
  const value = env[key];
  // The XDG spec says relative values must be ignored.
  if (value && isAbsolute(value)) return value;
  return join(env.HOME || homedir(), homeRelative);
}

export function globalConfigPath(env: Env = process.env): string {
  return join(xdgDir(env, "XDG_CONFIG_HOME", ".config"), "igor", "config.toml");
}

export function globalDbPath(env: Env = process.env): string {
  return join(
    xdgDir(env, "XDG_DATA_HOME", ".local/share"),
    "igor",
    "igor.db",
  );
}

export function localConfigPath(cwd: string): string {
  return join(cwd, "igor.toml");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/paths.test.ts 2>&1 | tail -15`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
bunx @biomejs/biome check --write src/paths.ts tests/paths.test.ts
git add src/paths.ts tests/paths.test.ts
git commit -m "feat: XDG global and local config/db path helpers" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Config model (pure)

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `SearchParams` from `src/sources/types.ts`.
- Produces (all exported from `src/config.ts`):
  - `type Flexibility = "remote" | "in-person" | "any"`; `const FLEXIBILITIES: readonly Flexibility[]`
  - `interface LocationEntry { city: string; flexibility: Flexibility }`
  - `interface IgorConfig { govmil?: boolean; db?: string; locations?: LocationEntry[]; keywords?: string[] }`
  - `interface ResolvedConfig { govmil: boolean; db?: string; locations: LocationEntry[]; keywords: string[] }`
  - `interface SearchGroup extends SearchParams { role: string[]; location?: string[]; remote: boolean; onsite: boolean }`
  - `class ConfigError extends Error`
  - `parseConfig(text: string, file: string): IgorConfig`
  - `mergeConfigs(base: IgorConfig, override: IgorConfig): IgorConfig`
  - `resolveConfig(config: IgorConfig, files: string[]): ResolvedConfig`
  - `groupByFlexibility(roles: string[], locations: LocationEntry[]): SearchGroup[]`
  - `serializeConfig(config: IgorConfig): string`

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  ConfigError,
  groupByFlexibility,
  mergeConfigs,
  parseConfig,
  resolveConfig,
  serializeConfig,
} from "../src/config.ts";

const FULL = `
[job]
govmil = true

[db]
path = "sandbox.db"

[[location]]
city = "Omaha"
flexibility = "in-person"

[[location]]
city = "United States"
flexibility = "remote"

[[keywords]]
role = "Software Engineer"

[[keywords]]
role = "DevOps Engineer"
`;

describe("parseConfig", () => {
  it("parses every section", () => {
    const config = parseConfig(FULL, "/etc/igor/igor.toml");
    expect(config).toEqual({
      govmil: true,
      db: "/etc/igor/sandbox.db",
      locations: [
        { city: "Omaha", flexibility: "in-person" },
        { city: "United States", flexibility: "remote" },
      ],
      keywords: ["Software Engineer", "DevOps Engineer"],
    });
  });

  it("defaults flexibility to any", () => {
    const config = parseConfig(
      '[[location]]\ncity = "Omaha"\n',
      "igor.toml",
    );
    expect(config.locations).toEqual([{ city: "Omaha", flexibility: "any" }]);
  });

  it("keeps absolute db paths as they are", () => {
    const config = parseConfig('[db]\npath = "/data/x.db"\n', "igor.toml");
    expect(config.db).toBe("/data/x.db");
  });

  it("rejects a typo'd table name, naming the file and key", () => {
    expect(() =>
      parseConfig('[[keyword]]\nrole = "x"\n', "igor.toml"),
    ).toThrow(/igor\.toml: unknown key "keyword"/);
    expect(() =>
      parseConfig('[[locations]]\ncity = "x"\n', "igor.toml"),
    ).toThrow(/unknown key "locations"/);
  });

  it("rejects unknown keys inside known tables", () => {
    expect(() => parseConfig("[job]\nclearance = true\n", "igor.toml")).toThrow(
      /unknown key "clearance" in \[job\]/,
    );
  });

  it("reports which entry is missing a city or role", () => {
    expect(() =>
      parseConfig(
        '[[location]]\ncity = "A"\n[[location]]\nflexibility = "any"\n',
        "igor.toml",
      ),
    ).toThrow(/\[\[location\]\] entry 2 is missing "city"/);
    expect(() =>
      parseConfig(
        '[[keywords]]\nrole = "A"\n[[keywords]]\nname = "B"\n',
        "igor.toml",
      ),
    ).toThrow(/unknown key "name" in \[\[keywords\]\] entry 2/);
    expect(() =>
      parseConfig('[[keywords]]\nrole = "A"\n[[keywords]]\nrole = ""\n', "x.toml"),
    ).toThrow(/\[\[keywords\]\] entry 2 is missing "role"/);
  });

  it("rejects an invalid flexibility and lists the valid ones", () => {
    expect(() =>
      parseConfig(
        '[[location]]\ncity = "A"\nflexibility = "onsite"\n',
        "igor.toml",
      ),
    ).toThrow(/invalid flexibility "onsite" \(use remote, in-person, any\)/);
  });

  it("rejects a non-boolean govmil", () => {
    expect(() => parseConfig('[job]\ngovmil = "yes"\n', "igor.toml")).toThrow(
      /govmil must be true or false/,
    );
  });

  it("wraps malformed TOML in a ConfigError naming the file", () => {
    expect(() => parseConfig("[[location\n", "bad.toml")).toThrow(ConfigError);
    expect(() => parseConfig("[[location\n", "bad.toml")).toThrow(/bad\.toml/);
  });
});

describe("mergeConfigs", () => {
  const base = parseConfig(FULL, "/g/config.toml");

  it("replaces lists wholesale and overrides scalars per key", () => {
    const local = parseConfig(
      '[job]\ngovmil = false\n[[location]]\ncity = "Austin"\n',
      "/l/igor.toml",
    );
    const merged = mergeConfigs(base, local);
    expect(merged.govmil).toBe(false);
    expect(merged.locations).toEqual([{ city: "Austin", flexibility: "any" }]);
    expect(merged.keywords).toEqual(["Software Engineer", "DevOps Engineer"]);
    expect(merged.db).toBe("/g/sandbox.db");
  });

  it("leaves the base untouched when the override is empty", () => {
    expect(mergeConfigs(base, {})).toEqual(base);
  });
});

describe("resolveConfig", () => {
  it("never allows an unbounded search: locations are required", () => {
    expect(() =>
      resolveConfig({ keywords: ["a"] }, ["/g/config.toml"]),
    ).toThrow(/no \[\[location\]\] configured \(\/g\/config\.toml\)/);
    expect(() =>
      resolveConfig({ keywords: ["a"], locations: [] }, []),
    ).toThrow(/at least one location is required/i);
  });

  it("requires keywords and hints at igor init when no file exists", () => {
    expect(() =>
      resolveConfig({ locations: [{ city: "A", flexibility: "any" }] }, []),
    ).toThrow(/no \[\[keywords\]\] configured \(no config file found\).*igor init/s);
  });

  it("defaults govmil to false", () => {
    const resolved = resolveConfig(
      { keywords: ["a"], locations: [{ city: "A", flexibility: "any" }] },
      [],
    );
    expect(resolved.govmil).toBe(false);
  });
});

describe("groupByFlexibility", () => {
  it("makes one group per flexibility present", () => {
    const groups = groupByFlexibility(
      ["swe"],
      [
        { city: "Omaha", flexibility: "in-person" },
        { city: "Lincoln", flexibility: "in-person" },
        { city: "United States", flexibility: "remote" },
        { city: "Austin", flexibility: "any" },
      ],
    );
    expect(groups).toEqual([
      { role: ["swe"], location: ["United States"], remote: true, onsite: false },
      { role: ["swe"], location: ["Omaha", "Lincoln"], remote: false, onsite: true },
      { role: ["swe"], location: ["Austin"], remote: false, onsite: false },
    ]);
  });
});

describe("serializeConfig", () => {
  it("round-trips through parseConfig", () => {
    const config = parseConfig(FULL, "/etc/igor/igor.toml");
    expect(parseConfig(serializeConfig(config), "/etc/igor/igor.toml")).toEqual(
      config,
    );
  });

  it("escapes quotes in values", () => {
    const text = serializeConfig({ keywords: ['C "sharp" dev'] });
    expect(parseConfig(text, "x.toml").keywords).toEqual(['C "sharp" dev']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts 2>&1 | tail -15`
Expected: FAIL, cannot find module `../src/config.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/config.ts`:

```ts
import { dirname, isAbsolute, resolve } from "node:path";
import type { SearchParams } from "./sources/types.ts";

export type Flexibility = "remote" | "in-person" | "any";
export const FLEXIBILITIES: readonly Flexibility[] = [
  "remote",
  "in-person",
  "any",
];

export interface LocationEntry {
  city: string;
  flexibility: Flexibility;
}

/** What one config file (or a merge of several) says; everything optional. */
export interface IgorConfig {
  govmil?: boolean;
  /** Absolute path (relative values are resolved against the file's dir). */
  db?: string;
  locations?: LocationEntry[];
  keywords?: string[];
}

/** A config that is complete enough to run a search. */
export interface ResolvedConfig {
  govmil: boolean;
  db?: string;
  locations: LocationEntry[];
  keywords: string[];
}

/** One call's worth of SearchParams; locations sharing a flexibility batch. */
export interface SearchGroup extends SearchParams {
  role: string[];
  location?: string[];
  remote: boolean;
  onsite: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(
  file: string,
  where: string,
  table: Record<string, unknown>,
  allowed: string[],
): void {
  for (const key of Object.keys(table)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`${file}: unknown key "${key}" in ${where}`);
    }
  }
}

function tableArray(
  file: string,
  name: string,
  value: unknown,
): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) {
    throw new ConfigError(`${file}: [[${name}]] must be an array of tables`);
  }
  return value as Record<string, unknown>[];
}

export function parseConfig(text: string, file: string): IgorConfig {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (err) {
    throw new ConfigError(
      `${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(raw)) {
    throw new ConfigError(`${file}: expected a TOML table`);
  }
  rejectUnknown(file, "the top level", raw, [
    "job",
    "db",
    "location",
    "keywords",
  ]);

  const config: IgorConfig = {};

  if (raw.job !== undefined) {
    if (!isRecord(raw.job)) {
      throw new ConfigError(`${file}: [job] must be a table`);
    }
    rejectUnknown(file, "[job]", raw.job, ["govmil"]);
    if (raw.job.govmil !== undefined) {
      if (typeof raw.job.govmil !== "boolean") {
        throw new ConfigError(`${file}: [job] govmil must be true or false`);
      }
      config.govmil = raw.job.govmil;
    }
  }

  if (raw.db !== undefined) {
    if (!isRecord(raw.db)) {
      throw new ConfigError(`${file}: [db] must be a table`);
    }
    rejectUnknown(file, "[db]", raw.db, ["path"]);
    if (typeof raw.db.path !== "string" || raw.db.path === "") {
      throw new ConfigError(`${file}: [db] path must be a non-empty string`);
    }
    config.db = isAbsolute(raw.db.path)
      ? raw.db.path
      : resolve(dirname(file), raw.db.path);
  }

  if (raw.location !== undefined) {
    config.locations = tableArray(file, "location", raw.location).map(
      (entry, i) => {
        const where = `[[location]] entry ${i + 1}`;
        rejectUnknown(file, where, entry, ["city", "flexibility"]);
        if (typeof entry.city !== "string" || entry.city.trim() === "") {
          throw new ConfigError(`${file}: ${where} is missing "city"`);
        }
        const flexibility = entry.flexibility ?? "any";
        if (!FLEXIBILITIES.includes(flexibility as Flexibility)) {
          throw new ConfigError(
            `${file}: ${where} has invalid flexibility ${JSON.stringify(flexibility)} (use ${FLEXIBILITIES.join(", ")})`,
          );
        }
        return {
          city: entry.city.trim(),
          flexibility: flexibility as Flexibility,
        };
      },
    );
  }

  if (raw.keywords !== undefined) {
    config.keywords = tableArray(file, "keywords", raw.keywords).map(
      (entry, i) => {
        const where = `[[keywords]] entry ${i + 1}`;
        rejectUnknown(file, where, entry, ["role"]);
        if (typeof entry.role !== "string" || entry.role.trim() === "") {
          throw new ConfigError(`${file}: ${where} is missing "role"`);
        }
        return entry.role.trim();
      },
    );
  }

  return config;
}

/** Scalars override per key; lists are replaced wholesale, never joined. */
export function mergeConfigs(
  base: IgorConfig,
  override: IgorConfig,
): IgorConfig {
  return {
    govmil: override.govmil ?? base.govmil,
    db: override.db ?? base.db,
    locations: override.locations ?? base.locations,
    keywords: override.keywords ?? base.keywords,
  };
}

/** Requires what a search needs, so a search can never be unbounded. */
export function resolveConfig(
  config: IgorConfig,
  files: string[],
): ResolvedConfig {
  const where =
    files.length > 0 ? files.join(", ") : "no config file found";
  if (!config.locations || config.locations.length === 0) {
    throw new ConfigError(
      `no [[location]] configured (${where}). At least one location is required so a search is never unbounded; run "igor init" or add one.`,
    );
  }
  if (!config.keywords || config.keywords.length === 0) {
    throw new ConfigError(
      `no [[keywords]] configured (${where}). Run "igor init" or add at least one [[keywords]] role.`,
    );
  }
  return {
    govmil: config.govmil ?? false,
    db: config.db,
    locations: config.locations,
    keywords: config.keywords,
  };
}

export function groupByFlexibility(
  roles: string[],
  locations: LocationEntry[],
): SearchGroup[] {
  const groups: SearchGroup[] = [];
  for (const flexibility of FLEXIBILITIES) {
    const cities = locations
      .filter((l) => l.flexibility === flexibility)
      .map((l) => l.city);
    if (cities.length === 0) continue;
    groups.push({
      role: roles,
      location: cities,
      remote: flexibility === "remote",
      onsite: flexibility === "in-person",
    });
  }
  return groups;
}

// JSON string escapes are a subset of TOML basic-string escapes.
const quote = (value: string) => JSON.stringify(value);

export function serializeConfig(config: IgorConfig): string {
  const parts: string[] = [];
  if (config.govmil !== undefined) {
    parts.push(`[job]\ngovmil = ${config.govmil}`);
  }
  if (config.db) parts.push(`[db]\npath = ${quote(config.db)}`);
  for (const l of config.locations ?? []) {
    parts.push(
      `[[location]]\ncity = ${quote(l.city)}\nflexibility = ${quote(l.flexibility)}`,
    );
  }
  for (const role of config.keywords ?? []) {
    parts.push(`[[keywords]]\nrole = ${quote(role)}`);
  }
  return `${parts.join("\n\n")}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/config.test.ts 2>&1 | tail -15`
Expected: PASS. If the `mergeConfigs` "untouched" test fails on `undefined` properties, use `toEqual` (it ignores undefined props); do not change the implementation.

- [ ] **Step 5: Commit**

```bash
bunx @biomejs/biome check --write src/config.ts tests/config.test.ts
bun run typecheck 2>&1 | tail -5
git add src/config.ts tests/config.test.ts
git commit -m "feat: pure TOML config model with validation, merge, and grouping" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Settings layer (file chain, env, db path)

**Files:**
- Create: `src/settings.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: everything from Task 1 and Task 2.
- Produces (from `src/settings.ts`):
  - `interface SettingsOptions { cwd?: string; env?: Env; config?: string }`
  - `interface LoadedConfig { config: IgorConfig; files: string[] }`
  - `loadConfigChain(opts?: SettingsOptions): LoadedConfig` (throws `ConfigError` for a missing explicit file or a bad file)
  - `resolveDbPath(opts?: SettingsOptions & { db?: string }): string`
  - `loadSearchConfig(opts?: SettingsOptions): ResolvedConfig`
  - `describeConfig(opts?: SettingsOptions): string`

- [ ] **Step 1: Write the failing test**

Create `tests/settings.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/config.ts";
import {
  describeConfig,
  loadConfigChain,
  loadSearchConfig,
  resolveDbPath,
} from "../src/settings.ts";

let root: string;
let cwd: string;
let env: Record<string, string>;

function write(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

const globalFile = () => join(root, "cfg", "igor", "config.toml");
const localFile = () => join(cwd, "igor.toml");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "igor-settings-"));
  cwd = join(root, "proj");
  mkdirSync(cwd, { recursive: true });
  env = {
    XDG_CONFIG_HOME: join(root, "cfg"),
    XDG_DATA_HOME: join(root, "data"),
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadConfigChain", () => {
  it("returns an empty config when no file exists", () => {
    expect(loadConfigChain({ cwd, env })).toEqual({ config: {}, files: [] });
  });

  it("layers the local file over the global one", () => {
    write(
      globalFile(),
      '[job]\ngovmil = true\n[[location]]\ncity = "Omaha"\n[[keywords]]\nrole = "swe"\n',
    );
    write(localFile(), '[[location]]\ncity = "Austin"\n');
    const { config, files } = loadConfigChain({ cwd, env });
    expect(files).toEqual([globalFile(), localFile()]);
    expect(config.govmil).toBe(true);
    expect(config.locations).toEqual([{ city: "Austin", flexibility: "any" }]);
    expect(config.keywords).toEqual(["swe"]);
  });

  it("uses only the explicit --config file, ignoring the chain", () => {
    write(localFile(), '[[location]]\ncity = "Austin"\n');
    write(join(root, "other.toml"), '[[location]]\ncity = "Reno"\n');
    const { config, files } = loadConfigChain({
      cwd,
      env,
      config: join(root, "other.toml"),
    });
    expect(files).toEqual([join(root, "other.toml")]);
    expect(config.locations).toEqual([{ city: "Reno", flexibility: "any" }]);
  });

  it("honors IGOR_CONFIG the same way, with the flag winning", () => {
    write(join(root, "env.toml"), '[[location]]\ncity = "Env"\n');
    write(join(root, "flag.toml"), '[[location]]\ncity = "Flag"\n');
    const viaEnv = loadConfigChain({
      cwd,
      env: { ...env, IGOR_CONFIG: join(root, "env.toml") },
    });
    expect(viaEnv.config.locations?.[0]?.city).toBe("Env");
    const both = loadConfigChain({
      cwd,
      env: { ...env, IGOR_CONFIG: join(root, "env.toml") },
      config: join(root, "flag.toml"),
    });
    expect(both.config.locations?.[0]?.city).toBe("Flag");
  });

  it("errors when an explicit config file is missing", () => {
    expect(() =>
      loadConfigChain({ cwd, env, config: join(root, "nope.toml") }),
    ).toThrow(/config file not found/);
  });

  it("names the offending file for a malformed config", () => {
    write(localFile(), "[[keyword]]\nrole = 'x'\n");
    expect(() => loadConfigChain({ cwd, env })).toThrow(
      new RegExp(`${localFile()}: unknown key "keyword"`),
    );
  });
});

describe("resolveDbPath", () => {
  it("defaults to the global data dir", () => {
    expect(resolveDbPath({ cwd, env })).toBe(
      join(root, "data", "igor", "igor.db"),
    );
  });

  it("prefers flag, then IGOR_DB, then config, then default", () => {
    write(localFile(), `[db]\npath = "/from/config.db"\n`);
    expect(resolveDbPath({ cwd, env })).toBe("/from/config.db");
    expect(resolveDbPath({ cwd, env: { ...env, IGOR_DB: "/from/env.db" } })).toBe(
      "/from/env.db",
    );
    expect(
      resolveDbPath({
        cwd,
        env: { ...env, IGOR_DB: "/from/env.db" },
        db: "/from/flag.db",
      }),
    ).toBe("/from/flag.db");
  });

  it("resolves a relative [db] path against the config file's directory", () => {
    write(localFile(), '[db]\npath = "sandbox.db"\n');
    // Run from a different cwd than the file's directory via --config.
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    expect(resolveDbPath({ cwd: elsewhere, env, config: localFile() })).toBe(
      join(cwd, "sandbox.db"),
    );
    expect(resolveDbPath({ cwd, env })).toBe(join(cwd, "sandbox.db"));
  });
});

describe("loadSearchConfig", () => {
  it("refuses keywords without a location", () => {
    write(localFile(), '[[keywords]]\nrole = "swe"\n');
    expect(() => loadSearchConfig({ cwd, env })).toThrow(ConfigError);
    expect(() => loadSearchConfig({ cwd, env })).toThrow(/\[\[location\]\]/);
  });

  it("returns a resolved config when complete", () => {
    write(
      localFile(),
      '[[location]]\ncity = "Omaha"\n[[keywords]]\nrole = "swe"\n',
    );
    const resolved = loadSearchConfig({ cwd, env });
    expect(resolved.keywords).toEqual(["swe"]);
    expect(resolved.govmil).toBe(false);
  });
});

describe("describeConfig", () => {
  it("lists files, the db path, and the merged config", () => {
    write(
      localFile(),
      '[[location]]\ncity = "Omaha"\nflexibility = "remote"\n',
    );
    const text = describeConfig({ cwd, env });
    expect(text).toContain(localFile());
    expect(text).toContain(`database: ${join(root, "data", "igor", "igor.db")}`);
    expect(text).toContain('city = "Omaha"');
  });

  it("points at igor init when there is no config", () => {
    expect(describeConfig({ cwd, env })).toContain('run "igor init"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/settings.test.ts 2>&1 | tail -15`
Expected: FAIL, cannot find module `../src/settings.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/settings.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ConfigError,
  type IgorConfig,
  type ResolvedConfig,
  mergeConfigs,
  parseConfig,
  resolveConfig,
  serializeConfig,
} from "./config.ts";
import {
  type Env,
  globalConfigPath,
  globalDbPath,
  localConfigPath,
} from "./paths.ts";

export interface SettingsOptions {
  cwd?: string;
  env?: Env;
  /** `--config <path>`: replaces the whole file chain with this one file. */
  config?: string;
}

export interface LoadedConfig {
  config: IgorConfig;
  /** Files that were read, lowest precedence first. */
  files: string[];
}

function readConfigFile(path: string): IgorConfig {
  return parseConfig(readFileSync(path, "utf8"), path);
}

export function loadConfigChain(opts: SettingsOptions = {}): LoadedConfig {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  const explicit = opts.config ?? (env.IGOR_CONFIG || undefined);
  if (explicit) {
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) {
      throw new ConfigError(`config file not found: ${path}`);
    }
    return { config: readConfigFile(path), files: [path] };
  }

  let config: IgorConfig = {};
  const files: string[] = [];
  for (const path of [globalConfigPath(env), localConfigPath(cwd)]) {
    if (!existsSync(path)) continue;
    config = mergeConfigs(config, readConfigFile(path));
    files.push(path);
  }
  return { config, files };
}

function pickDbPath(
  flag: string | undefined,
  env: Env,
  config: IgorConfig,
): string {
  return flag || env.IGOR_DB || config.db || globalDbPath(env);
}

/** Flag, then IGOR_DB, then `[db] path` from the config chain, then default. */
export function resolveDbPath(
  opts: SettingsOptions & { db?: string } = {},
): string {
  const env = opts.env ?? process.env;
  // Skip reading config at all when a higher-precedence source decides.
  if (opts.db) return opts.db;
  if (env.IGOR_DB) return env.IGOR_DB;
  return pickDbPath(undefined, env, loadConfigChain(opts).config);
}

export function loadSearchConfig(opts: SettingsOptions = {}): ResolvedConfig {
  const { config, files } = loadConfigChain(opts);
  return resolveConfig(config, files);
}

export function describeConfig(opts: SettingsOptions = {}): string {
  const env = opts.env ?? process.env;
  const { config, files } = loadConfigChain(opts);
  const filesLine =
    files.length > 0
      ? `config files (later overrides earlier):\n${files.map((f) => `  ${f}`).join("\n")}`
      : `config files: none (run "igor init" to create ${globalConfigPath(env)})`;
  return [
    filesLine,
    `database: ${pickDbPath(undefined, env, config)}`,
    "",
    serializeConfig(config).trimEnd(),
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/settings.test.ts 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bunx @biomejs/biome check --write src/settings.ts tests/settings.test.ts
bun run typecheck 2>&1 | tail -5
git add src/settings.ts tests/settings.test.ts
git commit -m "feat: settings layer for config file chain, env, and db path" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `runs` table, migration, generic run API

**Files:**
- Modify: `src/db.ts:1-3` (imports), `src/db.ts:20-73` (`openDb`), `src/db.ts:286-393` (tailor run block)
- Test: `tests/runs.test.ts` (new); `tests/tailorRuns.test.ts` must keep passing unchanged.

**Interfaces:**
- Produces (from `src/db.ts`):
  - `type RunKind = "tailor" | "search"`; `const SEARCH_RUN_KEY = "search"`
  - `interface Run { kind: RunKind; key: string; pid: number; startedAt: string; finishedAt: string | null; ok: boolean | null; message: string | null }`
  - `getRun(db, kind, key): Run | null`
  - `startRun(db, kind, key, pid, now?): boolean`
  - `finishRun(db, kind, key, ok, message, now?): void`
  - `runningRunKeys(db, kind): Set<string>`
  - The existing `getTailorRun/startTailorRun/finishTailorRun/runningTailorIds` keep their signatures and become thin wrappers (`getTailorRun` now returns `Run | null`; the `TailorRun` type is removed).
  - `openDb` creates the parent directory of `path` when missing.

- [ ] **Step 1: Write the failing test**

Create `tests/runs.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEARCH_RUN_KEY,
  finishRun,
  getRun,
  openDb,
  runningRunKeys,
  startRun,
} from "../src/db.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "igor-runs-"));
}

async function deadPid(): Promise<number> {
  const proc = Bun.spawn({ cmd: ["true"] });
  await proc.exited;
  return proc.pid;
}

describe("runs", () => {
  it("keeps kinds independent even with the same key", () => {
    const dir = tmp();
    const db = openDb(join(dir, "a.db"));
    expect(startRun(db, "search", SEARCH_RUN_KEY, process.pid)).toBe(true);
    expect(startRun(db, "tailor", SEARCH_RUN_KEY, process.pid)).toBe(true);
    finishRun(db, "search", SEARCH_RUN_KEY, true, "3 found, 1 new");
    expect(getRun(db, "search", SEARCH_RUN_KEY)).toMatchObject({
      ok: true,
      message: "3 found, 1 new",
    });
    expect(runningRunKeys(db, "search").size).toBe(0);
    expect(runningRunKeys(db, "tailor").has(SEARCH_RUN_KEY)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it("refuses a second claim from a different live pid", () => {
    const dir = tmp();
    const db = openDb(join(dir, "a.db"));
    expect(startRun(db, "search", SEARCH_RUN_KEY, 1)).toBe(true); // pid 1 is always alive
    expect(startRun(db, "search", SEARCH_RUN_KEY, process.pid)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it("reports a dead unfinished run as failed, naming the kind", async () => {
    const dir = tmp();
    const db = openDb(join(dir, "a.db"));
    startRun(db, "search", SEARCH_RUN_KEY, await deadPid());
    expect(runningRunKeys(db, "search").size).toBe(0);
    expect(getRun(db, "search", SEARCH_RUN_KEY)).toMatchObject({
      ok: false,
      message: "search process exited unexpectedly",
    });
    rmSync(dir, { recursive: true });
  });
});

describe("openDb", () => {
  it("creates missing parent directories", () => {
    const dir = tmp();
    const path = join(dir, "a", "b", "igor.db");
    openDb(path).close();
    expect(existsSync(path)).toBe(true);
    rmSync(dir, { recursive: true });
  });
});

describe("tailor_runs migration", () => {
  function legacyDb(path: string) {
    const legacy = new Database(path);
    legacy.run(`CREATE TABLE tailor_runs (
      listing_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at TEXT NOT NULL,
      finished_at TEXT, ok INTEGER, message TEXT)`);
    legacy.run(
      "INSERT INTO tailor_runs VALUES ('live:1', ?, '2026-09-01T00:00:00Z', NULL, NULL, NULL)",
      [process.pid],
    );
    legacy.run(
      "INSERT INTO tailor_runs VALUES ('done:2', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:01:00Z', 1, 'Wrote x.pdf')",
    );
    legacy.close();
  }

  it("moves rows into runs, keeps a live run live, and drops the old table", () => {
    const dir = tmp();
    const path = join(dir, "old.db");
    legacyDb(path);

    const db = openDb(path);
    expect(runningRunKeys(db, "tailor").has("live:1")).toBe(true);
    expect(getRun(db, "tailor", "done:2")).toMatchObject({
      ok: true,
      message: "Wrote x.pdf",
    });
    const legacy = db
      .query("SELECT 1 FROM sqlite_master WHERE name = 'tailor_runs'")
      .get();
    expect(legacy).toBeNull();
    db.close();
    rmSync(dir, { recursive: true });
  });

  it("is idempotent across repeated opens", () => {
    const dir = tmp();
    const path = join(dir, "old.db");
    legacyDb(path);
    openDb(path).close();
    const db = openDb(path);
    expect(getRun(db, "tailor", "done:2")).not.toBeNull();
    db.close();
    rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/runs.test.ts 2>&1 | tail -15`
Expected: FAIL, `startRun` (and the other new exports) not exported from `src/db.ts`.

- [ ] **Step 3: Write minimal implementation**

In `src/db.ts`, change the imports at the top to:

```ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { NormalizedJob } from "./sources/types.ts";
```

Replace the start of `openDb` (currently `export function openDb(path = "igor.db"): Database {\n  const db = new Database(path);`) with:

```ts
export function openDb(path = "igor.db"): Database {
  // The global default lives under a data dir that may not exist yet.
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
```

Also update the comment on the busy_timeout line to `// The TUI and detached igor processes (tailor, search) write the same file.`

Replace the `tailor_runs` block inside `openDb` (from the comment `// Background \`igor tailor\` runs...` through the closing `)`` of that `db.run`, i.e. lines 60-71) with:

```ts
  // Background igor processes (`igor tailor`, `igor search`), so the TUI can
  // show progress and pick it back up after being restarted. One row per
  // (kind, key), the latest run; finished_at is NULL while running.
  db.run(`
    CREATE TABLE IF NOT EXISTS runs (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      pid INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      ok INTEGER,
      message TEXT,
      PRIMARY KEY (kind, key)
    )
  `);
  migrateTailorRuns(db);
```

Add this function directly above `openDb`:

```ts
/** One-time move of the old tailor_runs table into runs. */
function migrateTailorRuns(db: Database): void {
  const hasLegacy = () =>
    db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tailor_runs'")
      .get() !== null;
  if (!hasLegacy()) return;
  // IMMEDIATE + re-check so two processes opening the db at once don't race.
  db.transaction(() => {
    if (!hasLegacy()) return;
    db.run(`
      INSERT OR IGNORE INTO runs (kind, key, pid, started_at, finished_at, ok, message)
      SELECT 'tailor', listing_id, pid, started_at, finished_at, ok, message FROM tailor_runs
    `);
    db.run("DROP TABLE tailor_runs");
  }).immediate();
}
```

Replace everything from `export interface TailorRun {` to the end of the file (the whole old tailor-run block, `TailorRun` through `runningTailorIds`) with:

```ts
export type RunKind = "tailor" | "search";

/** The single key used for `kind = "search"` runs (one search at a time). */
export const SEARCH_RUN_KEY = "search";

export interface Run {
  kind: RunKind;
  key: string;
  pid: number;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  message: string | null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but isn't ours.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function toRun(row: Record<string, unknown>): Run {
  return {
    kind: row.kind as RunKind,
    key: row.key as string,
    pid: row.pid as number,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
    ok: row.ok === null || row.ok === undefined ? null : row.ok === 1,
    message: (row.message as string | null) ?? null,
  };
}

export function getRun(db: Database, kind: RunKind, key: string): Run | null {
  const row = db
    .prepare("SELECT * FROM runs WHERE kind = $kind AND key = $key")
    .get({ $kind: kind, $key: key }) as Record<string, unknown> | null;
  return row ? toRun(row) : null;
}

/**
 * Marks a run as started by `pid`. Returns false if a different live process
 * already has one running for this (kind, key). Re-claiming with the same pid
 * is fine: the TUI records the child's pid before the child starts.
 */
export function startRun(
  db: Database,
  kind: RunKind,
  key: string,
  pid: number,
  now = new Date().toISOString(),
): boolean {
  const existing = getRun(db, kind, key);
  if (
    existing &&
    existing.finishedAt === null &&
    existing.pid !== pid &&
    pidAlive(existing.pid)
  ) {
    return false;
  }
  db.prepare(
    `INSERT INTO runs (kind, key, pid, started_at, finished_at, ok, message)
     VALUES ($kind, $key, $pid, $now, NULL, NULL, NULL)
     ON CONFLICT(kind, key) DO UPDATE SET pid = $pid, started_at = $now, finished_at = NULL, ok = NULL, message = NULL`,
  ).run({ $kind: kind, $key: key, $pid: pid, $now: now });
  return true;
}

export function finishRun(
  db: Database,
  kind: RunKind,
  key: string,
  ok: boolean,
  message: string,
  now = new Date().toISOString(),
): void {
  db.prepare(
    "UPDATE runs SET finished_at = $now, ok = $ok, message = $message WHERE kind = $kind AND key = $key",
  ).run({
    $kind: kind,
    $key: key,
    $now: now,
    $ok: ok ? 1 : 0,
    $message: message,
  });
}

/**
 * Keys with a run of `kind` in flight. Runs whose process died without
 * finishing (killed, crashed) are closed out as failed rather than pulsing
 * forever.
 */
export function runningRunKeys(db: Database, kind: RunKind): Set<string> {
  const rows = db
    .prepare("SELECT * FROM runs WHERE kind = $kind AND finished_at IS NULL")
    .all({ $kind: kind }) as Record<string, unknown>[];
  const running = new Set<string>();
  for (const row of rows) {
    const run = toRun(row);
    if (pidAlive(run.pid)) running.add(run.key);
    else finishRun(db, kind, run.key, false, `${kind} process exited unexpectedly`);
  }
  return running;
}

export function getTailorRun(db: Database, listingId: string): Run | null {
  return getRun(db, "tailor", listingId);
}

export function startTailorRun(
  db: Database,
  listingId: string,
  pid: number,
  now?: string,
): boolean {
  return startRun(db, "tailor", listingId, pid, now);
}

export function finishTailorRun(
  db: Database,
  listingId: string,
  ok: boolean,
  message: string,
  now?: string,
): void {
  finishRun(db, "tailor", listingId, ok, message, now);
}

export function runningTailorIds(db: Database): Set<string> {
  return runningRunKeys(db, "tailor");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/runs.test.ts tests/tailorRuns.test.ts tests/db.test.ts 2>&1 | tail -15 && bun run typecheck 2>&1 | tail -5`
Expected: all PASS, typecheck clean. (If typecheck flags `App.tsx` using a removed `TailorRun` type, it should not: App only reads fields off the return value. Fix any such reference by using `Run`.)

- [ ] **Step 5: Commit**

```bash
bunx @biomejs/biome check --write src/db.ts tests/runs.test.ts
git add src/db.ts tests/runs.test.ts
git commit -m "feat: generic runs table replacing tailor_runs, with migration" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Loose location matching for remote searches

A `flexibility = "remote"` location acts as an eligibility region. Remote listings whose location is blank, "Worldwide", "Anywhere" and similar must still match, so `matchesLocation` gets a `remote` option that the sources set from `params.remote`.

**Files:**
- Modify: `src/sources/location.ts`, `src/sources/remotive.ts:44-47`, `src/sources/remoteok.ts:48-52`, `src/sources/lever.ts:55-60`, `src/sources/greenhouse.ts:42-47`, `src/sources/ashby.ts:74-80`
- Test: `tests/location.test.ts`

**Interfaces:**
- Consumes: `SearchParams.remote?: boolean` (already exists).
- Produces: `matchesLocation(jobLocation: string, queryLocation: string | string[], options?: { remote?: boolean }): boolean`. Existing two-argument calls keep their behavior.

- [ ] **Step 1: Write the failing test**

Append to `tests/location.test.ts`:

```ts
describe("matchesLocation for remote searches", () => {
  it("accepts worldwide-style listings only when remote is set", () => {
    for (const loc of ["", "Remote", "Worldwide", "Anywhere", " Global "]) {
      expect(matchesLocation(loc, "United States", { remote: true })).toBe(true);
      expect(matchesLocation(loc, "United States")).toBe(false);
    }
  });

  it("still requires a match for region-specific listings", () => {
    expect(
      matchesLocation("Remote - Germany", "United States", { remote: true }),
    ).toBe(false);
    expect(
      matchesLocation("United States", "United States", { remote: true }),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/location.test.ts 2>&1 | tail -15`
Expected: FAIL (worldwide case returns false with `remote: true`).

- [ ] **Step 3: Write minimal implementation**

Replace `matchesLocation` in `src/sources/location.ts`:

```ts
// Listings that say nothing region-specific. For a remote search these are
// eligible everywhere, so they match any query location.
const WORLDWIDE = new Set([
  "",
  "remote",
  "worldwide",
  "anywhere",
  "global",
  "everywhere",
]);

export function matchesLocation(
  jobLocation: string,
  queryLocation: string | string[],
  options: { remote?: boolean } = {},
): boolean {
  const job = jobLocation.toLowerCase();
  if (options.remote && WORLDWIDE.has(job.trim())) return true;
  return toArray(queryLocation).some((queryLocation) => {
    const query = queryLocation.toLowerCase();
    const aliases = METRO_ALIASES[query] ?? [query];
    return aliases.some((alias) => job.includes(alias));
  });
}
```

Then pass the option at each source call site:

`src/sources/remotive.ts`: replace
`matchesLocation(job.candidate_required_location, params.location),`
with
`matchesLocation(job.candidate_required_location, params.location, {\n              remote: params.remote,\n            }),`

`src/sources/remoteok.ts`: replace `matchesLocation(job.location, params.location),` with `matchesLocation(job.location, params.location, { remote: params.remote }),`

`src/sources/lever.ts`: replace `!matchesLocation(job.categories.location, params.location)` with
`!matchesLocation(job.categories.location, params.location, {\n              remote: params.remote,\n            })`

`src/sources/greenhouse.ts`: replace `!matchesLocation(job.location.name, params.location)` with
`!matchesLocation(job.location.name, params.location, {\n              remote: params.remote,\n            })`

`src/sources/ashby.ts`: replace `matchesLocation(loc, params.location as string | string[]),` with
`matchesLocation(loc, params.location as string | string[], {\n                remote: params.remote,\n              }),`

Leave `jobaps.ts` alone (it only emits `onsite` listings).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/location.test.ts tests/sources.test.ts 2>&1 | tail -15 && bun run typecheck 2>&1 | tail -5`
Expected: PASS (existing source tests are unaffected because `remote` is unset there).

- [ ] **Step 5: Commit**

```bash
bunx @biomejs/biome check --write src/sources tests/location.test.ts
git add src/sources tests/location.test.ts
git commit -m "feat: match worldwide/anywhere listings for remote location searches" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Config-driven `igor search` with run tracking, and db resolution on every command

This is the largest task: `runSearch` plans from flags or config, groups by flexibility, claims a `search` run, records its summary, and every command resolves its db path through `resolveDbPath`.

**Files:**
- Modify: `src/cli.ts` (imports; `SearchOptions`/`runSearch` at 78-153; `runClear`, `runRefresh`, `JobsCliOptions`/`runJobs`, `TailorCliOptions`/`runTailor`; `createProgram`; `main` catch)
- Modify: `tests/cli.test.ts` (three expectations that encoded the old defaults)
- Test: `tests/search.test.ts` (new)

**Interfaces:**
- Consumes: `resolveDbPath`, `loadSearchConfig` (Task 3); `groupByFlexibility`, `SearchGroup`, `ResolvedConfig`, `Flexibility`, `LocationEntry`, `ConfigError` (Task 2); `SEARCH_RUN_KEY`, `startRun`, `finishRun`, `StoredJob` (Task 4).
- Produces:
  - `SearchOptions { location?: string[]; remote?: boolean; onsite?: boolean; role?: string[]; json: boolean; csv: boolean; db?: string; config?: string; clearance: boolean }`
  - `interface SearchPlan { groups: SearchGroup[]; govmil: boolean }`
  - `planSearch(options: SearchOptions, loadConfig: () => ResolvedConfig): SearchPlan`
  - `collectJobs(groups: SearchGroup[], sources: Source[], govmil: boolean): Promise<{ jobs: NormalizedJob[]; failures: string[] }>`
  - `interface SearchDeps { sources?: Source[]; isUrlDead?: (url: string) => Promise<boolean>; cwd?: string; env?: Record<string, string | undefined> }`
  - `runSearch(options: SearchOptions, deps?: SearchDeps): Promise<void>`
  - `--config <path>` option on `search` and `tui` (the `tui` wiring lands in Task 9 together with `runTui`'s new option).

- [ ] **Step 1: Write the failing test**

Create `tests/search.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SearchOptions,
  collectJobs,
  planSearch,
  runSearch,
} from "../src/cli.ts";
import { ConfigError, type ResolvedConfig } from "../src/config.ts";
import {
  SEARCH_RUN_KEY,
  allJobs,
  getRun,
  openDb,
  startRun,
} from "../src/db.ts";
import type { NormalizedJob, Source } from "../src/sources/types.ts";

function job(overrides: Partial<NormalizedJob>): NormalizedJob {
  return {
    sourceId: "1",
    source: "greenhouse",
    title: "Software Engineer",
    company: "Acme",
    location: "Omaha, NE",
    remoteType: "onsite",
    url: "https://example.com/1",
    postedAt: null,
    description: null,
    ...overrides,
  };
}

function fakeSource(jobs: NormalizedJob[], calls: { n: number } = { n: 0 }): Source {
  return {
    name: "greenhouse",
    async search() {
      calls.n++;
      return jobs;
    },
  };
}

const flags = (over: Partial<SearchOptions> = {}): SearchOptions => ({
  json: false,
  csv: false,
  clearance: false,
  ...over,
});

const CONFIG: ResolvedConfig = {
  govmil: false,
  keywords: ["swe", "devops"],
  locations: [
    { city: "Omaha", flexibility: "in-person" },
    { city: "United States", flexibility: "remote" },
  ],
};

describe("planSearch", () => {
  it("uses flags alone when --role is given, without reading config", () => {
    const plan = planSearch(
      flags({ role: ["swe"], location: ["Omaha"], remote: true }),
      () => {
        throw new Error("config must not be read");
      },
    );
    expect(plan.groups).toEqual([
      { role: ["swe"], location: ["Omaha"], remote: true, onsite: false },
    ]);
  });

  it("keeps an unrestricted group for --role without --location (today's behavior)", () => {
    const plan = planSearch(flags({ role: ["swe"] }), () => CONFIG);
    expect(plan.groups).toEqual([
      { role: ["swe"], remote: false, onsite: false },
    ]);
    expect(plan.groups[0]?.location).toBeUndefined();
  });

  it("builds groups from config when --role is absent", () => {
    const plan = planSearch(flags(), () => CONFIG);
    expect(plan.groups).toEqual([
      { role: ["swe", "devops"], location: ["United States"], remote: true, onsite: false },
      { role: ["swe", "devops"], location: ["Omaha"], remote: false, onsite: true },
    ]);
    expect(plan.govmil).toBe(false);
  });

  it("lets --location, --remote and --clearance override the config", () => {
    const plan = planSearch(
      flags({ location: ["Reno"], remote: true, clearance: true }),
      () => CONFIG,
    );
    expect(plan.groups).toEqual([
      { role: ["swe", "devops"], location: ["Reno"], remote: true, onsite: false },
    ]);
    expect(plan.govmil).toBe(true);

    const overridden = planSearch(flags({ onsite: true }), () => CONFIG);
    expect(overridden.groups).toEqual([
      { role: ["swe", "devops"], location: ["Omaha", "United States"], remote: false, onsite: true },
    ]);
  });

  it("rejects --remote together with --onsite", () => {
    expect(() =>
      planSearch(flags({ role: ["x"], remote: true, onsite: true }), () => CONFIG),
    ).toThrow(/mutually exclusive/);
  });
});

describe("collectJobs", () => {
  const remoteJob = job({ sourceId: "r", remoteType: "remote", title: "Remote SWE", url: "https://e.com/r" });
  const hybridJob = job({ sourceId: "h", remoteType: "hybrid", title: "Hybrid SWE", url: "https://e.com/h" });
  const unknownJob = job({ sourceId: "u", remoteType: "unknown", title: "Unknown SWE", url: "https://e.com/u" });
  const all = [remoteJob, hybridJob, unknownJob];
  const g = (remote: boolean, onsite: boolean) => ({ role: ["swe"], location: ["X"], remote, onsite });
  const titles = (jobs: NormalizedJob[]) => jobs.map((j) => j.sourceId).sort();

  it("in-person keeps everything that is not remote (hybrid and unknown included)", async () => {
    const { jobs } = await collectJobs([g(false, true)], [fakeSource(all)], false);
    expect(titles(jobs)).toEqual(["h", "u"]);
  });

  it("remote keeps only remote jobs; any keeps all", async () => {
    expect(titles((await collectJobs([g(true, false)], [fakeSource(all)], false)).jobs)).toEqual(["r"]);
    expect(titles((await collectJobs([g(false, false)], [fakeSource(all)], false)).jobs)).toEqual(["h", "r", "u"]);
  });

  it("dedupes across groups and drops internships and govmil unless enabled", async () => {
    const intern = job({ sourceId: "i", title: "SWE Intern", url: "https://e.com/i" });
    const cleared = job({ sourceId: "c", title: "SWE (Security Clearance)", url: "https://e.com/c" });
    const groups = [g(false, false), g(false, false)];
    const off = await collectJobs(groups, [fakeSource([hybridJob, intern, cleared])], false);
    expect(titles(off.jobs)).toEqual(["h"]);
    const on = await collectJobs(groups, [fakeSource([hybridJob, intern, cleared])], true);
    expect(titles(on.jobs)).toEqual(["c", "h"]);
  });

  it("records a failing source instead of throwing", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    const broken: Source = {
      name: "jsearch",
      async search() {
        throw new Error("429 Too Many Requests");
      },
    };
    const { jobs, failures } = await collectJobs([g(false, false)], [broken, fakeSource([hybridJob])], false);
    expect(titles(jobs)).toEqual(["h"]);
    expect(failures).toEqual(["jsearch: 429 Too Many Requests"]);
    errorLog.mockRestore();
  });
});

describe("runSearch", () => {
  let root: string;
  let cwd: string;
  let env: Record<string, string>;
  let logSpy: { mockRestore(): void };

  const dbPath = () => join(root, "data", "igor", "igor.db");
  const deps = (sources: Source[]) => ({
    sources,
    isUrlDead: async () => false,
    cwd,
    env,
  });
  const writeConfig = (text: string) => {
    const path = join(root, "cfg", "igor", "config.toml");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    return path;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "igor-search-"));
    cwd = join(root, "proj");
    mkdirSync(cwd);
    env = { XDG_CONFIG_HOME: join(root, "cfg"), XDG_DATA_HOME: join(root, "data") };
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs from the config, stores jobs, and records the summary", async () => {
    writeConfig(
      '[[location]]\ncity = "Omaha"\nflexibility = "in-person"\n[[keywords]]\nrole = "swe"\n',
    );
    await runSearch(flags(), deps([fakeSource([job({})])]));
    const db = openDb(dbPath());
    expect(allJobs(db)).toHaveLength(1);
    expect(getRun(db, "search", SEARCH_RUN_KEY)).toMatchObject({
      ok: true,
      message: "1 found, 1 new",
    });
    db.close();
  });

  it("appends failed sources to the summary", async () => {
    writeConfig('[[location]]\ncity = "Omaha"\n[[keywords]]\nrole = "swe"\n');
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    const broken: Source = {
      name: "jsearch",
      async search() {
        throw new Error("429");
      },
    };
    await runSearch(flags(), deps([broken, fakeSource([job({})])]));
    const db = openDb(dbPath());
    expect(getRun(db, "search", SEARCH_RUN_KEY)?.message).toBe(
      "1 found, 1 new; failed: jsearch: 429",
    );
    db.close();
    errorLog.mockRestore();
  });

  it("records a bad config as a failed run, naming the file", async () => {
    const file = writeConfig('[[keyword]]\nrole = "swe"\n');
    await expect(runSearch(flags(), deps([fakeSource([])]))).rejects.toThrow(
      ConfigError,
    );
    const db = openDb(dbPath());
    const run = getRun(db, "search", SEARCH_RUN_KEY);
    expect(run?.ok).toBe(false);
    expect(run?.message).toContain(file);
    db.close();
  });

  it("refuses keywords without a location and never calls a source", async () => {
    writeConfig('[[keywords]]\nrole = "swe"\n');
    const calls = { n: 0 };
    await expect(
      runSearch(flags(), deps([fakeSource([job({})], calls)])),
    ).rejects.toThrow(/\[\[location\]\]/);
    expect(calls.n).toBe(0);
  });

  it("hints at igor init when there is no config and no --role", async () => {
    await expect(runSearch(flags(), deps([]))).rejects.toThrow(/igor init/);
  });

  it("is refused while another live process holds the search run", async () => {
    writeConfig('[[location]]\ncity = "Omaha"\n[[keywords]]\nrole = "swe"\n');
    const db = openDb(dbPath());
    startRun(db, "search", SEARCH_RUN_KEY, 1); // pid 1 is always alive
    db.close();
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    const calls = { n: 0 };
    await runSearch(flags(), deps([fakeSource([job({})], calls)]));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(calls.n).toBe(0);
    errorLog.mockRestore();
  });

  it("still works with --role and no config at all (flag mode)", async () => {
    await runSearch(
      flags({ role: ["swe"], location: ["Omaha"] }),
      deps([fakeSource([job({})])]),
    );
    const db = openDb(dbPath());
    expect(allJobs(db)).toHaveLength(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/search.test.ts 2>&1 | tail -15`
Expected: FAIL, `planSearch`/`collectJobs` not exported from `src/cli.ts`.

- [ ] **Step 3: Implement**

3a. `src/cli.ts` imports. Add (biome will sort them):

```ts
import {
  ConfigError,
  type Flexibility,
  type ResolvedConfig,
  type SearchGroup,
  groupByFlexibility,
} from "./config.ts";
import { loadSearchConfig, resolveDbPath } from "./settings.ts";
```

and in the existing `./db.ts` import list add `SEARCH_RUN_KEY`, `finishRun`, `startRun`, and `type StoredJob` (keep `finishTailorRun`/`startTailorRun`, `runTailor` still uses them). The `Source`/`NormalizedJob` type import already exists.

3b. Replace lines 78-153 (`export interface SearchOptions` through the end of `runSearch`) with:

```ts
export interface SearchOptions {
  location?: string[];
  remote?: boolean;
  onsite?: boolean;
  role?: string[];
  json: boolean;
  csv: boolean;
  db?: string;
  config?: string;
  clearance: boolean;
}

export interface SearchPlan {
  groups: SearchGroup[];
  govmil: boolean;
}

/**
 * With --role, the flags describe the whole search and the config is not
 * read. Otherwise the config supplies keywords and locations, and
 * --location, --remote/--onsite and --clearance override pieces of it.
 */
export function planSearch(
  options: SearchOptions,
  loadConfig: () => ResolvedConfig,
): SearchPlan {
  if (options.remote && options.onsite) {
    throw new Error("--remote and --onsite are mutually exclusive");
  }
  const flag: Flexibility | null = options.remote
    ? "remote"
    : options.onsite
      ? "in-person"
      : null;
  const flagLocations = options.location?.map((city) => ({
    city,
    flexibility: flag ?? ("any" as Flexibility),
  }));

  if (options.role) {
    const groups: SearchGroup[] = flagLocations
      ? groupByFlexibility(options.role, flagLocations)
      : [
          {
            role: options.role,
            remote: flag === "remote",
            onsite: flag === "in-person",
          },
        ];
    return { groups, govmil: options.clearance };
  }

  const config = loadConfig();
  const locations =
    flagLocations ??
    config.locations.map((l) => ({ ...l, flexibility: flag ?? l.flexibility }));
  return {
    groups: groupByFlexibility(config.keywords, locations),
    govmil: options.clearance || config.govmil,
  };
}

function matchesWork(job: NormalizedJob, group: SearchGroup): boolean {
  if (group.remote && job.remoteType !== "remote") return false;
  if (group.onsite && job.remoteType === "remote") return false;
  return true;
}

/** Runs every source for every group, then filters and dedupes the union. */
export async function collectJobs(
  groups: SearchGroup[],
  sources: Source[],
  govmil: boolean,
): Promise<{ jobs: NormalizedJob[]; failures: string[] }> {
  const failures = new Set<string>();
  const perGroup = await Promise.all(
    groups.map(async (group) => {
      const results = await Promise.all(
        sources.map((source) =>
          source.search(group).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[${source.name}] search failed: ${message}`);
            failures.add(`${source.name}: ${message.slice(0, 80)}`);
            return [] as NormalizedJob[];
          }),
        ),
      );
      return results.flat().filter((job) => matchesWork(job, group));
    }),
  );
  const jobs = dedupe(perGroup.flat())
    .filter((job) => !isInternship(job))
    .filter((job) => govmil || !requiresClearance(job))
    .map((job) => ({ ...job, url: stripTrackingParams(job.url) }));
  return { jobs, failures: [...failures] };
}

export interface SearchDeps {
  sources?: Source[];
  isUrlDead?: (url: string) => Promise<boolean>;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export async function runSearch(
  options: SearchOptions,
  deps: SearchDeps = {},
): Promise<void> {
  const { cwd, env } = deps;
  const dbPath = resolveDbPath({
    db: options.db,
    config: options.config,
    cwd,
    env,
  });
  const db = openDb(dbPath);
  // Claim the run before anything can fail: the TUI records this pid before
  // we start (re-claiming with the same pid is fine), and a config error
  // below must reach the TUI as this run's message, not as a dead pid.
  if (!startRun(db, "search", SEARCH_RUN_KEY, process.pid)) {
    db.close();
    console.error("error: a search is already in progress");
    process.exitCode = 1;
    return;
  }

  let jobs: NormalizedJob[];
  let newJobs: StoredJob[];
  let stored: StoredJob[] = [];
  try {
    const plan = planSearch(options, () =>
      loadSearchConfig({ config: options.config, cwd, env }),
    );
    const found = await collectJobs(
      plan.groups,
      deps.sources ?? buildSources(),
      plan.govmil,
    );
    jobs = found.jobs;
    const deadCheck = deps.isUrlDead ?? isUrlDead;
    const states = new Map<string, ListingState>();
    await Promise.all(
      jobs.map(async (job) => {
        if (await deadCheck(job.url)) {
          states.set(listingId(job), "inactive");
        }
      }),
    );
    newJobs = upsertJobs(db, jobs, states);
    if (options.json || options.csv) stored = allJobs(db);
    const failed =
      found.failures.length > 0 ? `; failed: ${found.failures.join(", ")}` : "";
    finishRun(
      db,
      "search",
      SEARCH_RUN_KEY,
      true,
      `${jobs.length} found, ${newJobs.length} new${failed}`,
    );
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
}
```

3c. Db resolution in the other commands. Change each to accept an optional `db` and resolve it:

```ts
export async function runClear(options: { db?: string }): Promise<void> {
  const dbPath = resolveDbPath({ db: options.db });
  const db = openDb(dbPath);
  clearJobs(db);
  db.close();
  console.log(`Cleared all jobs from ${dbPath}`);
}
```

```ts
export async function runRefresh(options: { db?: string }): Promise<void> {
  const db = openDb(resolveDbPath({ db: options.db }));
  // ...rest unchanged
```

In `JobsCliOptions` change `db: string;` to `db?: string;`, and in `runJobs` change `const db = openDb(options.db);` to `const db = openDb(resolveDbPath({ db: options.db }));`.

In `TailorCliOptions` change `db: string;` to `db?: string;`, and in `runTailor` change `const db = openDb(options.db);` to `const db = openDb(resolveDbPath({ db: options.db }));`.

3d. `createProgram`: update the parameter types to `clearAction: (options: { db?: string }) => Promise<void>` and `refreshAction: (options: { db?: string }) => Promise<void>`. Add two constants above `createProgram`:

```ts
const DB_HELP = "path to sqlite db (default: the global db, see `igor config`)";
const CONFIG_HELP =
  "config file to use instead of the global config + ./igor.toml";
```

Replace every `.option("--db <path>", "path to sqlite db", "igor.db")` (six occurrences: search, tui, clear, refresh, jobs, tailor) with `.option("--db <path>", DB_HELP)` (use `Edit` with `replace_all`). In the `tui` and `clear`/`refresh` `.action` type annotations change `{ db: string }` to `{ db?: string }`, and in the `tui` action change `await runTui({ db: options.db });` to `await runTui({ db: resolveDbPath({ db: options.db }) });`. In the `tailor` action's options type change `db: string;` to `db?: string;`.

For the `search` command replace `.requiredOption(\n      "--role <query...>",\n      "role/title to search for (accepts multiple values)",\n    )` with:

```ts
    .option(
      "--role <query...>",
      "role/title to search for (accepts multiple values); omit to use the config's [[keywords]]",
    )
```

and add `.option("--config <path>", CONFIG_HELP)` after the `--db` option of `search`. Update the search description to `"Search job sources (from igor.toml/config, or --role) and store results"`.

3e. Friendly config errors. Replace the `main().catch(...)` handler at the bottom with:

```ts
  main().catch((err) => {
    if (err instanceof ConfigError) {
      console.error(`error: ${err.message}`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });
```

3f. Update `tests/cli.test.ts` to the new defaults:
- In `describe("clear command parsing")`, test "parses clear with defaults": replace `expect(calls[0]).toMatchObject({ db: "igor.db" });` with `expect(calls[0]?.db).toBeUndefined();`.
- In `describe("search command parsing")`, replace the test `it("requires --role", ...)` with:

```ts
  it("does not require --role (the config supplies it)", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync(["node", "igor", "search"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.role).toBeUndefined();
  });

  it("accepts --config", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync(["node", "igor", "search", "--config", "x.toml"]);
    expect(calls[0]?.config).toBe("x.toml");
  });
```

- In "applies defaults when only --role is given" remove the line `db: "igor.db",` from the `toMatchObject` and add after it `expect(calls[0]?.db).toBeUndefined();`.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test 2>&1 | tail -20 && bun run typecheck 2>&1 | tail -10`
Expected: all PASS, typecheck clean. Common fixes: if `tsc` reports `jobs`/`newJobs` "used before being assigned" after the try/catch/finally in `runSearch`, initialize them (`let jobs: NormalizedJob[] = []; let newJobs: StoredJob[] = [];`) rather than restructuring; remove unused imports left behind by the refactor (the `Database` type import is still used by `refreshListings`).

- [ ] **Step 5: Commit**

```bash
bunx @biomejs/biome check --write src/cli.ts tests/cli.test.ts tests/search.test.ts
git add src/cli.ts tests/cli.test.ts tests/search.test.ts
git commit -m "feat: config-driven igor search tracked as a background run; resolve db path everywhere" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: `igor config` command

**Files:**
- Modify: `src/cli.ts` (`createProgram`, imports)
- Test: `tests/cli.test.ts` (parse test); output formatting is already covered by `describeConfig` tests in Task 3.

**Interfaces:**
- Consumes: `describeConfig(opts)` from Task 3.
- Produces: `igor config [--config <path>]` printing `describeConfig` output.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli.test.ts`:

```ts
describe("config command", () => {
  it("is registered and accepts --config", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "config");
    expect(cmd).toBeDefined();
    expect(cmd?.options.map((o) => o.long)).toContain("--config");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli.test.ts 2>&1 | tail -15`
Expected: FAIL (`cmd` undefined).

- [ ] **Step 3: Implement**

In `src/cli.ts`, add `describeConfig` to the `./settings.ts` import, then add before `return program;` in `createProgram`:

```ts
  program
    .command("config")
    .description(
      "Show the config files in use, the database path, and the merged config",
    )
    .option("--config <path>", CONFIG_HELP)
    .action((options: { config?: string }) => {
      console.log(describeConfig({ config: options.config }));
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli.test.ts 2>&1 | tail -15 && bun run typecheck 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bunx @biomejs/biome check --write src/cli.ts tests/cli.test.ts
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: igor config prints resolved files, db path, and merged config" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: `igor init`

**Files:**
- Create: `src/init.ts`
- Modify: `src/cli.ts` (register command)
- Test: `tests/init.test.ts`

**Interfaces:**
- Consumes: `FLEXIBILITIES`-free: uses `Flexibility`, `IgorConfig`, `ConfigError`, `serializeConfig` (Task 2); `globalConfigPath`, `globalDbPath`, `Env` (Task 1); `openDb` (Task 4).
- Produces (from `src/init.ts`):
  - `interface InitOptions { location?: string; keywords?: string; work?: string; yes?: boolean; db?: string }`
  - `interface InitIO { ask(question: string): Promise<string>; log(message: string): void; env?: Env }`
  - `parseList(value: string): string[]`; `parseWork(value: string): Flexibility | null`
  - `runInit(options: InitOptions, io: InitIO): Promise<void>`
  - `terminalIO(): InitIO & { close(): void }`

- [ ] **Step 1: Write the failing test**

Create `tests/init.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, parseConfig } from "../src/config.ts";
import { allJobs, openDb, upsertJobs } from "../src/db.ts";
import { type InitIO, parseList, parseWork, runInit } from "../src/init.ts";

let root: string;
let env: Record<string, string>;
let logs: string[];

const configPath = () => join(root, "cfg", "igor", "config.toml");
const dbPath = () => join(root, "data", "igor", "igor.db");

function scripted(answers: string[]): InitIO & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    env,
    log: (m) => logs.push(m),
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? "";
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "igor-init-"));
  env = { XDG_CONFIG_HOME: join(root, "cfg"), XDG_DATA_HOME: join(root, "data") };
  logs = [];
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("parseList / parseWork", () => {
  it("splits, trims, and drops empties", () => {
    expect(parseList(" software engineer, devops engineer ,, ")).toEqual([
      "software engineer",
      "devops engineer",
    ]);
  });

  it("maps answers to a flexibility", () => {
    expect(parseWork("")).toBe("any");
    expect(parseWork("r")).toBe("remote");
    expect(parseWork("Remote")).toBe("remote");
    expect(parseWork("i")).toBe("in-person");
    expect(parseWork("onsite")).toBe("in-person");
    expect(parseWork("hybrid")).toBe("in-person");
    expect(parseWork("either")).toBe("any");
    expect(parseWork("any")).toBe("any");
    expect(parseWork("banana")).toBeNull();
  });
});

describe("runInit", () => {
  it("prompts for location, keywords, and work type, then writes both files", async () => {
    const io = scripted(["Omaha, San Francisco", "software engineer, devops engineer", "r"]);
    await runInit({}, io);

    const config = parseConfig(readFileSync(configPath(), "utf8"), configPath());
    expect(config.locations).toEqual([
      { city: "Omaha", flexibility: "remote" },
      { city: "San Francisco", flexibility: "remote" },
    ]);
    expect(config.keywords).toEqual(["software engineer", "devops engineer"]);
    expect(existsSync(dbPath())).toBe(true);
    expect(logs.join("\n")).toContain("Created database");
  });

  it("skips prompts for values given as flags", async () => {
    const io = scripted([]);
    await runInit({ location: "Omaha", keywords: "swe", work: "in-person" }, io);
    expect(io.asked).toEqual([]);
    const config = parseConfig(readFileSync(configPath(), "utf8"), configPath());
    expect(config.locations).toEqual([{ city: "Omaha", flexibility: "in-person" }]);
  });

  it("asks before overwriting an existing config and leaves it if declined", async () => {
    mkdirSync(join(configPath(), ".."), { recursive: true });
    writeFileSync(configPath(), "# mine\n");
    const io = scripted([""]); // default answer: no
    await runInit({ location: "Omaha", keywords: "swe", work: "any" }, io);
    expect(io.asked).toHaveLength(1);
    expect(readFileSync(configPath(), "utf8")).toBe("# mine\n");
  });

  it("overwrites an existing config when --yes is given", async () => {
    mkdirSync(join(configPath(), ".."), { recursive: true });
    writeFileSync(configPath(), "# mine\n");
    await runInit({ location: "Omaha", keywords: "swe", work: "any", yes: true }, scripted([]));
    expect(readFileSync(configPath(), "utf8")).toContain('city = "Omaha"');
  });

  it("never deletes an existing database", async () => {
    const db = openDb(dbPath());
    upsertJobs(db, [
      {
        sourceId: "1", source: "greenhouse", title: "SWE", company: "Acme",
        location: "Omaha", remoteType: "onsite", url: "https://e.com/1",
        postedAt: null, description: null,
      },
    ]);
    db.close();
    await runInit({ location: "Omaha", keywords: "swe", work: "any" }, scripted([]));
    const again = openDb(dbPath());
    expect(allJobs(again)).toHaveLength(1);
    again.close();
    expect(logs.join("\n")).toContain("Using existing database");
  });

  it("gives up with a ConfigError after three empty answers", async () => {
    await expect(runInit({}, scripted(["", "", ""]))).rejects.toThrow(ConfigError);
  });

  it("rejects an invalid --work value", async () => {
    await expect(
      runInit({ location: "Omaha", keywords: "swe", work: "banana" }, scripted([])),
    ).rejects.toThrow(/work type/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/init.test.ts 2>&1 | tail -15`
Expected: FAIL, cannot find module `../src/init.ts`.

- [ ] **Step 3: Implement**

Create `src/init.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  ConfigError,
  type Flexibility,
  type IgorConfig,
  serializeConfig,
} from "./config.ts";
import { openDb } from "./db.ts";
import { type Env, globalConfigPath, globalDbPath } from "./paths.ts";

export interface InitOptions {
  location?: string;
  keywords?: string;
  work?: string;
  yes?: boolean;
  db?: string;
}

export interface InitIO {
  ask(question: string): Promise<string>;
  log(message: string): void;
  env?: Env;
}

export function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** First letter decides: r(emote), i/o/h (in-person, onsite, hybrid), e/a (either, any). */
export function parseWork(value: string): Flexibility | null {
  const first = value.trim().toLowerCase()[0];
  if (first === undefined) return "any";
  if (first === "r") return "remote";
  if ("ioh".includes(first)) return "in-person";
  if ("ea".includes(first)) return "any";
  return null;
}

async function askList(
  io: InitIO,
  question: string,
  what: string,
): Promise<string[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const items = parseList(await io.ask(question));
    if (items.length > 0) return items;
    io.log(`Please enter at least one ${what}.`);
  }
  throw new ConfigError(`no ${what} given`);
}

async function askWork(io: InitIO): Promise<Flexibility> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const work = parseWork(
      await io.ask(
        "Work type: [r]emote, [i]n-person (onsite or hybrid), or [e]ither? (default: either) ",
      ),
    );
    if (work) return work;
    io.log('Please answer "remote", "in-person", or "either".');
  }
  throw new ConfigError("no valid work type given");
}

export async function runInit(
  options: InitOptions,
  io: InitIO,
): Promise<void> {
  const env = io.env ?? process.env;
  const configPath = globalConfigPath(env);
  const dbPath = options.db ?? (env.IGOR_DB || globalDbPath(env));

  if (existsSync(configPath)) {
    const answer = options.yes
      ? "y"
      : await io.ask(`${configPath} already exists. Overwrite it? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      io.log(`Left ${configPath} unchanged.`);
      return;
    }
  }

  const cities =
    options.location !== undefined
      ? parseList(options.location)
      : await askList(
          io,
          "Which cities should Igor search? Comma separated (e.g. Omaha, San Francisco): ",
          "city",
        );
  const roles =
    options.keywords !== undefined
      ? parseList(options.keywords)
      : await askList(
          io,
          "Which roles? Comma separated (e.g. software engineer, devops engineer): ",
          "role",
        );
  let flexibility: Flexibility;
  if (options.work !== undefined) {
    const parsed = parseWork(options.work);
    if (!parsed) {
      throw new ConfigError(
        `invalid work type "${options.work}" (use remote, in-person, or any)`,
      );
    }
    flexibility = parsed;
  } else {
    flexibility = await askWork(io);
  }
  if (cities.length === 0) throw new ConfigError("no city given");
  if (roles.length === 0) throw new ConfigError("no role given");

  const config: IgorConfig = {
    govmil: false,
    locations: cities.map((city) => ({ city, flexibility })),
    keywords: roles,
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, serializeConfig(config));

  const existed = existsSync(dbPath);
  openDb(dbPath).close();

  io.log(`Wrote ${configPath}`);
  io.log(`${existed ? "Using existing" : "Created"} database ${dbPath}`);
  io.log('Next: run "igor tui" and press ctrl+S to search, or run "igor search".');
}

export function terminalIO(): InitIO & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    // A closed stdin (piped, CI) reads as an empty answer.
    ask: async (question) => {
      try {
        return await rl.question(question);
      } catch {
        return "";
      }
    },
    log: (message) => console.log(message),
    close: () => rl.close(),
  };
}
```

In `src/cli.ts` add `import { type InitOptions, runInit, terminalIO } from "./init.ts";` and register before `return program;`:

```ts
  program
    .command("init")
    .description(
      "Create the global config and database, prompting for cities, roles, and work type",
    )
    .option("--location <cities>", "comma-separated cities (skips the prompt)")
    .option("--keywords <roles>", "comma-separated roles (skips the prompt)")
    .option("--work <type>", "remote, in-person, or any (skips the prompt)")
    .option("--db <path>", "where to create the database")
    .option("-y, --yes", "overwrite an existing config without asking", false)
    .action(async (options: InitOptions) => {
      const io = terminalIO();
      try {
        await runInit(options, io);
      } finally {
        io.close();
      }
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/init.test.ts 2>&1 | tail -15 && bun run typecheck 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Smoke the real command against a scratch dir**

Run:
```bash
export T=$(mktemp -d) && XDG_CONFIG_HOME=$T/c XDG_DATA_HOME=$T/d bun run src/cli.ts init --location "Omaha, Austin" --keywords "software engineer, devops engineer" --work any && XDG_CONFIG_HOME=$T/c XDG_DATA_HOME=$T/d bun run src/cli.ts config
```
Expected: init prints the two `Wrote`/`Created` lines and a next-step hint; `config` lists the file, the db path under `$T/d`, and the merged TOML.

- [ ] **Step 6: Commit**

```bash
bunx @biomejs/biome check --write src/init.ts src/cli.ts tests/init.test.ts
git add src/init.ts src/cli.ts tests/init.test.ts
git commit -m "feat: igor init creates the global config and database" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: TUI Ctrl+S background search

**Files:**
- Create: `src/tui/search.ts`
- Modify: `src/tui/index.ts`, `src/tui/App.tsx`, `src/cli.ts` (`tui` command)
- Test: `tests/tuiSearch.test.ts`

**Interfaces:**
- Consumes: `SEARCH_RUN_KEY`, `runningRunKeys`, `startRun`, `getRun` (Task 4); `NO_DELEGATE_ENV` from `src/checkout.ts`.
- Produces (from `src/tui/search.ts`):
  - `interface SpawnedProcess { pid: number; unref(): void }`
  - `type SpawnFn = (options: { cmd: string[]; stdio: ["ignore", "ignore", "ignore"]; env: Record<string, string | undefined>; detached: true }) => SpawnedProcess`
  - `startBackgroundSearch(options: { db: Database; dbPath: string; configPath?: string; spawn?: SpawnFn }): { started: boolean; message: string }`
  - `TuiOptions` gains `config?: string`; `JobBrowser` props gain `configPath?: string`.

- [ ] **Step 1: Write the failing test**

Create `tests/tuiSearch.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEARCH_RUN_KEY, finishRun, getRun, openDb } from "../src/db.ts";
import { type SpawnFn, startBackgroundSearch } from "../src/tui/search.ts";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "igor-tui-"));
  const dbPath = join(dir, "igor.db");
  const db = openDb(dbPath);
  const spawned: { cmd: string[]; env: Record<string, string | undefined> }[] = [];
  // Returning our own pid keeps the recorded run "live" for the whole test.
  const spawn: SpawnFn = (options) => {
    spawned.push({ cmd: options.cmd, env: options.env });
    return { pid: process.pid, unref() {} };
  };
  return { dir, db, dbPath, spawned, spawn };
}

describe("startBackgroundSearch", () => {
  it("spawns a detached igor search and records the run", () => {
    const h = harness();
    const result = startBackgroundSearch({ db: h.db, dbPath: h.dbPath, spawn: h.spawn });
    expect(result.started).toBe(true);
    expect(h.spawned).toHaveLength(1);
    const { cmd, env } = h.spawned[0] ?? { cmd: [], env: {} };
    expect(cmd).toContain("search");
    expect(cmd.slice(cmd.indexOf("--db"), cmd.indexOf("--db") + 2)).toEqual(["--db", h.dbPath]);
    expect(cmd).not.toContain("--config");
    expect(env.IGOR_NO_DELEGATE).toBe("1");
    expect(getRun(h.db, "search", SEARCH_RUN_KEY)).toMatchObject({ pid: process.pid, finishedAt: null });
    rmSync(h.dir, { recursive: true });
  });

  it("forwards --config when the TUI was started with one", () => {
    const h = harness();
    startBackgroundSearch({ db: h.db, dbPath: h.dbPath, configPath: "/x/my.toml", spawn: h.spawn });
    const cmd = h.spawned[0]?.cmd ?? [];
    expect(cmd.slice(cmd.indexOf("--config"), cmd.indexOf("--config") + 2)).toEqual([
      "--config",
      "/x/my.toml",
    ]);
    rmSync(h.dir, { recursive: true });
  });

  it("refuses to start a second search while one is running", () => {
    const h = harness();
    startBackgroundSearch({ db: h.db, dbPath: h.dbPath, spawn: h.spawn });
    const second = startBackgroundSearch({ db: h.db, dbPath: h.dbPath, spawn: h.spawn });
    expect(second).toEqual({ started: false, message: "Search already running" });
    expect(h.spawned).toHaveLength(1);
    rmSync(h.dir, { recursive: true });
  });

  it("allows a new search once the previous one finished", () => {
    const h = harness();
    startBackgroundSearch({ db: h.db, dbPath: h.dbPath, spawn: h.spawn });
    finishRun(h.db, "search", SEARCH_RUN_KEY, true, "3 found, 1 new");
    expect(startBackgroundSearch({ db: h.db, dbPath: h.dbPath, spawn: h.spawn }).started).toBe(true);
    expect(h.spawned).toHaveLength(2);
    rmSync(h.dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tuiSearch.test.ts 2>&1 | tail -15`
Expected: FAIL, cannot find module `../src/tui/search.ts`.

- [ ] **Step 3: Implement the launcher**

Create `src/tui/search.ts`:

```ts
import type { Database } from "bun:sqlite";
import { NO_DELEGATE_ENV } from "../checkout.ts";
import { SEARCH_RUN_KEY, runningRunKeys, startRun } from "../db.ts";

export interface SpawnedProcess {
  pid: number;
  unref(): void;
}

export type SpawnFn = (options: {
  cmd: string[];
  stdio: ["ignore", "ignore", "ignore"];
  env: Record<string, string | undefined>;
  detached: true;
}) => SpawnedProcess;

const defaultSpawn: SpawnFn = (options) => Bun.spawn(options);

export interface BackgroundSearchOptions {
  db: Database;
  dbPath: string;
  configPath?: string;
  spawn?: SpawnFn;
}

/**
 * Starts a detached `igor search` that outlives the TUI. The TUI never reads
 * the config: the child does, and reports any problem through its run row.
 */
export function startBackgroundSearch(options: BackgroundSearchOptions): {
  started: boolean;
  message: string;
} {
  const { db, dbPath, configPath, spawn = defaultSpawn } = options;
  if (runningRunKeys(db, "search").has(SEARCH_RUN_KEY)) {
    return { started: false, message: "Search already running" };
  }
  // IGOR_NO_DELEGATE keeps the recorded pid the real worker rather than a
  // checkout-delegating wrapper.
  const proc = spawn({
    cmd: [
      process.execPath,
      `${import.meta.dir}/../cli.ts`,
      "search",
      "--db",
      dbPath,
      ...(configPath ? ["--config", configPath] : []),
    ],
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, [NO_DELEGATE_ENV]: "1" },
    detached: true,
  });
  proc.unref();
  // Record the child's pid now so the header shows it immediately.
  startRun(db, "search", SEARCH_RUN_KEY, proc.pid);
  return {
    started: true,
    message: "Searching in the background (survives quitting)...",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/tuiSearch.test.ts 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Wire `runTui` and the `tui` command**

`src/tui/index.ts`: change `TuiOptions` to

```ts
export interface TuiOptions {
  db: string;
  /** Config file forwarded to the detached `igor search` children. */
  config?: string;
}
```

and the `React.createElement` call to `React.createElement(JobBrowser, { db, dbPath: options.db, configPath: options.config, version })`.

`src/cli.ts` `tui` command: add `.option("--config <path>", CONFIG_HELP)` after its `--db` option, change the action to:

```ts
    .action(async (options: { db?: string; config?: string }) => {
      await runTui({
        db: resolveDbPath({ db: options.db, config: options.config }),
        config: options.config,
      });
    });
```

- [ ] **Step 6: Wire `App.tsx`**

Apply these edits to `src/tui/App.tsx`.

(a) Imports. Replace the `../db.ts` import block with:

```ts
import {
  SEARCH_RUN_KEY,
  allJobs,
  getRun,
  getTailorRun,
  getTailoredResume,
  runningRunKeys,
  runningTailorIds,
  setJobState,
  startTailorRun,
  tailoredListingIds,
} from "../db.ts";
```

and add `import { startBackgroundSearch } from "./search.ts";` next to the `./open.ts` import.

(b) Props. In `AppProps` add:

```ts
  /** Config file passed to the detached `igor search` children. */
  configPath?: string;
```

and change the signature to `export default function JobBrowser({ db, dbPath, configPath, version = null }: AppProps) {`. Update the `dbPath` doc comment to `/** Path to the sqlite file, passed to the detached igor children. */`.

(c) Footer. Change `const FOOTER_AFTER = " [⌃e] archived view [⌃r] refresh [q] quit";` to `const FOOTER_AFTER = " [⌃s] search [⌃e] archived view [⌃r] refresh [q] quit";`.

(d) State. Directly after the `const prevRunning = useRef<Set<string>>(tailoringIds);` line add:

```tsx
  // A detached `igor search` (the runs table is the source of truth).
  const [isSearching, setIsSearching] = useState(() =>
    runningRunKeys(db, "search").has(SEARCH_RUN_KEY),
  );
  const prevSearching = useRef(isSearching);
```

(e) Poll. In the polling effect (the one commented `// Poll for runs started/finished by (possibly earlier or other) processes.`), insert this before the closing `}, POLL_MS);`:

```tsx
      const searching = runningRunKeys(db, "search").has(SEARCH_RUN_KEY);
      if (prevSearching.current && !searching) {
        setJobs(allJobs(db));
        const run = getRun(db, "search", SEARCH_RUN_KEY);
        if (run?.message) {
          setStatusMessage(
            run.ok
              ? `Search done: ${run.message}`
              : `Search failed: ${run.message}`,
          );
        }
      }
      prevSearching.current = searching;
      setIsSearching(searching);
```

(`setStatusMessage`, not `showStatus`, on purpose: like the tailor result it stays until the next status so a failure can be read.)

(f) Pulse timer. Replace the effect

```tsx
  useEffect(() => {
    if (tailoringIds.size === 0) return;
    const timer = setInterval(() => setPulseTick((t) => t + 1), PULSE_TICK_MS);
    return () => clearInterval(timer);
  }, [tailoringIds.size]);
```

with

```tsx
  useEffect(() => {
    if (tailoringIds.size === 0 && !isSearching) return;
    const timer = setInterval(() => setPulseTick((t) => t + 1), PULSE_TICK_MS);
    return () => clearInterval(timer);
  }, [tailoringIds.size, isSearching]);
```

(g) Handler. After the `handleTailor` callback add:

```tsx
  const handleSearch = useCallback(() => {
    const result = startBackgroundSearch({ db, dbPath, configPath });
    if (result.started) {
      prevSearching.current = true;
      setIsSearching(true);
    }
    setStatusMessage(result.message);
  }, [db, dbPath, configPath]);
```

(h) Key binding. In `handleInput`, directly before `if (key.ctrl && input === "t" && selectedJob) {` add:

```tsx
      if (key.ctrl && input === "s") {
        handleSearch();
        return;
      }
```

and add `handleSearch,` to that callback's dependency array (next to `handleTailor,`).

(i) Header indicator. In the header's left `<Box flexShrink={1} marginRight={2}>`, after the `{version && (...)}` block, add:

```tsx
          {isSearching && (
            <Text color={pulseColor(pulseTick)}>{"  ⟳ searching…"}</Text>
          )}
```

This is a single line inside the existing header row, so `HEADER_LINES` and the layout math are unchanged.

(j) Empty state. Replace the two hint lines

```tsx
            <Text dimColor>Run a search first:</Text>
            <Text dimColor> igor search --role "software engineer"</Text>
```

with

```tsx
            <Text dimColor>Press ctrl+S to search (or run igor init first)</Text>
```

(one line replaces two; the empty state is centered content with no height math attached).

- [ ] **Step 7: Verify**

Run: `bun test 2>&1 | tail -20 && bun run typecheck 2>&1 | tail -10 && bunx @biomejs/biome check src tests 2>&1 | tail -10`
Expected: all green.

Manual check (needs a real terminal; if none is available, report this step as not run rather than skipping silently):
```bash
export T=$(mktemp -d) XDG_CONFIG_HOME=$T/c XDG_DATA_HOME=$T/d
bun run src/cli.ts init --location Omaha --keywords "software engineer" --work any
bun run tui
```
Press ctrl+S: the header shows `⟳ searching…` and the status line says it is running in the background. Quit with `q` while it runs, then `bun run tui` again: the indicator is still shown until the search finishes, then the job list reloads and a `Search done: N found, M new` status appears. Also confirm ctrl+S does not freeze the terminal (XOFF). Then delete the config (`rm $T/c/igor/config.toml`), press ctrl+S, and confirm the status shows `Search failed: no [[location]] configured ...`.

- [ ] **Step 8: Commit**

```bash
bunx @biomejs/biome check --write src/tui src/cli.ts tests/tuiSearch.test.ts
git add src/tui src/cli.ts tests/tuiSearch.test.ts
git commit -m "feat: ctrl+S starts a detached background search from the TUI" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Docs, example config, and the one-time DB copy

**Files:**
- Create: `igor.example.toml`
- Modify: `README.md` (usage block at lines 55-70, TUI block at 72-95), `.env.example`

- [ ] **Step 1: Write `igor.example.toml`**

```toml
# Copy to igor.toml (per project) or ~/.config/igor/config.toml (global).
# `igor init` writes the global one for you. A local igor.toml is merged over
# the global file: [job] keys override one by one, while [[location]] and
# [[keywords]] REPLACE the global lists if the local file defines them.

[job]
govmil = false            # true to include jobs that mention a clearance

# Uncomment for a self-contained sandbox next to this file (relative paths
# resolve against this file's directory). Default: ~/.local/share/igor/igor.db
# [db]
# path = "igor.db"

# Every keyword is searched in every location. At least one of each is required.
[[location]]
city = "Omaha"
flexibility = "in-person"  # remote | in-person (onsite or hybrid) | any (default)

[[location]]
city = "United States"
flexibility = "remote"     # remote jobs eligible in this region

[[keywords]]
role = "Software Engineer"

[[keywords]]
role = "DevOps Engineer"
```

- [ ] **Step 2: Update `README.md`**

Replace the `igor search` usage block (the fenced command and the bullet list under `## Usage`, README lines 55-70) with:

````markdown
## Setup

```bash
igor init
```

prompts for cities, roles (comma separated), and a work type, then writes
`~/.config/igor/config.toml` and creates `~/.local/share/igor/igor.db`
(`XDG_CONFIG_HOME` / `XDG_DATA_HOME` are honored). See `igor.example.toml`.

A `./igor.toml` in the current directory is merged over the global config:
`[job]` keys override one by one, and `[[location]]` / `[[keywords]]` replace
the global lists. `[db] path = "igor.db"` in a local file gives you a
self-contained sandbox (relative paths resolve against that file's
directory). `igor config` shows which files and database are in use.

Precedence, high to low: CLI flags, `IGOR_DB` / `IGOR_CONFIG` env, local
`igor.toml`, global `config.toml`, defaults. `--config <path>` (or
`IGOR_CONFIG`) uses only that one file.

`flexibility` per `[[location]]` is `remote` (remote jobs eligible in that
region, including "worldwide" listings), `in-person` (anything not marked
remote: onsite, hybrid, or unknown), or `any`. Only some sources say
hybrid vs onsite, so the two are not told apart.

## Usage

```bash
igor search [--role <query...>] [--location <city...>] [--remote|--onsite] [--clearance] [--json] [--csv] [--db <path>] [--config <path>]
```

- With no `--role`, the config's `[[keywords]]` and `[[location]]` entries drive the search
- `--role` — search for exactly these roles instead of the config (the config is not read); accepts multiple values, e.g. `--role engineer manager`
- `--location` — override the config's locations; accepts multiple values, e.g. `--location Omaha "San Francisco"`
- `--remote` / `--onsite` — only remote jobs / only non-remote jobs (mutually exclusive); overrides each location's `flexibility`
- `--clearance` — include jobs that mention a clearance requirement (excluded by default; `govmil = true` in the config does the same)
- `--json` — print all jobs currently stored in the db as JSON
- `--csv` — print all jobs currently stored in the db as CSV
- `--db` — path to the sqlite db (default: the global db)
- `--config` — config file to use instead of the global + local chain

A search records itself as a background run, so `igor search` started by
hand also shows up in the TUI.
````

In the TUI section change the usage line to `igor tui [--db <path>] [--config <path>]` and add to the key list, before `- ⌃t`:

```markdown
- ⌃s — search: runs `igor search` in the background from your config. It keeps running if you quit or restart the TUI, the header shows `searching…`, and the list reloads when it finishes
```

Also change any remaining README mention of the default `igor.db` path to the global db.

- [ ] **Step 3: Update `.env.example`**

Append:

```
# Optional overrides (see README "Setup"): where the sqlite db lives, and a
# config file to use instead of the global + ./igor.toml chain.
IGOR_DB=
IGOR_CONFIG=
```

- [ ] **Step 4: Full check**

Run: `bun run check 2>&1 | tail -20`
Expected: lint, typecheck, and the whole test suite pass.

- [ ] **Step 5: Commit**

```bash
git add igor.example.toml README.md .env.example
git commit -m "docs: config reference, example toml, and setup instructions" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: One-time copy of the main checkout's database (maintainer only)**

Run only after Tasks 1-9 are merged or the branch is what Tara runs. This copies, never moves; the original stays. `sqlite3 .backup` is WAL-safe even if a TUI has the db open. It refuses to clobber an existing global db.

```bash
SRC=/Users/kitsune/projects/igor/igor.db
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/igor/igor.db"
test -f "$SRC" || { echo "no source db at $SRC"; exit 1; }
test -e "$DEST" && { echo "refusing: $DEST already exists"; exit 1; }
mkdir -p "$(dirname "$DEST")" && sqlite3 "$SRC" ".backup '$DEST'" && echo "copied to $DEST"
bun run src/cli.ts jobs active --db "$DEST" | jq 'length'
```
Expected: `copied to ...` and a job count matching the source db. The legacy `tailor_runs` table in the copy is migrated to `runs` the first time igor opens it.

---

## Self-Review Notes

- **Spec coverage:** config schema and validation (Task 2); global/local layout, precedence, `--config`, `IGOR_*`, relative `[db] path` (Tasks 1, 3); `igor init` (Task 8); `igor config` (Task 7); `runs` table, migration, crash handling, search summary (Tasks 4, 6); flexibility filtering including hybrid-as-not-remote and remote region matching (Tasks 5, 6); `igor search` flag/config semantics and run registration (Task 6); `igor tailor` on `runs` (Task 4 wrappers); TUI Ctrl+S, header indicator, poll, reload, footer (Task 9); docs, example config, DB copy (Task 10).
- **Deliberate deviations from the spec's wording:** none beyond the two clarifications already written into the spec (env var names, init overwrite semantics, `--remote` with `--onsite` erroring).
- **Type consistency:** `SearchGroup`, `ResolvedConfig`, `Flexibility`, `startRun/finishRun/getRun/runningRunKeys/SEARCH_RUN_KEY`, `planSearch`, `collectJobs`, `resolveDbPath`, `loadSearchConfig`, `describeConfig`, `startBackgroundSearch` are defined once and used with the same names and signatures downstream.
