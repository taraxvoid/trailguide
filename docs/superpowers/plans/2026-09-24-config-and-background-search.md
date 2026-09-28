# TOML Config and Background Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a TOML config (global plus local override), `igor init`, one central work-type and location predicate, and a Ctrl+S TUI search that runs as a detached `igor search` process tracked in a generalized `runs` table.

**Architecture:** `src/config.ts` parses and validates TOML with `smol-toml`, merges the global and local files, resolves the DB path for every command, and turns flags or config into a `SearchPlan` (keywords times location targets). `src/sources/location.ts` owns the only work-type and location decision (`matches`, `remoteEligible`, `normalizeRemoteType`). Sources declare `scoped: boolean`; `src/search.ts` calls unscoped sources once per keyword with no location and scoped sources once per (keyword, location), then filters every job with the predicate for its location. `runSearch` returns `{ found, new, failures }` and records itself in a generic `runs(kind, key)` table that replaces `tailor_runs`. The TUI only resolves paths, spawns `igor search` detached, and polls `runs`.

**Tech Stack:** Bun 1.4 (`bun:sqlite`, `bun test`), `smol-toml` (new), commander, Ink 7 (React 19), biome, TypeScript strict with `noUncheckedIndexedAccess`.

**Spec:** `docs/superpowers/specs/2026-09-24-config-and-background-search-design.md` (revised 2026-09-28). The spec is binding; where this plan resolves an ambiguity it says so in "Self-Review Notes".

## Global Constraints

- Use `bun` for everything (`bun add`, `bun test`, `bun run typecheck`, `bunx @biomejs/biome ...`); no npm/node commands.
- One new dependency: `smol-toml` (BSD-3-Clause, zero transitive deps), added in Task 2 with `bun add smol-toml`. Parse with `parse`, write with `stringify`, and report `TomlError` as `<file>:<line>:<col>: <message>`. `Bun.TOML.parse` is not used. No other new dependencies (no schema library).
- Config files: global `${XDG_CONFIG_HOME:-~/.config}/igor/config.toml`; local `./igor.toml` merged over it. DB default `${XDG_DATA_HOME:-~/.local/share}/igor/igor.db`. Hard switch: no fallback to `./igor.db`.
- Config keys: `[job] govmil`, `[db] path`, `[[location]] city` + `flexibility` (`"remote" | "in-person" | "any"`, default `"any"`) + optional `region` (string or list of strings), `[[keywords]] role`. Unknown keys and wrong types are errors. At least one location and one keyword are required for a search.
- `[[location]]` and `[[keywords]]` in a local file replace the global lists (never concatenate). `[job]` scalars override per key.
- Precedence, high to low: CLI flags, `IGOR_*` env (`IGOR_DB`, `IGOR_CONFIG`), local `igor.toml`, global `config.toml`, defaults. `--config <path>` (or `IGOR_CONFIG`) replaces the whole file chain. No commander `--db` option has a default; `resolveDbPath` supplies the path.
- One predicate decides location and work type (`matches` in `src/sources/location.ts`). Sources never decide location for a search: unscoped sources are called without `location`.
- `runs` table: `PRIMARY KEY (kind, key)`; `kind` is `tailor` (key = listing id) or `search` (key = `search`).
- Every commit must leave `bun run typecheck` passing (the pre-commit hook runs project-wide `tsc`) and biome clean: run `bunx @biomejs/biome check --write <changed files>` before committing.
- Tests never read the developer's real config: every test that touches config, DB paths, or `runSearch` passes an explicit `cwd` and `env` pointing at a temp dir.
- Commit only on this worktree branch. Commit messages end with the trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` (pass it as a second `-m`).
- Prefer quiet output: pipe test runs through `2>&1 | tail -15`.
- Prose in docs and comments: no em dashes, no unicode arrows, no filler words.

## Review Focus

Inputs the spec implies but a plain happy-path test would miss. Each has a test in the task named in brackets.

- Config with keywords but no `[[location]]` (or the reverse) must fail loudly instead of running an unbounded search, and must not call any source. [Task 4, Task 10]
- A typo like `[[keyword]]` or `[[locations]]`, a wrong type, or malformed TOML must produce an error naming the file (and for syntax errors the line and column), not a silent empty config. [Task 2]
- "us" must not match "Houston" or "Australia"; "Remote - Europe" must not be eligible for "United States"; "Remote - Nebraska" is eligible for Omaha but an onsite Nebraska job is not an Omaha match. [Task 7]
- A remote job found via a `remote` location must survive even though another location is `in-person`, and the reverse. [Task 9]
- A second `igor search` while one is live must be refused without hitting any source, and a bad config discovered by a TUI-launched child (which always gets `--db`) must land in the run's message rather than "exited unexpectedly". [Task 10]
- A legacy DB with a live in-flight `tailor_runs` row must migrate without losing it, and opening twice must be idempotent. [Task 6]
- A relative `[db] path` must resolve against the config file's directory, not the cwd (the sandbox use case). [Task 3]
- `igor init` must never delete anything and must keep "Omaha, NE" as one location. [Task 11]

---

## File Structure

- Create `src/paths.ts`: XDG/global/local path helpers. One responsibility: where files live.
- Create `src/config.ts`: config types, `ConfigError`, `parseConfig` (smol-toml plus hand-written validation), `mergeConfigs`, `formatConfig`, `writeConfig`, `loadConfig` (file chain and env), `resolveDbPath` (the shared resolver), `describeConfig`, `toSearchOptions` (flags or config to a `SearchPlan`).
- Modify `src/sources/location.ts`: word-boundary `matchesLocation`, alias tables, `remoteEligible`, `normalizeRemoteType`, `matches`.
- Modify `src/sources/types.ts`: `NormalizedJob.otherLocations?`, `Source.scoped`.
- Modify every `src/sources/*.ts` source: declare `scoped`; ashby also reports secondary locations.
- Create `src/search.ts`: `collectJobs` (scoped/unscoped calls, per-location filtering, dedupe, internship and govmil filters), `formatRunMessage`, and the moved `isInternship` / `requiresClearance`.
- Modify `src/db.ts`: `openDb` creates parent dirs and has no default path; `runs` table, migration, `startRun` / `finishRun` / `getRun` / `runningRuns`, tailor wrappers.
- Modify `src/cli.ts`: shared DB resolver on every command, `--config`, `igor config`, `runSearch` refactor with run registration, `igor init`, `tui` forwarding.
- Create `src/init.ts`: `igor init` flow with injected IO.
- Create `src/tui/search.ts`: `startBackgroundSearch` with injected spawn, log file handling, `describeSearchRun`.
- Modify `src/tui/index.ts`, `src/tui/App.tsx`: Ctrl+S, "Searching..." indicator, poll `runs`, footer hint.
- Create `igor.example.toml`; modify `README.md`, `.env.example`.
- Tests: create `tests/paths.test.ts`, `tests/config.test.ts`, `tests/configLoad.test.ts`, `tests/searchOptions.test.ts`, `tests/search.test.ts`, `tests/runSearch.test.ts`, `tests/init.test.ts`, `tests/tuiSearch.test.ts`; extend `tests/cli.test.ts`, `tests/db.test.ts`, `tests/tailorRuns.test.ts`, `tests/location.test.ts`, `tests/sources.test.ts`.

---

## Dependencies and overlap

Tasks are written to be executed one at a time, in order, by implementers who only see their own task. This section is the contract between them.

### What each task produces and who consumes it

| Task | Produces (exact exports) | Consumed by |
| --- | --- | --- |
| 1 | `src/paths.ts`: `type Env = Record<string, string \| undefined>`; `globalConfigPath(env?: Env): string`; `globalDbPath(env?: Env): string`; `localConfigPath(cwd: string): string` | 3 (`loadConfig`, `resolveDbPath`), 10 (`Env` in `SearchDeps`), 11 (`globalConfigPath`, `Env`) |
| 2 | `src/config.ts`: `type Flexibility = "remote" \| "in-person" \| "any"`; `FLEXIBILITIES: readonly Flexibility[]`; `interface LocationEntry { city: string; flexibility: Flexibility; region: string[] }`; `interface IgorConfig { govmil?: boolean; db?: string; locations?: LocationEntry[]; keywords?: string[] }`; `class ConfigError extends Error`; `parseConfig(text: string, file: string): IgorConfig`; `mergeConfigs(base: IgorConfig, override: IgorConfig): IgorConfig`; `formatConfig(config: IgorConfig): string`; `writeConfig(path: string, config: IgorConfig): void`; dependency `smol-toml` | 3, 4, 5 (`ConfigError`), 7 (`Flexibility`), 11 (`writeConfig`, `Flexibility`, `ConfigError`) |
| 3 | `src/config.ts`: `interface ConfigContext { cwd?: string; env?: Env; config?: string }`; `interface LoadedConfig { config: IgorConfig; files: string[] }`; `loadConfig(ctx?: ConfigContext): LoadedConfig`; `resolveDbPath(ctx?: ConfigContext & { db?: string }): string` (always absolute); `describeConfig(ctx?: ConfigContext): string` | 4 (`LoadedConfig`), 5 (`resolveDbPath`, `describeConfig`), 10 (`loadConfig`, `resolveDbPath`), 11 (`resolveDbPath`), 13 (`resolveDbPath`) |
| 4 | `src/config.ts`: `interface SearchTarget { city: string \| null; flexibility: Flexibility; region: string[] }`; `interface SearchPlan { keywords: string[]; targets: SearchTarget[]; govmil: boolean }`; `interface SearchFlags { role?: string[]; location?: string[]; remote?: boolean; onsite?: boolean; clearance?: boolean }`; `toSearchOptions(flags: SearchFlags, load: () => LoadedConfig): SearchPlan` | 7 (`SearchTarget`), 9 (`SearchPlan`, `SearchTarget`), 10 (`toSearchOptions`) |
| 5 | `src/db.ts`: `openDb(path: string): Database` (creates parent dirs, no default). `src/cli.ts`: `SearchOptions.db?: string`, `SearchOptions.config?: string`; `DB_HELP`, `CONFIG_HELP` constants; `igor config` command; `--config` on `search` and `tui`; `ConfigError` printed as `error: <message>` by `main` | 6 (edits the same `openDb`), 10, 11 (`DB_HELP`), 13 (`tui` action) |
| 6 | `src/db.ts`: `type RunKind = "tailor" \| "search"`; `SEARCH_RUN_KEY = "search"`; `interface Run { kind: RunKind; key: string; pid: number; startedAt: string; finishedAt: string \| null; ok: boolean \| null; message: string \| null }`; `getRun(db, kind, key): Run \| null`; `startRun(db, kind, key, pid, now?): boolean`; `finishRun(db, kind, key, ok, message, now?): void`; `runningRuns(db, kind): Run[]`; wrappers `getTailorRun(db, listingId): Run \| null`, `startTailorRun`, `finishTailorRun`, `runningTailorIds(db): Set<string>` (signatures unchanged except `Run` replaces the removed `TailorRun`) | 10 (`startRun`, `finishRun`, `SEARCH_RUN_KEY`), 12 (`runningRuns`, `startRun`, `Run`), 13 (`getRun`, `runningRuns`, `SEARCH_RUN_KEY`); `src/cli.ts` `runTailor` and `App.tsx` keep using the wrappers |
| 7 | `src/sources/location.ts`: `matchesLocation(jobLocation: string, queryLocation: string \| string[]): boolean` (word boundaries); `remoteEligible(jobLocation: string, city: string, region?: string[]): boolean`; `normalizeRemoteType<T extends Pick<NormalizedJob, "location" \| "remoteType">>(job: T): T`; `matches(job: Pick<NormalizedJob, "location" \| "remoteType" \| "otherLocations">, target: SearchTarget, options?: { scoped?: boolean }): boolean`. `src/sources/types.ts`: `NormalizedJob.otherLocations?: string[]` | 8 (ashby fills `otherLocations`), 9 (`matches`, `normalizeRemoteType`) |
| 8 | `src/sources/types.ts`: `Source.scoped: boolean`; every source sets it (`jsearch`, `adzuna` true; the rest false); ashby sets `otherLocations` | 9 (splits sources by `scoped`), 9 and 10 tests (fake sources must declare `scoped`) |
| 9 | `src/search.ts`: `interface SourceFailure { source: string; message: string }`; `interface CollectResult { jobs: NormalizedJob[]; failures: SourceFailure[]; allFailed: boolean }`; `interface SearchResult { found: number; new: number; failures: SourceFailure[] }`; `collectJobs(plan: SearchPlan, sources: Source[]): Promise<CollectResult>`; `formatRunMessage(result: SearchResult): string`; `isInternship`, `requiresClearance` (moved from `cli.ts`, re-exported by `cli.ts`) | 10 |
| 10 | `src/cli.ts`: `SearchOptions.role?: string[]`; `interface SearchDeps { sources?: Source[]; isUrlDead?: (url: string) => Promise<boolean>; cwd?: string; env?: Env }`; `runSearch(options: SearchOptions, deps?: SearchDeps): Promise<SearchResult \| null>`; `createProgram` first parameter typed `(options: SearchOptions) => Promise<unknown>`; `--role` optional | 12 and 13 (the spawned child runs this code path) |
| 11 | `src/init.ts`: `interface InitOptions { location?: string[]; keywords?: string[]; work?: string[]; yes?: boolean; db?: string }`; `interface InitIO { ask(question: string): Promise<string>; log(message: string): void; env?: Env; cwd?: string }`; `parseWork(value: string): Flexibility \| null`; `parseWorkFlags(values: string[], cities: string[]): Flexibility[] \| null`; `runInit(options: InitOptions, io: InitIO): Promise<boolean>`; `terminalIO(): InitIO & { close(): void }`. `src/cli.ts`: `igor init` command | 14 (README describes it) |
| 12 | `src/tui/search.ts`: `interface SpawnRequest { cmd: string[]; cwd: string; env: Record<string, string \| undefined>; stdio: ["ignore", number, number]; detached: true }`; `interface SpawnedProcess { pid: number; unref(): void }`; `type SpawnFn = (request: SpawnRequest) => SpawnedProcess`; `searchLogPath(dbPath: string): string`; `startBackgroundSearch(options: { db: Database; dbPath: string; configPath?: string; cwd?: string; spawn?: SpawnFn }): { started: boolean; message: string }`; `describeSearchRun(run: Run, dbPath: string): string` | 13 |
| 13 | `TuiOptions.config?: string`; `JobBrowser` prop `configPath?: string`; Ctrl+S handler; footer `search [⌃s]` | 14 (README key list) |
| 14 | `igor.example.toml`, README sections, `.env.example` entries | none |
| 15 | Copy of the main checkout DB at the global path (maintainer only, after confirmation) | none |

### Files touched by more than one task

Each later task edits the file as the earlier task left it. Edits are anchored on text, not line numbers; if an anchor is missing, the earlier task was not applied and the implementer must stop.

| File | Earlier task: what it changes | Later task: what it changes |
| --- | --- | --- |
| `src/config.ts` | 2: creates the file (imports from `node:fs`, `node:path`, `smol-toml`; types; `ConfigError`; `parseConfig`; `mergeConfigs`; `formatConfig`; `writeConfig`) | 3: replaces the import block (adds `existsSync`, `readFileSync`, `./paths.ts`), appends `ConfigContext`, `LoadedConfig`, `loadConfig`, `resolveDbPath`, `describeConfig`. 4: appends `SearchTarget`, `SearchPlan`, `SearchFlags`, `toSearchOptions` at the end. Neither edits code from Task 2. |
| `package.json`, `bun.lock` | 2: `bun add smol-toml` | none |
| `src/db.ts` | 5: import block (adds `mkdirSync`, `dirname`), first two lines of `openDb` (signature without default, `mkdirSync`) | 6: replaces the `busy_timeout` comment, the `tailor_runs` `CREATE TABLE` block at the end of `openDb`, adds `migrateTailorRuns` above `openDb`, replaces everything from `export interface TailorRun {` to end of file. Does not touch imports or the start of `openDb`. |
| `src/cli.ts` | 5: adds `./config.ts` import; `SearchOptions` gets `db?`, `config?`; the `openDb` line and summary line inside `runSearch`; `runClear`, `runRefresh`, `runJobs`, `runTailor` use `resolveDbPath`; `JobsCliOptions.db?`, `TailorCliOptions.db?`; every `--db` option loses its default; `DB_HELP`, `CONFIG_HELP`; `--config` on `search` and `tui`; `igor config` command; `main` catch | 9: deletes `INTERNSHIP_PATTERN`, `GOVMIL_PATTERN`, `isInternship`, `requiresClearance`; adds import and re-export from `./search.ts`. 10: replaces the whole `SearchOptions` interface and `runSearch` function (Task 5's version) with the new ones; extends imports (`./db.ts`, `./config.ts`, `./search.ts`, `./paths.ts`); `--role` becomes `.option`; `searchAction` type. 11: adds `./init.ts` import, `collect` helper, `init` command before `return program;`. 13: `node:path` import gains `resolve`; replaces the `tui` command's `.action`. |
| `tests/cli.test.ts` | 5: "parses clear with defaults" and "applies defaults when only --role is given" drop `igor.db`; adds `--config` and `config` command tests | 10: replaces the "requires --role" test. 11: appends an `init command` describe. |
| `src/sources/types.ts` | 7: adds `otherLocations?: string[]` to `NormalizedJob` | 8: adds `scoped: boolean` to `Source` |
| `src/sources/ashby.ts` | none before 8 | 8: `scoped: false` and `otherLocations` |
| `src/sources/location.ts` | 7 only (full rewrite) | none; 9 imports it |
| `tests/sources.test.ts` | 8 only | none |
| `src/tui/App.tsx`, `src/tui/index.ts` | 13 only | none (Task 12 creates `src/tui/search.ts` and does not touch `App.tsx`) |
| `README.md`, `.env.example` | 14 only | none |

### Required order

Strictly sequential: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15. This follows the spec's implementation order (config and DB path resolution including the `--db` defaults, then `runs`, then the `runSearch` refactor, then `init`, the TUI, and the rollout copy), with the predicate and source changes (7, 8) placed before the refactor that needs them.

Pairs that can never run in parallel, because they edit the same file or one consumes an export the other creates:

- 2, 3, 4 (`src/config.ts`, and each needs the previous one's types).
- 5 and 6 (`src/db.ts`); 6 also needs 5's `openDb` shape.
- 5, 9, 10, 11, 13 (`src/cli.ts`); 5, 10, 11 also share `tests/cli.test.ts`.
- 7 and 8 (`src/sources/types.ts`).
- 7, 8 before 9 (predicate and `scoped`), 9 before 10, 6 before 10, 6 before 12, 12 before 13.
- 14 after 11 and 13 (documents both). 15 last, after everything is merged or is what Tara runs.

The only pairs with disjoint files and no data dependency are (6, 7), (6, 8), and (11, 12). They are still run in order; do not parallelize them unless the plan is re-reviewed, because each commit must keep the project-wide typecheck green and a parallel branch would be tested against a different base.

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

### Task 2: Config parsing, validation, and writing (smol-toml)

**Files:**
- Modify: `package.json`, `bun.lock` (via `bun add smol-toml`)
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (all exported from `src/config.ts`):
  - `type Flexibility = "remote" | "in-person" | "any"`; `const FLEXIBILITIES: readonly Flexibility[]`
  - `interface LocationEntry { city: string; flexibility: Flexibility; region: string[] }` (`region` is always a list after parsing; empty when absent)
  - `interface IgorConfig { govmil?: boolean; db?: string; locations?: LocationEntry[]; keywords?: string[] }`
  - `class ConfigError extends Error`
  - `parseConfig(text: string, file: string): IgorConfig`
  - `mergeConfigs(base: IgorConfig, override: IgorConfig): IgorConfig`
  - `formatConfig(config: IgorConfig): string` (TOML text via `smol-toml` `stringify`)
  - `writeConfig(path: string, config: IgorConfig): void` (creates the parent dir)

Validation messages follow one pattern, `<file>: <where> ...`, where `<where>` is `top level`, `[job]`, `[db]`, or `[[location]] entry N` / `[[keywords]] entry N` (1-based):
- missing field: `igor.toml: [[keywords]] entry 2 is missing "role"`
- unknown key: `igor.toml: top level has unknown key "keyword" (expected job, db, location, keywords)`
- wrong type: `igor.toml: [job] "govmil" must be true or false`, `igor.toml: [[location]] entry 1 "region" must be a string or a list of strings`
- bad enum: `igor.toml: [[location]] entry 1 has invalid flexibility "onsite" (use remote, in-person, or any)`
- syntax: `igor.toml:3:7: <smol-toml reason>` (first line of the `TomlError` message, without the `Invalid TOML document: ` prefix)

Required-ness of `[[location]]` and `[[keywords]]` is not checked here, because a local file may legitimately define only `[job]`. It is enforced when a search is planned (Task 4).

- [ ] **Step 1: Add the dependency**

Run: `bun add smol-toml 2>&1 | tail -3`
Expected: `installed smol-toml@1.x`. Confirm the license gate still passes: `bun run check:licenses 2>&1 | tail -3` (smol-toml is BSD-3-Clause).

- [ ] **Step 2: Write the failing test**

Create `tests/config.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  formatConfig,
  mergeConfigs,
  parseConfig,
  writeConfig,
} from "../src/config.ts";

const FULL = `
[job]
govmil = true

[db]
path = "sandbox.db"

[[location]]
city = "Omaha"
flexibility = "in-person"
region = ["Nebraska"]

[[location]]
city = "United States"
flexibility = "remote"

[[keywords]]
role = "Software Engineer"

[[keywords]]
role = "DevOps Engineer"
`;

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a throw");
}

describe("parseConfig", () => {
  it("parses every section", () => {
    expect(parseConfig(FULL, "/etc/igor/igor.toml")).toEqual({
      govmil: true,
      db: "/etc/igor/sandbox.db",
      locations: [
        { city: "Omaha", flexibility: "in-person", region: ["Nebraska"] },
        { city: "United States", flexibility: "remote", region: [] },
      ],
      keywords: ["Software Engineer", "DevOps Engineer"],
    });
  });

  it("defaults flexibility to any and accepts region as a single string", () => {
    const config = parseConfig(
      '[[location]]\ncity = "Austin"\nregion = "Texas"\n',
      "igor.toml",
    );
    expect(config.locations).toEqual([
      { city: "Austin", flexibility: "any", region: ["Texas"] },
    ]);
  });

  it("keeps a city with a comma as one location", () => {
    const config = parseConfig('[[location]]\ncity = "Omaha, NE"\n', "x.toml");
    expect(config.locations?.[0]?.city).toBe("Omaha, NE");
  });

  it("keeps absolute db paths as they are", () => {
    expect(parseConfig('[db]\npath = "/data/x.db"\n', "igor.toml").db).toBe(
      "/data/x.db",
    );
  });

  it("rejects typo'd table names at the top level", () => {
    expect(() => parseConfig('[[keyword]]\nrole = "x"\n', "igor.toml")).toThrow(
      'igor.toml: top level has unknown key "keyword" (expected job, db, location, keywords)',
    );
    expect(() =>
      parseConfig('[[locations]]\ncity = "x"\n', "igor.toml"),
    ).toThrow('unknown key "locations"');
  });

  it("rejects unknown keys inside known tables", () => {
    expect(() => parseConfig("[job]\nclearance = true\n", "igor.toml")).toThrow(
      'igor.toml: [job] has unknown key "clearance" (expected govmil)',
    );
    expect(() =>
      parseConfig(
        '[[keywords]]\nrole = "A"\n[[keywords]]\nname = "B"\n',
        "igor.toml",
      ),
    ).toThrow('igor.toml: [[keywords]] entry 2 has unknown key "name"');
  });

  it("names the entry that is missing a field", () => {
    expect(() =>
      parseConfig(
        '[[keywords]]\nrole = "A"\n[[keywords]]\nrole = ""\n',
        "igor.toml",
      ),
    ).toThrow('igor.toml: [[keywords]] entry 2 is missing "role"');
    expect(() =>
      parseConfig(
        '[[location]]\ncity = "A"\n[[location]]\nflexibility = "any"\n',
        "igor.toml",
      ),
    ).toThrow('igor.toml: [[location]] entry 2 is missing "city"');
  });

  it("rejects wrong types", () => {
    expect(() => parseConfig('[job]\ngovmil = "yes"\n', "igor.toml")).toThrow(
      'igor.toml: [job] "govmil" must be true or false',
    );
    expect(() =>
      parseConfig('[[location]]\ncity = "A"\nregion = [1]\n', "igor.toml"),
    ).toThrow(
      'igor.toml: [[location]] entry 1 "region" must be a string or a list of strings',
    );
    expect(() => parseConfig("[[keywords]]\nrole = 3\n", "igor.toml")).toThrow(
      'igor.toml: [[keywords]] entry 1 "role" must be a string',
    );
    expect(() => parseConfig('keywords = "swe"\n', "igor.toml")).toThrow(
      'igor.toml: "keywords" must be written as [[keywords]] tables',
    );
  });

  it("rejects an invalid flexibility and lists the valid ones", () => {
    expect(() =>
      parseConfig(
        '[[location]]\ncity = "A"\nflexibility = "onsite"\n',
        "igor.toml",
      ),
    ).toThrow(
      'igor.toml: [[location]] entry 1 has invalid flexibility "onsite" (use remote, in-person, or any)',
    );
  });

  it("reports TOML syntax errors as file:line:col: message", () => {
    const first = errorOf(() => parseConfig("[[location\n", "bad.toml"));
    expect(first).toBeInstanceOf(ConfigError);
    expect(first.message).toMatch(/^bad\.toml:1:\d+: \S/);
    expect(first.message).not.toContain("\n");
    expect(first.message).not.toContain("Invalid TOML document");

    const second = errorOf(() =>
      parseConfig('[job]\ngovmil = "unterminated\n', "bad.toml"),
    );
    expect(second.message).toMatch(/^bad\.toml:2:\d+: \S/);
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
    expect(merged.locations).toEqual([
      { city: "Austin", flexibility: "any", region: [] },
    ]);
    expect(merged.keywords).toEqual(["Software Engineer", "DevOps Engineer"]);
    expect(merged.db).toBe("/g/sandbox.db");
  });

  it("leaves the base untouched when the override is empty", () => {
    expect(mergeConfigs(base, {})).toEqual(base);
  });
});

describe("formatConfig / writeConfig", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("round-trips through parseConfig", () => {
    const config = parseConfig(FULL, "/etc/igor/igor.toml");
    expect(parseConfig(formatConfig(config), "/etc/igor/igor.toml")).toEqual(
      config,
    );
  });

  it("escapes quotes and omits empty regions", () => {
    const text = formatConfig({
      locations: [{ city: "Omaha, NE", flexibility: "any", region: [] }],
      keywords: ['C "sharp" dev'],
    });
    expect(text).not.toContain("region");
    expect(parseConfig(text, "x.toml").keywords).toEqual(['C "sharp" dev']);
  });

  it("writes the file, creating missing directories", () => {
    dir = mkdtempSync(join(tmpdir(), "igor-config-"));
    const path = join(dir, "a", "b", "config.toml");
    writeConfig(path, { govmil: false, keywords: ["swe"] });
    expect(parseConfig(readFileSync(path, "utf8"), path)).toEqual({
      govmil: false,
      keywords: ["swe"],
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/config.test.ts 2>&1 | tail -15`
Expected: FAIL, cannot find module `../src/config.ts`.

- [ ] **Step 4: Write minimal implementation**

Create `src/config.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { TomlError, parse, stringify } from "smol-toml";

export type Flexibility = "remote" | "in-person" | "any";
export const FLEXIBILITIES: readonly Flexibility[] = [
  "remote",
  "in-person",
  "any",
];

export interface LocationEntry {
  city: string;
  flexibility: Flexibility;
  /** Extra terms a remote listing may match; never used for onsite matching. */
  region: string[];
}

/** What one config file (or a merge of several) says; everything optional. */
export interface IgorConfig {
  govmil?: boolean;
  /** Absolute path (relative values are resolved against the file's dir). */
  db?: string;
  locations?: LocationEntry[];
  keywords?: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function parseToml(text: string, file: string): Table {
  try {
    return parse(text) as Table;
  } catch (err) {
    if (err instanceof TomlError) {
      const reason = (err.message.split("\n")[0] ?? err.message).replace(
        /^Invalid TOML document: /,
        "",
      );
      throw new ConfigError(`${file}:${err.line}:${err.column}: ${reason}`);
    }
    throw err;
  }
}

function rejectUnknown(
  file: string,
  where: string,
  table: Table,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(table)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(
        `${file}: ${where} has unknown key "${key}" (expected ${allowed.join(", ")})`,
      );
    }
  }
}

function tableArray(file: string, name: string, value: unknown): Table[] {
  if (!Array.isArray(value) || !value.every(isTable)) {
    throw new ConfigError(
      `${file}: "${name}" must be written as [[${name}]] tables`,
    );
  }
  return value as Table[];
}

function requireString(
  file: string,
  where: string,
  entry: Table,
  key: string,
): string {
  const value = entry[key];
  if (value === undefined || (typeof value === "string" && !value.trim())) {
    throw new ConfigError(`${file}: ${where} is missing "${key}"`);
  }
  if (typeof value !== "string") {
    throw new ConfigError(`${file}: ${where} "${key}" must be a string`);
  }
  return value.trim();
}

function parseRegion(file: string, where: string, value: unknown): string[] {
  if (value === undefined) return [];
  const list = typeof value === "string" ? [value] : value;
  if (
    !Array.isArray(list) ||
    !list.every((item) => typeof item === "string")
  ) {
    throw new ConfigError(
      `${file}: ${where} "region" must be a string or a list of strings`,
    );
  }
  return (list as string[]).map((item) => item.trim()).filter(Boolean);
}

export function parseConfig(text: string, file: string): IgorConfig {
  const raw = parseToml(text, file);
  rejectUnknown(file, "top level", raw, ["job", "db", "location", "keywords"]);
  const config: IgorConfig = {};

  if (raw.job !== undefined) {
    if (!isTable(raw.job)) throw new ConfigError(`${file}: [job] must be a table`);
    rejectUnknown(file, "[job]", raw.job, ["govmil"]);
    if (raw.job.govmil !== undefined) {
      if (typeof raw.job.govmil !== "boolean") {
        throw new ConfigError(`${file}: [job] "govmil" must be true or false`);
      }
      config.govmil = raw.job.govmil;
    }
  }

  if (raw.db !== undefined) {
    if (!isTable(raw.db)) throw new ConfigError(`${file}: [db] must be a table`);
    rejectUnknown(file, "[db]", raw.db, ["path"]);
    const path = requireString(file, "[db]", raw.db, "path");
    config.db = isAbsolute(path) ? path : resolve(dirname(file), path);
  }

  if (raw.location !== undefined) {
    config.locations = tableArray(file, "location", raw.location).map(
      (entry, i) => {
        const where = `[[location]] entry ${i + 1}`;
        rejectUnknown(file, where, entry, ["city", "flexibility", "region"]);
        const city = requireString(file, where, entry, "city");
        const flexibility = entry.flexibility ?? "any";
        if (
          typeof flexibility !== "string" ||
          !FLEXIBILITIES.includes(flexibility as Flexibility)
        ) {
          throw new ConfigError(
            `${file}: ${where} has invalid flexibility ${JSON.stringify(flexibility)} (use remote, in-person, or any)`,
          );
        }
        return {
          city,
          flexibility: flexibility as Flexibility,
          region: parseRegion(file, where, entry.region),
        };
      },
    );
  }

  if (raw.keywords !== undefined) {
    config.keywords = tableArray(file, "keywords", raw.keywords).map(
      (entry, i) => {
        const where = `[[keywords]] entry ${i + 1}`;
        rejectUnknown(file, where, entry, ["role"]);
        return requireString(file, where, entry, "role");
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
  const merged: IgorConfig = { ...base };
  if (override.govmil !== undefined) merged.govmil = override.govmil;
  if (override.db !== undefined) merged.db = override.db;
  if (override.locations !== undefined) merged.locations = override.locations;
  if (override.keywords !== undefined) merged.keywords = override.keywords;
  return merged;
}

export function formatConfig(config: IgorConfig): string {
  const doc: Record<string, unknown> = {};
  if (config.govmil !== undefined) doc.job = { govmil: config.govmil };
  if (config.db !== undefined) doc.db = { path: config.db };
  if (config.locations) {
    doc.location = config.locations.map(({ city, flexibility, region }) =>
      region.length > 0 ? { city, flexibility, region } : { city, flexibility },
    );
  }
  if (config.keywords) doc.keywords = config.keywords.map((role) => ({ role }));
  const text = stringify(doc);
  return text.endsWith("\n") || text === "" ? text : `${text}\n`;
}

export function writeConfig(path: string, config: IgorConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatConfig(config));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/config.test.ts 2>&1 | tail -15`
Expected: PASS. If the syntax-error test fails only because this smol-toml version words its reason differently, keep the implementation and the `file:line:col:` regex; do not assert on the reason text.

- [ ] **Step 6: Commit**

```bash
bunx @biomejs/biome check --write src/config.ts tests/config.test.ts
bun run typecheck 2>&1 | tail -5
git add package.json bun.lock src/config.ts tests/config.test.ts
git commit -m "feat: TOML config parsing and validation with smol-toml" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Config chain loading and the shared DB path resolver

**Files:**
- Modify: `src/config.ts` (import block; append new exports at the end)
- Test: `tests/configLoad.test.ts`

**Interfaces:**
- Consumes: `Env`, `globalConfigPath`, `globalDbPath`, `localConfigPath` (Task 1); `parseConfig`, `mergeConfigs`, `formatConfig`, `ConfigError`, `IgorConfig` (Task 2).
- Produces (from `src/config.ts`):
  - `interface ConfigContext { cwd?: string; env?: Env; config?: string }`
  - `interface LoadedConfig { config: IgorConfig; files: string[] }` (`files` lowest precedence first)
  - `loadConfig(ctx?: ConfigContext): LoadedConfig`: `--config` (then `IGOR_CONFIG`) replaces the chain with one file, which must exist; otherwise the global file then `./igor.toml`, each optional. Read on every call, never cached.
  - `resolveDbPath(ctx?: ConfigContext & { db?: string }): string`: `--db`, then `IGOR_DB`, then `[db] path`, then the global default. Always absolute (flag and env values resolve against `cwd`). Does not read any config file when `--db` or `IGOR_DB` decides.
  - `describeConfig(ctx?: ConfigContext): string`: the text `igor config` prints.

- [ ] **Step 1: Write the failing test**

Create `tests/configLoad.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describeConfig, loadConfig, resolveDbPath } from "../src/config.ts";

let root: string;
let cwd: string;
let env: Record<string, string>;

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const globalFile = () => join(root, "cfg", "igor", "config.toml");
const localFile = () => join(cwd, "igor.toml");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "igor-load-"));
  cwd = join(root, "proj");
  mkdirSync(cwd, { recursive: true });
  env = {
    XDG_CONFIG_HOME: join(root, "cfg"),
    XDG_DATA_HOME: join(root, "data"),
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadConfig", () => {
  it("returns an empty config when no file exists", () => {
    expect(loadConfig({ cwd, env })).toEqual({ config: {}, files: [] });
  });

  it("layers the local file over the global one", () => {
    write(
      globalFile(),
      '[job]\ngovmil = true\n[[location]]\ncity = "Omaha"\n[[keywords]]\nrole = "swe"\n',
    );
    write(localFile(), '[[location]]\ncity = "Austin"\n');
    const { config, files } = loadConfig({ cwd, env });
    expect(files).toEqual([globalFile(), localFile()]);
    expect(config.govmil).toBe(true);
    expect(config.locations).toEqual([
      { city: "Austin", flexibility: "any", region: [] },
    ]);
    expect(config.keywords).toEqual(["swe"]);
  });

  it("uses only the explicit --config file, ignoring the chain", () => {
    write(localFile(), '[[location]]\ncity = "Austin"\n');
    write(join(root, "other.toml"), '[[location]]\ncity = "Reno"\n');
    const { config, files } = loadConfig({
      cwd,
      env,
      config: join(root, "other.toml"),
    });
    expect(files).toEqual([join(root, "other.toml")]);
    expect(config.locations?.[0]?.city).toBe("Reno");
  });

  it("honors IGOR_CONFIG the same way, with the flag winning", () => {
    write(join(root, "env.toml"), '[[location]]\ncity = "Env"\n');
    write(join(root, "flag.toml"), '[[location]]\ncity = "Flag"\n');
    const envConfig = { ...env, IGOR_CONFIG: join(root, "env.toml") };
    expect(loadConfig({ cwd, env: envConfig }).config.locations?.[0]?.city).toBe(
      "Env",
    );
    expect(
      loadConfig({ cwd, env: envConfig, config: join(root, "flag.toml") })
        .config.locations?.[0]?.city,
    ).toBe("Flag");
  });

  it("errors when an explicit config file is missing", () => {
    expect(() =>
      loadConfig({ cwd, env, config: join(root, "nope.toml") }),
    ).toThrow(`config file not found: ${join(root, "nope.toml")}`);
  });

  it("names the offending file for a malformed config", () => {
    write(localFile(), "[[keyword]]\nrole = 'x'\n");
    expect(() => loadConfig({ cwd, env })).toThrow(
      `${localFile()}: top level has unknown key "keyword"`,
    );
  });

  it("re-reads the files on every call", () => {
    write(localFile(), '[[keywords]]\nrole = "a"\n');
    expect(loadConfig({ cwd, env }).config.keywords).toEqual(["a"]);
    write(localFile(), '[[keywords]]\nrole = "b"\n');
    expect(loadConfig({ cwd, env }).config.keywords).toEqual(["b"]);
  });
});

describe("resolveDbPath", () => {
  it("defaults to the global data dir", () => {
    expect(resolveDbPath({ cwd, env })).toBe(
      join(root, "data", "igor", "igor.db"),
    );
  });

  it("prefers flag, then IGOR_DB, then config, then default", () => {
    write(localFile(), '[db]\npath = "/from/config.db"\n');
    expect(resolveDbPath({ cwd, env })).toBe("/from/config.db");
    const withEnv = { ...env, IGOR_DB: "/from/env.db" };
    expect(resolveDbPath({ cwd, env: withEnv })).toBe("/from/env.db");
    expect(resolveDbPath({ cwd, env: withEnv, db: "/from/flag.db" })).toBe(
      "/from/flag.db",
    );
  });

  it("makes relative flag and env values absolute against the cwd", () => {
    expect(resolveDbPath({ cwd, env, db: "x.db" })).toBe(join(cwd, "x.db"));
    expect(resolveDbPath({ cwd, env: { ...env, IGOR_DB: "y.db" } })).toBe(
      join(cwd, "y.db"),
    );
  });

  it("does not read the config when --db decides", () => {
    write(localFile(), "not toml at all [[[");
    expect(resolveDbPath({ cwd, env, db: "/abs.db" })).toBe("/abs.db");
  });

  it("resolves a relative [db] path against the config file's directory", () => {
    write(localFile(), '[db]\npath = "sandbox.db"\n');
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    expect(resolveDbPath({ cwd: elsewhere, env, config: localFile() })).toBe(
      join(cwd, "sandbox.db"),
    );
    expect(resolveDbPath({ cwd, env })).toBe(join(cwd, "sandbox.db"));
  });
});

describe("describeConfig", () => {
  it("lists files, the db path, and the merged config", () => {
    write(localFile(), '[[location]]\ncity = "Omaha"\nflexibility = "remote"\n');
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

Run: `bun test tests/configLoad.test.ts 2>&1 | tail -15`
Expected: FAIL, `loadConfig` is not exported from `src/config.ts`.

- [ ] **Step 3: Implement**

In `src/config.ts`, replace the first two import lines

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
```

with

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  type Env,
  globalConfigPath,
  globalDbPath,
  localConfigPath,
} from "./paths.ts";
```

Append at the end of `src/config.ts`:

```ts
export interface ConfigContext {
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

/** Reads the config chain from disk. Called per use; never cached. */
export function loadConfig(ctx: ConfigContext = {}): LoadedConfig {
  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;

  const explicit = ctx.config ?? (env.IGOR_CONFIG || undefined);
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

/**
 * The shared DB resolver for every command: --db, then IGOR_DB, then
 * `[db] path` from the config chain, then the global default. Always
 * absolute, so it can be handed to child processes as is.
 */
export function resolveDbPath(
  ctx: ConfigContext & { db?: string } = {},
): string {
  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;
  // Higher-precedence sources decide without reading (or failing on) config.
  if (ctx.db) return resolve(cwd, ctx.db);
  if (env.IGOR_DB) return resolve(cwd, env.IGOR_DB);
  return loadConfig(ctx).config.db ?? globalDbPath(env);
}

export function describeConfig(ctx: ConfigContext = {}): string {
  const env = ctx.env ?? process.env;
  const { config, files } = loadConfig(ctx);
  const filesText =
    files.length > 0
      ? `config files (later entries override earlier):\n${files.map((f) => `  ${f}`).join("\n")}`
      : `config files: none (run "igor init" to create ${globalConfigPath(env)})`;
  return [
    filesText,
    `database: ${resolveDbPath(ctx)}`,
    "",
    formatConfig(config).trimEnd(),
  ].join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/configLoad.test.ts tests/config.test.ts 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bunx @biomejs/biome check --write src/config.ts tests/configLoad.test.ts
bun run typecheck 2>&1 | tail -5
git add src/config.ts tests/configLoad.test.ts
git commit -m "feat: config file chain, IGOR_* env, and shared db path resolver" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `toSearchOptions` (flags or config to a search plan)

**Files:**
- Modify: `src/config.ts` (append at the end)
- Test: `tests/searchOptions.test.ts`

**Interfaces:**
- Consumes: `Flexibility`, `ConfigError` (Task 2); `LoadedConfig` (Task 3).
- Produces (from `src/config.ts`):
  - `interface SearchTarget { city: string | null; flexibility: Flexibility; region: string[] }` (`city: null` means no location was given: both location checks pass)
  - `interface SearchPlan { keywords: string[]; targets: SearchTarget[]; govmil: boolean }`
  - `interface SearchFlags { role?: string[]; location?: string[]; remote?: boolean; onsite?: boolean; clearance?: boolean }` (the CLI's `SearchOptions` is assignable to it)
  - `toSearchOptions(flags: SearchFlags, load: () => LoadedConfig): SearchPlan`

Rules (from the spec's "CLI changes"):
- `--remote` with `--onsite` throws `ConfigError("--remote and --onsite are mutually exclusive")`.
- With `--role`, the flags are the whole search and `load` is never called. `--location` values become targets with flexibility `remote` (`--remote`), `in-person` (`--onsite`), or `any`; without `--location` there is one target with `city: null`. `govmil` is `--clearance`.
- Without `--role`, `load()` supplies keywords and locations. No file found: `ConfigError` hinting at `igor init`. No keywords or no locations (and no `--location`): `ConfigError` naming the files. `--location` replaces the config's locations; `--remote`/`--onsite` override every location's flexibility; `govmil` is `--clearance || config.govmil`.

- [ ] **Step 1: Write the failing test**

Create `tests/searchOptions.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  ConfigError,
  type LoadedConfig,
  toSearchOptions,
} from "../src/config.ts";

const LOADED: LoadedConfig = {
  files: ["/g/config.toml"],
  config: {
    govmil: false,
    keywords: ["swe", "devops"],
    locations: [
      { city: "Omaha", flexibility: "in-person", region: ["Nebraska"] },
      { city: "United States", flexibility: "remote", region: [] },
    ],
  },
};

const never = (): LoadedConfig => {
  throw new Error("config must not be read");
};

describe("toSearchOptions with --role", () => {
  it("uses the flags alone and never reads the config", () => {
    expect(
      toSearchOptions({ role: ["swe"], location: ["Omaha"], remote: true }, never),
    ).toEqual({
      keywords: ["swe"],
      targets: [{ city: "Omaha", flexibility: "remote", region: [] }],
      govmil: false,
    });
  });

  it("has one unrestricted target without --location (today's behavior)", () => {
    expect(
      toSearchOptions({ role: ["swe"], onsite: true, clearance: true }, never),
    ).toEqual({
      keywords: ["swe"],
      targets: [{ city: null, flexibility: "in-person", region: [] }],
      govmil: true,
    });
  });
});

describe("toSearchOptions from the config", () => {
  it("crosses keywords with locations, keeping region", () => {
    expect(toSearchOptions({}, () => LOADED)).toEqual({
      keywords: ["swe", "devops"],
      targets: [
        { city: "Omaha", flexibility: "in-person", region: ["Nebraska"] },
        { city: "United States", flexibility: "remote", region: [] },
      ],
      govmil: false,
    });
  });

  it("lets --location, --remote/--onsite and --clearance override pieces", () => {
    const relocated = toSearchOptions(
      { location: ["Reno"], clearance: true },
      () => LOADED,
    );
    expect(relocated.targets).toEqual([
      { city: "Reno", flexibility: "any", region: [] },
    ]);
    expect(relocated.govmil).toBe(true);

    const onsite = toSearchOptions({ onsite: true }, () => LOADED);
    expect(onsite.targets.map((t) => t.flexibility)).toEqual([
      "in-person",
      "in-person",
    ]);
  });

  it("honors govmil from the config", () => {
    const loaded = { ...LOADED, config: { ...LOADED.config, govmil: true } };
    expect(toSearchOptions({}, () => loaded).govmil).toBe(true);
  });
});

describe("toSearchOptions errors", () => {
  it("rejects --remote together with --onsite", () => {
    expect(() =>
      toSearchOptions({ role: ["x"], remote: true, onsite: true }, never),
    ).toThrow("--remote and --onsite are mutually exclusive");
  });

  it("hints at igor init when there is no config and no --role", () => {
    expect(() =>
      toSearchOptions({}, () => ({ config: {}, files: [] })),
    ).toThrow(/igor init/);
  });

  it("never allows an unbounded search: locations are required", () => {
    const noLocations: LoadedConfig = {
      files: ["/g/config.toml"],
      config: { keywords: ["swe"] },
    };
    expect(() => toSearchOptions({}, () => noLocations)).toThrow(ConfigError);
    expect(() => toSearchOptions({}, () => noLocations)).toThrow(
      "no [[location]] configured (/g/config.toml)",
    );
    // --location supplies what the config lacks.
    expect(
      toSearchOptions({ location: ["Omaha"] }, () => noLocations).targets,
    ).toHaveLength(1);
  });

  it("requires keywords", () => {
    const noKeywords: LoadedConfig = {
      files: ["/g/config.toml", "/p/igor.toml"],
      config: { locations: LOADED.config.locations },
    };
    expect(() => toSearchOptions({}, () => noKeywords)).toThrow(
      "no [[keywords]] configured (/g/config.toml, /p/igor.toml)",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/searchOptions.test.ts 2>&1 | tail -15`
Expected: FAIL, `toSearchOptions` is not exported.

- [ ] **Step 3: Implement**

Append at the end of `src/config.ts`:

```ts
/** One location a search runs in. `city: null` means no location given. */
export interface SearchTarget {
  city: string | null;
  flexibility: Flexibility;
  region: string[];
}

/** Every keyword is searched in every target. */
export interface SearchPlan {
  keywords: string[];
  targets: SearchTarget[];
  govmil: boolean;
}

/** The `igor search` flags that shape a search. */
export interface SearchFlags {
  role?: string[];
  location?: string[];
  remote?: boolean;
  onsite?: boolean;
  clearance?: boolean;
}

/**
 * With --role, the flags describe the whole search and the config is not
 * read. Otherwise the config supplies keywords and locations, and
 * --location, --remote/--onsite and --clearance override pieces of it.
 */
export function toSearchOptions(
  flags: SearchFlags,
  load: () => LoadedConfig,
): SearchPlan {
  if (flags.remote && flags.onsite) {
    throw new ConfigError("--remote and --onsite are mutually exclusive");
  }
  const flagFlexibility: Flexibility | null = flags.remote
    ? "remote"
    : flags.onsite
      ? "in-person"
      : null;
  const flagTargets = flags.location?.map(
    (city): SearchTarget => ({
      city,
      flexibility: flagFlexibility ?? "any",
      region: [],
    }),
  );

  if (flags.role && flags.role.length > 0) {
    return {
      keywords: flags.role,
      targets: flagTargets ?? [
        { city: null, flexibility: flagFlexibility ?? "any", region: [] },
      ],
      govmil: flags.clearance ?? false,
    };
  }

  const { config, files } = load();
  if (files.length === 0) {
    throw new ConfigError(
      'no config file found. Run "igor init" to create one, or pass --role.',
    );
  }
  const where = files.join(", ");
  if (!config.keywords || config.keywords.length === 0) {
    throw new ConfigError(
      `no [[keywords]] configured (${where}). Add at least one [[keywords]] role, or pass --role.`,
    );
  }
  const targets =
    flagTargets ??
    config.locations?.map(
      (entry): SearchTarget => ({
        city: entry.city,
        flexibility: flagFlexibility ?? entry.flexibility,
        region: entry.region,
      }),
    );
  if (!targets || targets.length === 0) {
    throw new ConfigError(
      `no [[location]] configured (${where}). At least one location is required so a search is never unbounded.`,
    );
  }
  return {
    keywords: config.keywords,
    targets,
    govmil: (flags.clearance ?? false) || (config.govmil ?? false),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/searchOptions.test.ts tests/config.test.ts tests/configLoad.test.ts 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bunx @biomejs/biome check --write src/config.ts tests/searchOptions.test.ts
bun run typecheck 2>&1 | tail -5
git add src/config.ts tests/searchOptions.test.ts
git commit -m "feat: toSearchOptions builds a search plan from flags or config" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Shared DB resolver on every command, `--config`, `igor config`

Removes the commander `--db` defaults (`"igor.db"`) so the precedence chain runs, and makes `openDb` create the global data dir.

**Files:**
- Modify: `src/db.ts` (imports; first lines of `openDb`)
- Modify: `src/cli.ts` (imports; `SearchOptions`; two lines in `runSearch`; `runClear`; `runRefresh`; `JobsCliOptions`/`runJobs`; `TailorCliOptions`/`runTailor`; `createProgram`; `main` catch)
- Modify: `tests/cli.test.ts`, `tests/db.test.ts`

**Interfaces:**
- Consumes: `resolveDbPath`, `describeConfig`, `ConfigError` (Tasks 2 and 3).
- Produces:
  - `openDb(path: string): Database`: no default path; creates the parent directory unless `path === ":memory:"`.
  - `SearchOptions` gains `db?: string` (was `db: string`) and `config?: string`. `role` stays required until Task 10.
  - `const DB_HELP`, `const CONFIG_HELP` in `src/cli.ts` (module-level, not exported).
  - `igor config [--config <path>]`; `--config <path>` on `search` and `tui`.
  - `createProgram` parameters `clearAction` and `refreshAction` take `{ db?: string }`.

- [ ] **Step 1: Write the failing tests**

In `tests/cli.test.ts`:

1. In `describe("clear command parsing")`, test "parses clear with defaults", replace `expect(calls[0]).toMatchObject({ db: "igor.db" });` with `expect(calls[0]?.db).toBeUndefined();`, and change the helper's `const calls: { db: string }[] = [];` to `const calls: { db?: string }[] = [];`.
2. In "applies defaults when only --role is given", delete the line `db: "igor.db",` from the `toMatchObject` object and add `expect(calls[0]?.db).toBeUndefined();` after it.
3. Append inside `describe("search command parsing")`:

```ts
  it("accepts --config", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync([
      "node",
      "igor",
      "search",
      "--role",
      "engineer",
      "--config",
      "x.toml",
    ]);
    expect(calls[0]?.config).toBe("x.toml");
  });
```

4. Append at the end of the file:

```ts
describe("db and config options", () => {
  it("no command defaults --db, so the shared resolver decides", () => {
    for (const cmd of createProgram().commands) {
      const db = cmd.options.find((o) => o.long === "--db");
      if (db) expect(db.defaultValue).toBeUndefined();
    }
  });

  it("registers igor config and --config on search and tui", () => {
    const program = createProgram();
    const longs = (name: string) =>
      program.commands
        .find((c) => c.name() === name)
        ?.options.map((o) => o.long) ?? [];
    expect(longs("config")).toContain("--config");
    expect(longs("search")).toContain("--config");
    expect(longs("tui")).toContain("--config");
  });
});
```

Append to `tests/db.test.ts`. Change its `import { rmSync } from "node:fs";` to `import { existsSync, mkdtempSync, rmSync } from "node:fs";` and add `import { tmpdir } from "node:os";` and `import { join } from "node:path";` (biome sorts them):

```ts
describe("openDb paths", () => {
  it("creates missing parent directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "igor-open-"));
    const path = join(dir, "a", "b", "igor.db");
    openDb(path).close();
    expect(existsSync(path)).toBe(true);
    rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli.test.ts tests/db.test.ts 2>&1 | tail -15`
Expected: FAIL (clear default is `"igor.db"`; no `config` command; parent dir missing).

- [ ] **Step 3: `src/db.ts`**

Replace the first two lines

```ts
import { Database } from "bun:sqlite";
import type { NormalizedJob } from "./sources/types.ts";
```

with

```ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { NormalizedJob } from "./sources/types.ts";
```

Replace

```ts
export function openDb(path = "igor.db"): Database {
  const db = new Database(path);
```

with

```ts
export function openDb(path: string): Database {
  // The global default lives under a data dir that may not exist yet.
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
```

- [ ] **Step 4: `src/cli.ts`**

4a. Add the import (biome sorts it):

```ts
import { ConfigError, describeConfig, resolveDbPath } from "./config.ts";
```

4b. In `SearchOptions`, replace `db: string;` with

```ts
  db?: string;
  config?: string;
```

4c. In `runSearch`, replace `const db = openDb(options.db);` with

```ts
  const dbPath = resolveDbPath({ db: options.db, config: options.config });
  const db = openDb(dbPath);
```

and in the final summary line replace `stored in ${options.db}` with `stored in ${dbPath}`.

4d. Replace `runClear` with:

```ts
export async function runClear(options: { db?: string }): Promise<void> {
  const dbPath = resolveDbPath({ db: options.db });
  const db = openDb(dbPath);
  clearJobs(db);
  db.close();
  console.log(`Cleared all jobs from ${dbPath}`);
}
```

4e. In `runRefresh`, change the signature to `(options: { db?: string })` and `const db = openDb(options.db);` to `const db = openDb(resolveDbPath({ db: options.db }));`.

4f. In `JobsCliOptions` and `TailorCliOptions`, change `db: string;` to `db?: string;`. In `runJobs` and `runTailor`, change `const db = openDb(options.db);` to `const db = openDb(resolveDbPath({ db: options.db }));`.

4g. Above `export function createProgram(`, add:

```ts
const DB_HELP =
  "path to sqlite db (default: [db] path from the config, else the global db; see `igor config`)";
const CONFIG_HELP =
  "config file to use instead of the global config plus ./igor.toml";
```

4h. In `createProgram`:
- Change the parameter types `clearAction: (options: { db: string }) => Promise<void>` and `refreshAction: (options: { db: string }) => Promise<void>` to `{ db?: string }`.
- Replace every `.option("--db <path>", "path to sqlite db", "igor.db")` (six: search, tui, clear, refresh, jobs, tailor) with `.option("--db <path>", DB_HELP)` (`Edit` with `replace_all`).
- In `search`, add `.option("--config <path>", CONFIG_HELP)` directly after its `--db` option.
- Replace the `tui` command's option and action lines

```ts
    .option("--db <path>", DB_HELP)
    .action(async (options: { db: string }) => {
      await runTui({ db: options.db });
    });
```

with

```ts
    .option("--db <path>", DB_HELP)
    .option("--config <path>", CONFIG_HELP)
    .action(async (options: { db?: string; config?: string }) => {
      await runTui({
        db: resolveDbPath({ db: options.db, config: options.config }),
      });
    });
```

- In the `clear` and `refresh` actions change `(options: { db: string })` to `(options: { db?: string })`.
- In the `tailor` action's inline options type change `db: string;` to `db?: string;`.
- Before `return program;` add:

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

4i. Replace the `main().catch(...)` block at the bottom with:

```ts
  main().catch((err) => {
    // Config problems are user errors: print the message, not a stack.
    console.error(err instanceof ConfigError ? `error: ${err.message}` : err);
    process.exit(1);
  });
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test 2>&1 | tail -15 && bun run typecheck 2>&1 | tail -10`
Expected: all PASS, typecheck clean. If `tsc` reports a caller of `openDb()` with no argument, pass the resolved path there (there are none in `src/` or `tests/` today).

- [ ] **Step 6: Smoke**

Run: `T=$(mktemp -d) && XDG_CONFIG_HOME=$T/c XDG_DATA_HOME=$T/d bun run src/cli.ts config`
Expected: `config files: none (run "igor init" to create .../c/igor/config.toml)` and `database: .../d/igor/igor.db`.

- [ ] **Step 7: Commit**

```bash
bunx @biomejs/biome check --write src/db.ts src/cli.ts tests/cli.test.ts tests/db.test.ts
git add src/db.ts src/cli.ts tests/cli.test.ts tests/db.test.ts
git commit -m "feat: resolve the db path through config on every command; add igor config" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `runs` table, migration, generic run API

**Files:**
- Modify: `src/db.ts` (the `busy_timeout` comment; the `tailor_runs` block at the end of `openDb`; a new `migrateTailorRuns` above `openDb`; everything from `export interface TailorRun {` to end of file)
- Test: extend `tests/tailorRuns.test.ts` (existing tests must keep passing unchanged)

**Interfaces:**
- Consumes: `openDb(path: string)` as left by Task 5.
- Produces (from `src/db.ts`):
  - `type RunKind = "tailor" | "search"`; `const SEARCH_RUN_KEY = "search"`
  - `interface Run { kind: RunKind; key: string; pid: number; startedAt: string; finishedAt: string | null; ok: boolean | null; message: string | null }`
  - `getRun(db: Database, kind: RunKind, key: string): Run | null`
  - `startRun(db: Database, kind: RunKind, key: string, pid: number, now?: string): boolean` (same pid may re-claim; a different live pid is refused)
  - `finishRun(db: Database, kind: RunKind, key: string, ok: boolean, message: string, now?: string): void`
  - `runningRuns(db: Database, kind: RunKind): Run[]`: live runs of `kind`; the one place crash handling lives (unfinished run with a dead pid is closed out as failed with `"<kind> process exited unexpectedly"`)
  - `getTailorRun`, `startTailorRun`, `finishTailorRun`, `runningTailorIds` keep their signatures as thin wrappers; `runningTailorIds` is built on `runningRuns`. `getTailorRun` returns `Run | null`; the `TailorRun` type is removed (`App.tsx` only reads `ok` and `message`, which `Run` has).
  - `openDb` migrates `tailor_runs` into `runs` (one `IMMEDIATE` transaction, `INSERT OR IGNORE`, then `DROP TABLE`); idempotent. Fresh DBs never get a `tailor_runs` table.

- [ ] **Step 1: Write the failing test**

In `tests/tailorRuns.test.ts`, replace the import block at the top with:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import {
  SEARCH_RUN_KEY,
  finishRun,
  finishTailorRun,
  getRun,
  getTailorRun,
  openDb,
  runningRuns,
  runningTailorIds,
  startRun,
  startTailorRun,
} from "../src/db.ts";
```

Append at the end of the file:

```ts
describe("runs", () => {
  it("keeps kinds independent even with the same key", () => {
    const db = freshDb();
    expect(startRun(db, "search", SEARCH_RUN_KEY, process.pid)).toBe(true);
    expect(startRun(db, "tailor", SEARCH_RUN_KEY, process.pid)).toBe(true);
    finishRun(db, "search", SEARCH_RUN_KEY, true, "3 found, 1 new");
    expect(getRun(db, "search", SEARCH_RUN_KEY)).toMatchObject({
      kind: "search",
      ok: true,
      message: "3 found, 1 new",
    });
    expect(runningRuns(db, "search")).toEqual([]);
    expect(runningRuns(db, "tailor").map((r) => r.key)).toEqual([
      SEARCH_RUN_KEY,
    ]);
  });

  it("refuses a concurrent claim from a different live pid", () => {
    const db = freshDb();
    expect(startRun(db, "search", SEARCH_RUN_KEY, 1)).toBe(true); // pid 1 is always alive
    expect(startRun(db, "search", SEARCH_RUN_KEY, process.pid)).toBe(false);
    expect(getRun(db, "search", SEARCH_RUN_KEY)?.pid).toBe(1);
  });

  it("closes out a dead run as failed, naming its kind", async () => {
    const db = freshDb();
    startRun(db, "search", SEARCH_RUN_KEY, await deadPid());
    startTailorRun(db, "a:1", await deadPid());
    expect(runningRuns(db, "search")).toEqual([]);
    expect(runningTailorIds(db).size).toBe(0);
    expect(getRun(db, "search", SEARCH_RUN_KEY)).toMatchObject({
      ok: false,
      message: "search process exited unexpectedly",
    });
    expect(getTailorRun(db, "a:1")).toMatchObject({
      ok: false,
      message: "tailor process exited unexpectedly",
    });
  });
});

describe("tailor_runs migration", () => {
  function legacyDb(): string {
    const path = `/tmp/igor-legacy-test-${Date.now()}-${++counter}.db`;
    rmSync(path, { force: true });
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
    return path;
  }

  const hasLegacyTable = (db: Database) =>
    db.query("SELECT 1 FROM sqlite_master WHERE name = 'tailor_runs'").get() !==
    null;

  it("moves rows into runs, keeps a live run live, and drops the old table", () => {
    const db = openDb(legacyDb());
    expect(runningTailorIds(db).has("live:1")).toBe(true);
    expect(getTailorRun(db, "done:2")).toMatchObject({
      ok: true,
      message: "Wrote x.pdf",
    });
    expect(hasLegacyTable(db)).toBe(false);
    db.close();
  });

  it("is idempotent when rerun, and never recreates tailor_runs", () => {
    const path = legacyDb();
    openDb(path).close();
    const db = openDb(path);
    expect(getTailorRun(db, "done:2")).not.toBeNull();
    expect(hasLegacyTable(db)).toBe(false);
    db.close();
    expect(hasLegacyTable(freshDb())).toBe(false);
  });

  it("keeps an existing runs row over a legacy row with the same key", () => {
    const path = legacyDb();
    const first = openDb(path);
    finishTailorRun(first, "done:2", false, "newer");
    first.run(
      "CREATE TABLE tailor_runs (listing_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, ok INTEGER, message TEXT)",
    );
    first.run(
      "INSERT INTO tailor_runs VALUES ('done:2', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', 1, 'older')",
    );
    first.close();
    const db = openDb(path);
    expect(getTailorRun(db, "done:2")?.message).toBe("newer");
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tailorRuns.test.ts 2>&1 | tail -15`
Expected: FAIL, `startRun` (and the other new exports) not exported from `src/db.ts`.

- [ ] **Step 3: Implement**

In `openDb`, change the comment `// The TUI and detached \`igor tailor\` processes write the same file.` to `// The TUI and detached igor processes (tailor, search) write the same file.`

Replace the block at the end of `openDb`, from `// Background \`igor tailor\` runs, so the TUI can show progress (and pick` through the closing `\`);` of the `CREATE TABLE IF NOT EXISTS tailor_runs` statement, with:

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

Add directly above `export function openDb(`:

```ts
/** One-time move of the old tailor_runs table into runs. Idempotent. */
function migrateTailorRuns(db: Database): void {
  const hasLegacy = () =>
    db
      .query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tailor_runs'",
      )
      .get() !== null;
  if (!hasLegacy()) return;
  // IMMEDIATE plus a re-check, so two processes opening the db at once
  // don't both migrate.
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

Replace everything from `export interface TailorRun {` to the end of the file with:

```ts
export type RunKind = "tailor" | "search";

/** The single key used for `kind = "search"` runs (one search per db). */
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
 * Runs of `kind` in flight. Runs whose process died without finishing
 * (killed, crashed) are closed out as failed here, the only place that
 * happens, rather than showing as running forever.
 */
export function runningRuns(db: Database, kind: RunKind): Run[] {
  const rows = db
    .prepare("SELECT * FROM runs WHERE kind = $kind AND finished_at IS NULL")
    .all({ $kind: kind }) as Record<string, unknown>[];
  const live: Run[] = [];
  for (const row of rows) {
    const run = toRun(row);
    if (pidAlive(run.pid)) live.push(run);
    else
      finishRun(db, kind, run.key, false, `${kind} process exited unexpectedly`);
  }
  return live;
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

/** Listings with a tailor run in flight. */
export function runningTailorIds(db: Database): Set<string> {
  return new Set(runningRuns(db, "tailor").map((run) => run.key));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/tailorRuns.test.ts tests/db.test.ts tests/tailor.test.ts 2>&1 | tail -15 && bun run typecheck 2>&1 | tail -5`
Expected: all PASS, typecheck clean. `igor tailor` (via the wrappers in `runTailor`) and `App.tsx` now use `runs` without code changes.

- [ ] **Step 5: Commit**

```bash
bunx @biomejs/biome check --write src/db.ts tests/tailorRuns.test.ts
git add src/db.ts tests/tailorRuns.test.ts
git commit -m "feat: generic runs table replacing tailor_runs, with migration" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Central work-type and location predicate

One predicate decides whether a job satisfies a (city, flexibility) pair. This task only adds it; Task 9 is the only caller.

**Files:**
- Modify: `src/sources/location.ts` (full rewrite)
- Modify: `src/sources/types.ts` (`NormalizedJob.otherLocations?`)
- Test: `tests/location.test.ts` (existing tests keep passing; new tests appended)

**Interfaces:**
- Consumes: `SearchTarget` (Task 4), `Flexibility` (Task 2), both as type-only imports from `../config.ts`.
- Produces:
  - `NormalizedJob.otherLocations?: string[]`: other places a posting lists (ashby secondary locations). Used for matching only, not stored.
  - `matchesLocation(jobLocation: string, queryLocation: string | string[]): boolean`: word-boundary match of the query or any of its aliases.
  - `remoteEligible(jobLocation: string, city: string, region?: string[]): boolean`
  - `normalizeRemoteType<T extends Pick<NormalizedJob, "location" | "remoteType">>(job: T): T`: `unknown` plus the word "remote" in the location becomes `remote`; nothing else changes.
  - `matches(job: Pick<NormalizedJob, "location" | "remoteType" | "otherLocations">, target: SearchTarget, options?: { scoped?: boolean }): boolean`

Rules (spec, "Work type and location matching"):
- `remoteType === "remote"`: `flexibility !== "in-person"` and `remoteEligible`. Otherwise: `flexibility !== "remote"` and `matchesLocation(job, city)`.
- `city === null` or `scoped: true` skips the place check (only the work-type half applies).
- Aliases used everywhere: "omaha" = omaha, la vista, elkhorn, ralston; "united states" = united states, usa, u.s., us, north america, americas.
- Remote-only aliases: "omaha" additionally gets "nebraska". `region` terms (each extended with aliases) also count only for remote eligibility.
- A location is a bare global term when, after dropping punctuation and the word "remote", nothing is left or it is one of: worldwide, anywhere, global, international, anywhere in the world.
- A job matches a target if any of `[location, ...otherLocations]` matches.

- [ ] **Step 1: Write the failing test**

Replace the two import lines at the top of `tests/location.test.ts` (`bun:test` and `../src/sources/location.ts`) with:

```ts
import { describe, expect, it } from "bun:test";
import type { Flexibility, SearchTarget } from "../src/config.ts";
import {
  matches,
  matchesLocation,
  normalizeRemoteType,
  remoteEligible,
} from "../src/sources/location.ts";
import type { RemoteType } from "../src/sources/types.ts";
```

Append at the end of the file:

```ts
describe("matchesLocation word boundaries", () => {
  it('does not match "us" inside other words', () => {
    expect(matchesLocation("Houston, TX", "us")).toBe(false);
    expect(matchesLocation("Australia", "us")).toBe(false);
    expect(matchesLocation("Remote (US)", "us")).toBe(true);
  });

  it("expands the United States aliases on word boundaries", () => {
    expect(matchesLocation("Remote - USA", "United States")).toBe(true);
    expect(matchesLocation("U.S. only", "United States")).toBe(true);
    expect(matchesLocation("Houston, TX", "United States")).toBe(false);
    expect(matchesLocation("San Francisco, CA", "United States")).toBe(false);
  });
});

describe("remoteEligible", () => {
  const us = (location: string) => remoteEligible(location, "United States");

  it("accepts blank and bare global locations", () => {
    for (const loc of ["", "Remote", "Worldwide", "Anywhere", " Global ", "International", "Remote - Worldwide", "Anywhere in the World"]) {
      expect(us(loc)).toBe(true);
    }
  });

  it("accepts listings naming the country or an alias", () => {
    expect(us("USA Only")).toBe(true);
    expect(us("Remote (US)")).toBe(true);
    expect(us("North America")).toBe(true);
  });

  it("rejects other regions", () => {
    expect(us("Remote - Europe")).toBe(false);
    expect(us("Australia")).toBe(false);
    expect(us("Houston")).toBe(false);
  });

  it("lets Omaha's metro alias and a region list add remote eligibility", () => {
    expect(remoteEligible("Remote - Nebraska", "Omaha")).toBe(true);
    expect(remoteEligible("Remote - Nebraska", "Lincoln")).toBe(false);
    expect(remoteEligible("Remote - Nebraska", "Lincoln", ["Nebraska"])).toBe(true);
    expect(remoteEligible("Remote - TX", "Austin", ["Texas", "TX"])).toBe(true);
  });
});

describe("normalizeRemoteType", () => {
  it("turns unknown plus 'remote' in the location into remote", () => {
    const job = normalizeRemoteType({ location: "Remote - US", remoteType: "unknown" as RemoteType });
    expect(job.remoteType).toBe("remote");
  });

  it("leaves everything else alone", () => {
    expect(normalizeRemoteType({ location: "Omaha, NE", remoteType: "unknown" as RemoteType }).remoteType).toBe("unknown");
    expect(normalizeRemoteType({ location: "Remote office, Omaha", remoteType: "onsite" as RemoteType }).remoteType).toBe("onsite");
    expect(normalizeRemoteType({ location: "Remotely, NE", remoteType: "unknown" as RemoteType }).remoteType).toBe("unknown");
  });
});

describe("matches", () => {
  const omaha = (flexibility: Flexibility): SearchTarget => ({ city: "Omaha", flexibility, region: [] });

  const table: [RemoteType, Flexibility, boolean][] = [
    ["remote", "remote", true],
    ["remote", "in-person", false],
    ["remote", "any", true],
    ["onsite", "remote", false],
    ["onsite", "in-person", true],
    ["onsite", "any", true],
    ["hybrid", "remote", false],
    ["hybrid", "in-person", true],
    ["hybrid", "any", true],
    ["unknown", "remote", false],
    ["unknown", "in-person", true],
    ["unknown", "any", true],
  ];

  for (const [remoteType, flexibility, expected] of table) {
    it(`${remoteType} job in Omaha vs ${flexibility} Omaha is ${expected}`, () => {
      expect(matches({ location: "Omaha, NE", remoteType }, omaha(flexibility))).toBe(expected);
    });
  }

  it("uses Nebraska only for remote eligibility, never for onsite matching", () => {
    expect(matches({ location: "Remote - Nebraska", remoteType: "remote" }, omaha("any"))).toBe(true);
    expect(matches({ location: "Lincoln, Nebraska", remoteType: "onsite" }, omaha("in-person"))).toBe(false);
    const lincoln: SearchTarget = { city: "Lincoln", flexibility: "any", region: ["Nebraska"] };
    expect(matches({ location: "Remote - Nebraska", remoteType: "remote" }, lincoln)).toBe(true);
    expect(matches({ location: "Nebraska", remoteType: "onsite" }, lincoln)).toBe(false);
  });

  it("does not let an unlabeled US job match a city", () => {
    expect(matches({ location: "United States", remoteType: "unknown" }, omaha("in-person"))).toBe(false);
  });

  it("broad regions match onsite jobs only when the text names the region", () => {
    const us: SearchTarget = { city: "United States", flexibility: "any", region: [] };
    expect(matches({ location: "San Francisco, CA", remoteType: "onsite" }, us)).toBe(false);
    expect(matches({ location: "Austin, TX, USA", remoteType: "onsite" }, us)).toBe(true);
  });

  it("skips place checks for scoped sources and for targets without a city", () => {
    expect(matches({ location: "Dallas, TX", remoteType: "onsite" }, omaha("in-person"), { scoped: true })).toBe(true);
    const usRemote: SearchTarget = { city: "United States", flexibility: "remote", region: [] };
    expect(matches({ location: "Remote - Europe", remoteType: "remote" }, usRemote, { scoped: true })).toBe(true);
    expect(matches({ location: "Dallas, TX", remoteType: "onsite" }, usRemote, { scoped: true })).toBe(false);
    const anywhere: SearchTarget = { city: null, flexibility: "remote", region: [] };
    expect(matches({ location: "Remote - Europe", remoteType: "remote" }, anywhere)).toBe(true);
    expect(matches({ location: "Dallas, TX", remoteType: "onsite" }, anywhere)).toBe(false);
  });

  it("checks other listed locations too", () => {
    const usRemote: SearchTarget = { city: "United States", flexibility: "remote", region: [] };
    expect(
      matches({ location: "New York, NY (HQ)", otherLocations: ["Remote (US)"], remoteType: "remote" }, usRemote),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/location.test.ts 2>&1 | tail -15`
Expected: FAIL, `matches` / `remoteEligible` / `normalizeRemoteType` not exported.

- [ ] **Step 3: Implement**

In `src/sources/types.ts`, add to `NormalizedJob` after `location: string;`:

```ts
  /** Other places the posting lists (e.g. ashby secondary locations). Matching only; not stored. */
  otherLocations?: string[];
```

Replace the whole of `src/sources/location.ts` with:

```ts
import type { SearchTarget } from "../config.ts";
import { toArray } from "./params.ts";
import type { NormalizedJob } from "./types.ts";

// Aliases used wherever a place is matched (onsite and remote).
const LOCATION_ALIASES: Record<string, string[]> = {
  omaha: ["omaha", "la vista", "elkhorn", "ralston"],
  "united states": [
    "united states",
    "usa",
    "u.s.",
    "us",
    "north america",
    "americas",
  ],
};

// Extra terms that make a remote listing eligible for a place. Never used
// for onsite matching: an onsite job in Lincoln is not an Omaha job.
const REMOTE_ONLY_ALIASES: Record<string, string[]> = {
  omaha: ["nebraska"],
};

// What a listing says when it is not tied to any region.
const GLOBAL_TERMS = new Set([
  "",
  "worldwide",
  "anywhere",
  "global",
  "international",
  "anywhere in the world",
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `term` appears in `text` with no letter or digit on either side. */
function containsTerm(text: string, term: string): boolean {
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(term)}(?![a-z0-9])`).test(
    text,
  );
}

function aliasesFor(place: string): string[] {
  const key = place.trim().toLowerCase();
  return LOCATION_ALIASES[key] ?? [key];
}

export function matchesLocation(
  jobLocation: string,
  queryLocation: string | string[],
): boolean {
  const job = jobLocation.toLowerCase();
  return toArray(queryLocation).some((query) =>
    aliasesFor(query).some((alias) => containsTerm(job, alias)),
  );
}

function isGlobalLocation(jobLocation: string): boolean {
  const text = jobLocation
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\bremote\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return GLOBAL_TERMS.has(text);
}

/** Whether a remote listing's location lets someone in `city` take it. */
export function remoteEligible(
  jobLocation: string,
  city: string,
  region: string[] = [],
): boolean {
  if (isGlobalLocation(jobLocation)) return true;
  const job = jobLocation.toLowerCase();
  const terms = [
    ...[city, ...region].flatMap(aliasesFor),
    ...(REMOTE_ONLY_ALIASES[city.trim().toLowerCase()] ?? []),
  ];
  return terms.some((term) => containsTerm(job, term));
}

/**
 * The one free-text inference: a job with no remote signal whose location
 * says "remote" is remote. Hybrid versus onsite is never inferred.
 */
export function normalizeRemoteType<
  T extends Pick<NormalizedJob, "location" | "remoteType">,
>(job: T): T {
  if (
    job.remoteType === "unknown" &&
    containsTerm(job.location.toLowerCase(), "remote")
  ) {
    return { ...job, remoteType: "remote" as const };
  }
  return job;
}

/**
 * The single decision of whether a job satisfies a (city, flexibility)
 * target. `remote` is trusted; anything else counts as possibly onsite.
 * Scoped sources already applied the city in their query, so only the
 * work-type half applies to their jobs.
 */
export function matches(
  job: Pick<NormalizedJob, "location" | "remoteType" | "otherLocations">,
  target: SearchTarget,
  options: { scoped?: boolean } = {},
): boolean {
  const remote = job.remoteType === "remote";
  if (remote ? target.flexibility === "in-person" : target.flexibility === "remote") {
    return false;
  }
  const city = target.city;
  if (options.scoped || city === null) return true;
  const places = [job.location, ...(job.otherLocations ?? [])];
  return places.some((place) =>
    remote
      ? remoteEligible(place, city, target.region)
      : matchesLocation(place, city),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/location.test.ts tests/sources.test.ts 2>&1 | tail -15 && bun run typecheck 2>&1 | tail -5`
Expected: PASS. The source tests still pass: their internal filters now match on word boundaries, and every fixture location they filter on ("Oakland", "worldwide", "usa" against "USA Only", "San Leandro") is a whole word.

- [ ] **Step 5: Commit**

```bash
bunx @biomejs/biome check --write src/sources/location.ts src/sources/types.ts tests/location.test.ts
git add src/sources/location.ts src/sources/types.ts tests/location.test.ts
git commit -m "feat: central work-type and location predicate with word-boundary aliases" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Scoped versus unscoped sources

**Files:**
- Modify: `src/sources/types.ts` (`Source.scoped`)
- Modify: `src/sources/adzuna.ts`, `ashby.ts`, `greenhouse.ts`, `jobaps.ts`, `jsearch.ts`, `lever.ts`, `remoteok.ts`, `remotive.ts`, `weworkremotely.ts`
- Test: `tests/sources.test.ts`

**Interfaces:**
- Consumes: `NormalizedJob.otherLocations` (Task 7).
- Produces: `Source.scoped: boolean`. `jsearch` and `adzuna` are `true` (they apply the location inside the API query); every other source is `false`. Ashby jobs carry `otherLocations` from `secondaryLocations`. Existing internal location filters in the unscoped sources stay; they do nothing once Task 9 stops passing `location`. Each source's `remoteType` mapping already matches the spec's table and is not changed.

- [ ] **Step 1: Write the failing test**

Append to `tests/sources.test.ts`:

```ts
describe("source scoping", () => {
  it("marks only the location-aware APIs as scoped", () => {
    const all = [
      createGreenhouseSource(),
      createLeverSource(),
      createAshbySource(),
      createRemoteOkSource(),
      createRemotiveSource(),
      createWeWorkRemotelySource(),
      createJobApsSource(),
      createJSearchSource("key"),
      createAdzunaSource("id", "key"),
    ];
    expect(
      all
        .filter((s) => s.scoped)
        .map((s) => s.name)
        .sort(),
    ).toEqual(["adzuna", "jsearch"]);
  });

  it("reports ashby secondary locations for matching", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(ashbyFixture)),
    ) as unknown as typeof fetch;
    const jobs = await createAshbySource().search({ role: "engineer" });
    expect(jobs[0]?.location).toBe("New York, NY (HQ)");
    expect(jobs[0]?.otherLocations).toEqual(["Remote (US)"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sources.test.ts 2>&1 | tail -15`
Expected: FAIL (`scoped` undefined on every source; `otherLocations` undefined).

- [ ] **Step 3: Implement**

In `src/sources/types.ts`, replace the `Source` interface with:

```ts
export interface Source {
  name: NormalizedJob["source"];
  /**
   * True when the source applies `location` inside its API query (jsearch,
   * adzuna). The runner calls scoped sources once per (keyword, location)
   * and unscoped ones once per keyword with no location.
   */
  scoped: boolean;
  search(params: SearchParams): Promise<NormalizedJob[]>;
}
```

In each source's returned object, add a `scoped` line directly after its `name: "...",` line:
- `src/sources/jsearch.ts`, `src/sources/adzuna.ts`: `scoped: true,`
- `src/sources/greenhouse.ts`, `lever.ts`, `ashby.ts`, `remoteok.ts`, `remotive.ts`, `weworkremotely.ts`, `jobaps.ts`: `scoped: false,`

In `src/sources/ashby.ts`, in the `results.push({ ... })` object, add after `location: job.location,`:

```ts
            otherLocations: (job.secondaryLocations ?? []).map(
              (l) => l.location,
            ),
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/sources.test.ts tests/cli.test.ts 2>&1 | tail -15 && bun run typecheck 2>&1 | tail -5`
Expected: PASS. `tests/smoke-live.ts` builds sources through the factories, so it needs no change.

- [ ] **Step 5: Commit**

```bash
bunx @biomejs/biome check --write src/sources tests/sources.test.ts
git add src/sources tests/sources.test.ts
git commit -m "feat: sources declare whether they scope by location" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: `collectJobs` and the run summary (`src/search.ts`)

**Files:**
- Create: `src/search.ts`
- Modify: `src/cli.ts` (move `isInternship` / `requiresClearance` out; re-export them)
- Test: `tests/search.test.ts`

**Interfaces:**
- Consumes: `SearchPlan`, `SearchTarget` (Task 4); `matches`, `normalizeRemoteType` (Task 7); `Source.scoped` (Task 8); `dedupe` (`src/dedupe.ts`); `stripTrackingParams` (`src/url.ts`).
- Produces (from `src/search.ts`):
  - `interface SourceFailure { source: string; message: string }`
  - `interface CollectResult { jobs: NormalizedJob[]; failures: SourceFailure[]; allFailed: boolean }`
  - `interface SearchResult { found: number; new: number; failures: SourceFailure[] }`
  - `collectJobs(plan: SearchPlan, sources: Source[]): Promise<CollectResult>`
  - `formatRunMessage(result: SearchResult): string`: `"N found, M new"`, plus `"; failed: jsearch: 429, adzuna: ..."` when there are failures.
  - `isInternship(job)`, `requiresClearance(job)` (moved verbatim from `src/cli.ts`; `src/cli.ts` imports and re-exports them so `tests/cli.test.ts` is unchanged).

Behavior:
- Unscoped sources: one call per keyword, `{ role }` only. Every job is normalized (`normalizeRemoteType`) and kept if it `matches` any target.
- Scoped sources: one call per (keyword, target), `{ role, location: city ?? undefined, remote: true when flexibility is "remote" }`. Their jobs are normalized and kept if `matches(job, thatTarget, { scoped: true })`.
- The union is deduped, then internships are dropped, clearance jobs are dropped unless `plan.govmil`, and tracking params are stripped. (These filters do not depend on the target, so applying them after the per-target filter is equivalent to applying them per combination.)
- A failing call is logged with `console.error("[name] search failed: ...")` and recorded once per source (first message, truncated to 120 chars); it never throws. `allFailed` is true when at least one call was made and none succeeded.

- [ ] **Step 1: Write the failing test**

Create `tests/search.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { SearchPlan } from "../src/config.ts";
import { collectJobs, formatRunMessage } from "../src/search.ts";
import type {
  NormalizedJob,
  SearchParams,
  Source,
} from "../src/sources/types.ts";

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

function fake(
  name: NormalizedJob["source"],
  scoped: boolean,
  respond: (params: SearchParams) => NormalizedJob[],
) {
  const calls: SearchParams[] = [];
  const source: Source = {
    name,
    scoped,
    async search(params) {
      calls.push(params);
      return respond(params);
    },
  };
  return { source, calls };
}

function failing(name: NormalizedJob["source"], scoped: boolean, message: string): Source {
  return {
    name,
    scoped,
    async search() {
      throw new Error(message);
    },
  };
}

const OMAHA_AND_US: SearchPlan = {
  keywords: ["swe"],
  govmil: false,
  targets: [
    { city: "Omaha", flexibility: "in-person", region: [] },
    { city: "United States", flexibility: "remote", region: [] },
  ],
};

const ids = (jobs: NormalizedJob[]) => jobs.map((j) => j.sourceId).sort();

let errorSpy: { mockRestore(): void };
beforeEach(() => {
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe("collectJobs source calls", () => {
  const plan: SearchPlan = { ...OMAHA_AND_US, keywords: ["swe", "devops"] };

  it("calls unscoped sources once per keyword with no location", async () => {
    const loose = fake("greenhouse", false, () => []);
    await collectJobs(plan, [loose.source]);
    expect(loose.calls).toEqual([{ role: "swe" }, { role: "devops" }]);
  });

  it("calls scoped sources once per keyword and location", async () => {
    const scoped = fake("jsearch", true, () => []);
    await collectJobs(plan, [scoped.source]);
    const seen = scoped.calls
      .map((c) => `${c.role}|${c.location}|${c.remote === true}`)
      .sort();
    expect(seen).toEqual([
      "devops|Omaha|false",
      "devops|United States|true",
      "swe|Omaha|false",
      "swe|United States|true",
    ]);
  });
});

describe("collectJobs filtering", () => {
  it("filters each location with its own flexibility", async () => {
    const loose = fake("greenhouse", false, () => [
      job({ sourceId: "a", location: "Omaha, NE", remoteType: "onsite" }),
      job({ sourceId: "b", location: "La Vista, NE", remoteType: "unknown" }),
      job({ sourceId: "c", location: "Remote - USA", remoteType: "remote" }),
      job({ sourceId: "d", location: "Remote - Europe", remoteType: "remote" }),
      job({ sourceId: "e", location: "Austin, TX", remoteType: "onsite" }),
      job({ sourceId: "f", location: "Remote", remoteType: "unknown" }),
      job({ sourceId: "g", location: "Omaha, NE", remoteType: "remote" }),
      job({ sourceId: "h", location: "Omaha, NE", remoteType: "hybrid" }),
    ].map((j) => ({ ...j, title: `SWE ${j.sourceId}`, url: `https://e.com/${j.sourceId}` })));
    const { jobs } = await collectJobs(OMAHA_AND_US, [loose.source]);
    // a, b, h: in-person Omaha. c, f: remote and eligible for the US.
    // d: remote Europe. e: wrong city. g: remote, but Omaha is in-person
    // and "Omaha, NE" is not a US alias.
    expect(ids(jobs)).toEqual(["a", "b", "c", "f", "h"]);
    expect(jobs.find((j) => j.sourceId === "f")?.remoteType).toBe("remote");
  });

  it("trusts scoped sources for place and checks only the work type", async () => {
    const scoped = fake("jsearch", true, (params) =>
      params.location === "Omaha"
        ? [job({ sourceId: "s1", source: "jsearch", location: "Dallas, TX", remoteType: "unknown", url: "https://e.com/s1" })]
        : [
            job({ sourceId: "s2", source: "jsearch", title: "Remote SWE", location: "Remote - Europe", remoteType: "remote", url: "https://e.com/s2" }),
            job({ sourceId: "s3", source: "jsearch", title: "Chicago SWE", location: "Chicago, IL", remoteType: "unknown", url: "https://e.com/s3" }),
          ],
    );
    const { jobs } = await collectJobs(OMAHA_AND_US, [scoped.source]);
    expect(ids(jobs)).toEqual(["s1", "s2"]);
  });

  it("checks only the work type when no location was given", async () => {
    const plan: SearchPlan = {
      keywords: ["swe"],
      govmil: false,
      targets: [{ city: null, flexibility: "remote", region: [] }],
    };
    const loose = fake("greenhouse", false, () => [
      job({ sourceId: "r", location: "Remote - Europe", remoteType: "remote", url: "https://e.com/r" }),
      job({ sourceId: "o", title: "Onsite SWE", url: "https://e.com/o" }),
    ]);
    expect(ids((await collectJobs(plan, [loose.source])).jobs)).toEqual(["r"]);
  });

  it("dedupes, drops internships, and drops clearance jobs unless govmil", async () => {
    const respond = () => [
      job({ sourceId: "h" }),
      job({ sourceId: "h2" }), // same company/title/location as h
      job({ sourceId: "i", title: "SWE Intern", url: "https://e.com/i" }),
      job({ sourceId: "c", title: "SWE (Security Clearance)", url: "https://e.com/c" }),
    ];
    const off = await collectJobs(OMAHA_AND_US, [fake("greenhouse", false, respond).source]);
    expect(off.jobs).toHaveLength(1);
    const on = await collectJobs({ ...OMAHA_AND_US, govmil: true }, [fake("greenhouse", false, respond).source]);
    expect(on.jobs.map((j) => j.title).sort()).toEqual(["SWE (Security Clearance)", "Software Engineer"]);
  });
});

describe("collectJobs failures", () => {
  it("records each failing source once and keeps the others' results", async () => {
    const plan: SearchPlan = { ...OMAHA_AND_US, keywords: ["swe", "devops"] };
    const result = await collectJobs(plan, [
      failing("jsearch", true, "JSearch request failed: 429"),
      fake("greenhouse", false, () => [job({})]).source,
    ]);
    expect(result.failures).toEqual([
      { source: "jsearch", message: "JSearch request failed: 429" },
    ]);
    expect(result.jobs).toHaveLength(1);
    expect(result.allFailed).toBe(false);
  });

  it("reports allFailed when every call fails", async () => {
    const result = await collectJobs(OMAHA_AND_US, [
      failing("jsearch", true, "429"),
      failing("remoteok", false, "500"),
    ]);
    expect(result.allFailed).toBe(true);
    expect(result.failures.map((f) => f.source).sort()).toEqual(["jsearch", "remoteok"]);
  });

  it("is not allFailed with no sources at all", async () => {
    expect((await collectJobs(OMAHA_AND_US, [])).allFailed).toBe(false);
  });
});

describe("formatRunMessage", () => {
  it("summarizes counts and failed sources", () => {
    expect(formatRunMessage({ found: 3, new: 1, failures: [] })).toBe("3 found, 1 new");
    expect(
      formatRunMessage({
        found: 3,
        new: 1,
        failures: [
          { source: "jsearch", message: "429" },
          { source: "adzuna", message: "timeout" },
        ],
      }),
    ).toBe("3 found, 1 new; failed: jsearch: 429, adzuna: timeout");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/search.test.ts 2>&1 | tail -15`
Expected: FAIL, cannot find module `../src/search.ts`.

- [ ] **Step 3: Create `src/search.ts`**

```ts
import type { SearchPlan, SearchTarget } from "./config.ts";
import { dedupe } from "./dedupe.ts";
import { matches, normalizeRemoteType } from "./sources/location.ts";
import type { NormalizedJob, SearchParams, Source } from "./sources/types.ts";
import { stripTrackingParams } from "./url.ts";

const INTERNSHIP_PATTERN = /\bintern(?:ship)?s?\b/i;
const GOVMIL_PATTERN =
  /\b(?:Lockheed|Raytheon|Deloitte|Leidos|Offutt|military|warfighter|clearance|DoD|department of defense|department of war|SCI|Top Secret|clearance)\b/i;

export function isInternship(job: NormalizedJob): boolean {
  return INTERNSHIP_PATTERN.test(job.title);
}

export function requiresClearance(job: NormalizedJob): boolean {
  return (
    GOVMIL_PATTERN.test(job.title) || GOVMIL_PATTERN.test(job.description ?? "")
  );
}

export interface SourceFailure {
  source: string;
  message: string;
}

export interface CollectResult {
  jobs: NormalizedJob[];
  failures: SourceFailure[];
  /** At least one call was made and none succeeded. */
  allFailed: boolean;
}

/** What `runSearch` returns and the run message is built from. */
export interface SearchResult {
  found: number;
  new: number;
  failures: SourceFailure[];
}

export function formatRunMessage(result: SearchResult): string {
  const failed =
    result.failures.length > 0
      ? `; failed: ${result.failures.map((f) => `${f.source}: ${f.message}`).join(", ")}`
      : "";
  return `${result.found} found, ${result.new} new${failed}`;
}

function scopedParams(role: string, target: SearchTarget): SearchParams {
  return {
    role,
    location: target.city ?? undefined,
    remote: target.flexibility === "remote" ? true : undefined,
  };
}

/**
 * Runs every keyword in every target. Unscoped sources are called once per
 * keyword without a location and their jobs are checked against every
 * target; scoped sources are called once per (keyword, target) and only
 * the work type is checked. A failing source is recorded, never thrown.
 */
export async function collectJobs(
  plan: SearchPlan,
  sources: Source[],
): Promise<CollectResult> {
  const failures = new Map<string, string>();
  let calls = 0;
  let succeeded = 0;

  const call = async (
    source: Source,
    params: SearchParams,
  ): Promise<NormalizedJob[]> => {
    calls++;
    try {
      const jobs = await source.search(params);
      succeeded++;
      return jobs.map(normalizeRemoteType);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${source.name}] search failed: ${message}`);
      if (!failures.has(source.name)) {
        failures.set(source.name, message.slice(0, 120));
      }
      return [];
    }
  };

  const unscoped = sources.filter((s) => !s.scoped);
  const scoped = sources.filter((s) => s.scoped);

  const perKeyword = await Promise.all(
    plan.keywords.map(async (role) => {
      const [loose, perTarget] = await Promise.all([
        Promise.all(unscoped.map((s) => call(s, { role }))),
        Promise.all(
          plan.targets.map(async (target) => {
            const found = await Promise.all(
              scoped.map((s) => call(s, scopedParams(role, target))),
            );
            return found
              .flat()
              .filter((job) => matches(job, target, { scoped: true }));
          }),
        ),
      ]);
      const kept = loose
        .flat()
        .filter((job) => plan.targets.some((target) => matches(job, target)));
      return [...kept, ...perTarget.flat()];
    }),
  );

  const jobs = dedupe(perKeyword.flat())
    .filter((job) => !isInternship(job))
    .filter((job) => plan.govmil || !requiresClearance(job))
    .map((job) => ({ ...job, url: stripTrackingParams(job.url) }));

  return {
    jobs,
    failures: [...failures].map(([source, message]) => ({ source, message })),
    allFailed: calls > 0 && succeeded === 0,
  };
}
```

- [ ] **Step 4: Move the filters out of `src/cli.ts`**

In `src/cli.ts`, delete the `INTERNSHIP_PATTERN` and `GOVMIL_PATTERN` constants and the `isInternship` and `requiresClearance` functions, and add (biome sorts the import):

```ts
import { isInternship, requiresClearance } from "./search.ts";

// Re-exported so existing importers (tests/cli.test.ts) keep working.
export { isInternship, requiresClearance };
```

`runSearch` keeps calling them until Task 10 replaces it.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/search.test.ts tests/cli.test.ts 2>&1 | tail -15 && bun run typecheck 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bunx @biomejs/biome check --write src/search.ts src/cli.ts tests/search.test.ts
git add src/search.ts src/cli.ts tests/search.test.ts
git commit -m "feat: collectJobs runs keywords by location with the central predicate" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: `runSearch` refactor with run registration

**Files:**
- Modify: `src/cli.ts` (imports; the whole `SearchOptions` interface and `runSearch` function; `createProgram` first parameter type; the `search` command's `--role`)
- Modify: `tests/cli.test.ts` (the "requires --role" test)
- Test: `tests/runSearch.test.ts` (new)

**Interfaces:**
- Consumes: `toSearchOptions`, `loadConfig`, `resolveDbPath` (Tasks 3 and 4); `SEARCH_RUN_KEY`, `startRun`, `finishRun` (Task 6); `collectJobs`, `formatRunMessage`, `SearchResult` (Task 9); `Env` (Task 1).
- Produces (from `src/cli.ts`):
  - `SearchOptions { location?: string[]; remote?: boolean; onsite?: boolean; role?: string[]; json: boolean; csv: boolean; db?: string; config?: string; clearance: boolean }`
  - `interface SearchDeps { sources?: Source[]; isUrlDead?: (url: string) => Promise<boolean>; cwd?: string; env?: Env }`
  - `runSearch(options: SearchOptions, deps?: SearchDeps): Promise<SearchResult | null>`: `null` when refused because a search is already live (prints `error: search already running`, sets `process.exitCode = 1`, calls no source).
  - `createProgram(searchAction: (options: SearchOptions) => Promise<unknown> = runSearch, ...)`.

Behavior:
- Resolve the DB path, open the DB, and claim `runs(kind='search', key='search')` with `process.pid` for every invocation (config-driven or flag-only), before reading any search settings. The TUI child always gets `--db`, so resolving never reads the config there and a bad config is recorded on the run. Without `--db`, a broken config file makes `resolveDbPath` throw before the claim (there is no DB path to record into); that error is printed by `main`.
- Plan with `toSearchOptions(options, () => loadConfig(...))`, collect, dead-URL check, upsert.
- `finishRun(ok, formatRunMessage(result))` where `ok = !allFailed`. When every source failed, also set `process.exitCode = 1`. Any throw (bad config, DB error) records `ok = false` with the error message and rethrows.
- Printing (`--json`, `--csv`, or the per-job lines and summary) is unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/runSearch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type SearchOptions, runSearch } from "../src/cli.ts";
import { ConfigError } from "../src/config.ts";
import {
  SEARCH_RUN_KEY,
  allJobs,
  getRun,
  openDb,
  startRun,
} from "../src/db.ts";
import type {
  NormalizedJob,
  SearchParams,
  Source,
} from "../src/sources/types.ts";

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

function fake(
  jobs: NormalizedJob[],
  scoped = false,
  name: NormalizedJob["source"] = "greenhouse",
) {
  const calls: SearchParams[] = [];
  const source: Source = {
    name,
    scoped,
    async search(params) {
      calls.push(params);
      return jobs;
    },
  };
  return { source, calls };
}

function broken(name: NormalizedJob["source"], message: string): Source {
  return {
    name,
    scoped: name === "jsearch" || name === "adzuna",
    async search() {
      throw new Error(message);
    },
  };
}

const flags = (over: Partial<SearchOptions> = {}): SearchOptions => ({
  json: false,
  csv: false,
  clearance: false,
  ...over,
});

let root: string;
let cwd: string;
let env: Record<string, string>;
let spies: { mockRestore(): void }[];

const dbPath = () => join(root, "data", "igor", "igor.db");
const deps = (sources: Source[]) => ({
  sources,
  isUrlDead: async () => false,
  cwd,
  env,
});
const writeGlobal = (text: string) => {
  const path = join(root, "cfg", "igor", "config.toml");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const searchRun = () => {
  const db = openDb(dbPath());
  const run = getRun(db, "search", SEARCH_RUN_KEY);
  db.close();
  return run;
};

const OMAHA_AND_US =
  '[[location]]\ncity = "Omaha"\nflexibility = "in-person"\n[[location]]\ncity = "United States"\nflexibility = "remote"\n[[keywords]]\nrole = "swe"\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "igor-runsearch-"));
  cwd = join(root, "proj");
  mkdirSync(cwd);
  env = { XDG_CONFIG_HOME: join(root, "cfg"), XDG_DATA_HOME: join(root, "data") };
  spies = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  process.exitCode = 0;
  rmSync(root, { recursive: true, force: true });
});

describe("runSearch from the config", () => {
  it("filters per location, stores jobs, returns and records the summary", async () => {
    writeGlobal(OMAHA_AND_US);
    const source = fake([
      job({ sourceId: "o", location: "Omaha, NE", remoteType: "onsite", url: "https://e.com/o" }),
      job({ sourceId: "r", title: "Remote SWE", location: "Remote - USA", remoteType: "remote", url: "https://e.com/r" }),
      job({ sourceId: "a", title: "Austin SWE", location: "Austin, TX", remoteType: "onsite", url: "https://e.com/a" }),
    ]);
    const result = await runSearch(flags(), deps([source.source]));
    expect(result).toEqual({ found: 2, new: 2, failures: [] });
    expect(source.calls).toEqual([{ role: "swe" }]);
    const db = openDb(dbPath());
    expect(allJobs(db)).toHaveLength(2);
    db.close();
    expect(searchRun()).toMatchObject({ ok: true, message: "2 found, 2 new" });
  });

  it("passes flag overrides through to scoped sources", async () => {
    writeGlobal(OMAHA_AND_US);
    const scoped = fake([], true, "jsearch");
    await runSearch(flags({ location: ["Reno"], remote: true }), deps([scoped.source]));
    expect(scoped.calls).toEqual([{ role: "swe", location: "Reno", remote: true }]);
  });

  it("appends failed sources to the message but stays ok", async () => {
    writeGlobal(OMAHA_AND_US);
    const result = await runSearch(
      flags(),
      deps([broken("jsearch", "429"), fake([job({})]).source]),
    );
    expect(result?.failures).toEqual([{ source: "jsearch", message: "429" }]);
    expect(searchRun()).toMatchObject({
      ok: true,
      message: "1 found, 1 new; failed: jsearch: 429",
    });
  });

  it("fails the run when every source fails", async () => {
    writeGlobal(OMAHA_AND_US);
    await runSearch(flags(), deps([broken("jsearch", "429"), broken("remoteok", "500")]));
    expect(searchRun()?.ok).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});

describe("runSearch config errors", () => {
  it("records a bad config on the run when --db is given (the TUI child)", async () => {
    const file = writeGlobal('[[keyword]]\nrole = "swe"\n');
    await expect(
      runSearch(flags({ db: dbPath() }), deps([fake([]).source])),
    ).rejects.toThrow(ConfigError);
    const run = searchRun();
    expect(run?.ok).toBe(false);
    expect(run?.message).toContain(file);
  });

  it("refuses keywords without a location and never calls a source", async () => {
    writeGlobal('[[keywords]]\nrole = "swe"\n');
    const source = fake([job({})]);
    await expect(runSearch(flags(), deps([source.source]))).rejects.toThrow(
      /\[\[location\]\]/,
    );
    expect(source.calls).toHaveLength(0);
    expect(searchRun()?.ok).toBe(false);
  });

  it("hints at igor init when there is no config and no --role", async () => {
    await expect(runSearch(flags(), deps([]))).rejects.toThrow(/igor init/);
    expect(searchRun()?.message).toMatch(/igor init/);
  });
});

describe("runSearch run registration", () => {
  it("a flag-only run claims and finishes the search run", async () => {
    await runSearch(flags({ role: ["swe"], location: ["Omaha"] }), deps([fake([job({})]).source]));
    expect(searchRun()).toMatchObject({ ok: true, message: "1 found, 1 new" });
  });

  it("is refused while another live process holds the search run", async () => {
    const db = openDb(dbPath());
    startRun(db, "search", SEARCH_RUN_KEY, 1); // pid 1 is always alive
    db.close();
    const source = fake([job({})]);
    const result = await runSearch(flags({ role: ["swe"] }), deps([source.source]));
    expect(result).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(source.calls).toHaveLength(0);
    expect(searchRun()?.pid).toBe(1);
  });
});
```

In `tests/cli.test.ts`, replace the test `it("requires --role", ...)` with:

```ts
  it("does not require --role (the config supplies keywords)", async () => {
    const { program, calls } = programWithSpy();
    await program.parseAsync(["node", "igor", "search"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.role).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/runSearch.test.ts tests/cli.test.ts 2>&1 | tail -15`
Expected: FAIL (`runSearch` ignores `deps`; `--role` is required).

- [ ] **Step 3: Imports**

In `src/cli.ts`:
- Extend the `./config.ts` import to `import { ConfigError, describeConfig, loadConfig, resolveDbPath, toSearchOptions } from "./config.ts";`
- Extend the `./db.ts` import list with `SEARCH_RUN_KEY`, `finishRun`, `startRun`, and `type StoredJob` (keep `finishTailorRun` and `startTailorRun`, which `runTailor` uses).
- Replace `import { isInternship, requiresClearance } from "./search.ts";` with
  `import { type SearchResult, collectJobs, formatRunMessage, isInternship, requiresClearance } from "./search.ts";`
  (the `export { isInternship, requiresClearance };` line from Task 9 stays).
- Add `import type { Env } from "./paths.ts";`
- Remove `import { dedupe } from "./dedupe.ts";` and `stripTrackingParams` from the `./url.ts` import if nothing else in the file uses them after this task (`tsc` and biome report unused imports).

- [ ] **Step 4: Replace `SearchOptions` and `runSearch`**

Replace everything from `export interface SearchOptions {` through the closing `}` of `export async function runSearch(...)` (Task 5's version) with:

```ts
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
  clearance: boolean;
}

export interface SearchDeps {
  sources?: Source[];
  isUrlDead?: (url: string) => Promise<boolean>;
  cwd?: string;
  env?: Env;
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
    const collected = await collectJobs(plan, deps.sources ?? buildSources());
    jobs = collected.jobs;
    const deadCheck = deps.isUrlDead ?? isUrlDead;
    const states = new Map<string, ListingState>();
    await Promise.all(
      jobs.map(async (job) => {
        if (await deadCheck(job.url)) states.set(listingId(job), "inactive");
      }),
    );
    newJobs = upsertJobs(db, jobs, states);
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
```

`isUrlDead` is a function declaration further down the file, so it is hoisted.

- [ ] **Step 5: `createProgram`**

- Change the first parameter to `searchAction: (options: SearchOptions) => Promise<unknown> = runSearch,`.
- In the `search` command, replace

```ts
    .requiredOption(
      "--role <query...>",
      "role/title to search for (accepts multiple values)",
    )
```

with

```ts
    .option(
      "--role <query...>",
      "role/title to search for (accepts multiple values); omit to use the config's [[keywords]]",
    )
```

- Change its description to `"Search job sources (from the config, or --role) and store results"`.

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test 2>&1 | tail -20 && bun run typecheck 2>&1 | tail -10`
Expected: all PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
bunx @biomejs/biome check --write src/cli.ts tests/cli.test.ts tests/runSearch.test.ts
git add src/cli.ts tests/cli.test.ts tests/runSearch.test.ts
git commit -m "feat: config-driven igor search that returns its result and registers as a run" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: `igor init`

**Files:**
- Create: `src/init.ts`
- Modify: `src/cli.ts` (import; `collect` helper; `init` command before `return program;`)
- Test: `tests/init.test.ts`; extend `tests/cli.test.ts`

**Interfaces:**
- Consumes: `writeConfig`, `resolveDbPath`, `ConfigError`, `Flexibility` (Tasks 2 and 3); `globalConfigPath`, `Env` (Task 1); `openDb` (Task 5); `DB_HELP` (Task 5, module constant in `src/cli.ts`).
- Produces (from `src/init.ts`):
  - `interface InitOptions { location?: string[]; keywords?: string[]; work?: string[]; yes?: boolean; db?: string }`
  - `interface InitIO { ask(question: string): Promise<string>; log(message: string): void; env?: Env; cwd?: string }`
  - `parseWork(value: string): Flexibility | null` (`r`/`remote`; `i`/`in-person`/`onsite`/`hybrid`; `e`/`either`/`a`/`any`; anything else, including blank, is `null`)
  - `parseWorkFlags(values: string[], cities: string[]): Flexibility[] | null` (`null` when no `--work` was given)
  - `runInit(options: InitOptions, io: InitIO): Promise<boolean>` (`false` when an overwrite was declined and nothing was written)
  - `terminalIO(): InitIO & { close(): void }`
  - `igor init [--location <place>]... [--keywords <role>]... [--work <type | place:type>]... [--db <path>] [-y, --yes]`

Behavior (spec, "`igor init`"):
- Locations, then keywords: one per line, a blank line ends the list; commas are not separators. Three empty lists in a row give up with a `ConfigError`.
- Work type: with one location, one question for it. With several, the first question offers "same for all" (answer r, i, or e) or `p` to be asked per location. Blank means either (`any`).
- `--location`, `--keywords`, `--work` skip their prompts. `--work remote` applies to every location; `--work "Omaha, NE:in-person"` sets one (split at the last colon); a plain value is the default for locations without their own entry. A location with no entry and no default is an error, as is a `--work` naming a place that is not a location.
- If the global config exists: ask before overwriting (`--yes` answers yes). Declined: nothing is written, not even the DB.
- The DB path comes from `resolveDbPath` (`--db`, `IGOR_DB`, `[db] path`, global default). `openDb` creates tables only if missing, so an existing DB is kept as is. Never deletes anything.
- Prints the config path, the DB path, and next steps (`igor tui`, Ctrl+S). Does not prompt for `region`.

- [ ] **Step 1: Write the failing test**

Create `tests/init.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError, parseConfig } from "../src/config.ts";
import { allJobs, openDb, upsertJobs } from "../src/db.ts";
import { type InitIO, parseWork, runInit } from "../src/init.ts";

let root: string;
let env: Record<string, string>;
let logs: string[];

const configPath = () => join(root, "cfg", "igor", "config.toml");
const dbPath = () => join(root, "data", "igor", "igor.db");
const readConfig = () =>
  parseConfig(readFileSync(configPath(), "utf8"), configPath());

function scripted(answers: string[]): InitIO & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    env,
    cwd: root,
    log: (m) => logs.push(m),
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? "";
    },
  };
}

function existingConfig(text = "# mine\n") {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "igor-init-"));
  env = {
    XDG_CONFIG_HOME: join(root, "cfg"),
    XDG_DATA_HOME: join(root, "data"),
  };
  logs = [];
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("parseWork", () => {
  it("maps answers to a flexibility", () => {
    expect(parseWork("r")).toBe("remote");
    expect(parseWork(" Remote ")).toBe("remote");
    expect(parseWork("i")).toBe("in-person");
    expect(parseWork("onsite")).toBe("in-person");
    expect(parseWork("hybrid")).toBe("in-person");
    expect(parseWork("either")).toBe("any");
    expect(parseWork("any")).toBe("any");
    expect(parseWork("")).toBeNull();
    expect(parseWork("banana")).toBeNull();
  });
});

describe("runInit prompts", () => {
  it("reads one location per line, keeping 'Omaha, NE' whole, and asks per location", async () => {
    const io = scripted([
      "Omaha, NE",
      "United States",
      "",
      "software engineer",
      "devops engineer",
      "",
      "p",
      "i",
      "r",
    ]);
    expect(await runInit({}, io)).toBe(true);
    expect(readConfig()).toEqual({
      govmil: false,
      locations: [
        { city: "Omaha, NE", flexibility: "in-person", region: [] },
        { city: "United States", flexibility: "remote", region: [] },
      ],
      keywords: ["software engineer", "devops engineer"],
    });
    expect(existsSync(dbPath())).toBe(true);
  });

  it("offers 'same for all' first, so one answer covers every location", async () => {
    const io = scripted(["Omaha, NE", "Lincoln, NE", "", "swe", "", "i"]);
    await runInit({}, io);
    expect(readConfig().locations?.map((l) => l.flexibility)).toEqual([
      "in-person",
      "in-person",
    ]);
    expect(io.asked.some((q) => q.includes("same for all"))).toBe(true);
  });

  it("asks once for a single location and defaults to either", async () => {
    const io = scripted(["Omaha, NE", "", "swe", "", ""]);
    await runInit({}, io);
    expect(readConfig().locations?.[0]?.flexibility).toBe("any");
    expect(io.asked.some((q) => q.includes("same for all"))).toBe(false);
  });

  it("gives up with a ConfigError after three empty location lists", async () => {
    await expect(runInit({}, scripted([]))).rejects.toThrow(ConfigError);
  });

  it("prints the resolved paths and next steps", async () => {
    await runInit({ location: ["Omaha"], keywords: ["swe"], work: ["any"] }, scripted([]));
    const text = logs.join("\n");
    expect(text).toContain(configPath());
    expect(text).toContain(dbPath());
    expect(text).toContain("igor tui");
    expect(text).toContain("Ctrl+S");
  });
});

describe("runInit flags", () => {
  it("skips every prompt when all values are given", async () => {
    const io = scripted([]);
    await runInit(
      { location: ["Omaha, NE"], keywords: ["swe", "sre"], work: ["in-person"] },
      io,
    );
    expect(io.asked).toEqual([]);
    expect(readConfig().keywords).toEqual(["swe", "sre"]);
  });

  it("accepts --work per location, split at the last colon", async () => {
    await runInit(
      {
        location: ["Omaha, NE", "United States"],
        keywords: ["swe"],
        work: ["Omaha, NE:in-person", "United States:remote"],
      },
      scripted([]),
    );
    expect(readConfig().locations?.map((l) => l.flexibility)).toEqual([
      "in-person",
      "remote",
    ]);
  });

  it("uses a plain --work as the default next to per-location entries", async () => {
    await runInit(
      {
        location: ["Omaha, NE", "United States"],
        keywords: ["swe"],
        work: ["United States:remote", "in-person"],
      },
      scripted([]),
    );
    expect(readConfig().locations?.map((l) => l.flexibility)).toEqual([
      "in-person",
      "remote",
    ]);
  });

  it("rejects --work that leaves a location uncovered or names an unknown one", async () => {
    await expect(
      runInit(
        { location: ["Omaha", "United States"], keywords: ["swe"], work: ["Omaha:remote"] },
        scripted([]),
      ),
    ).rejects.toThrow('no --work entry for "United States"');
    await expect(
      runInit(
        { location: ["Omaha"], keywords: ["swe"], work: ["Reno:remote"] },
        scripted([]),
      ),
    ).rejects.toThrow(/"Reno", which is not one of the locations/);
  });

  it("rejects an invalid --work value", async () => {
    await expect(
      runInit({ location: ["Omaha"], keywords: ["swe"], work: ["banana"] }, scripted([])),
    ).rejects.toThrow(/invalid work type "banana"/);
  });
});

describe("runInit never destroys anything", () => {
  const flags = { location: ["Omaha"], keywords: ["swe"], work: ["any"] };

  it("asks before overwriting and does nothing if declined", async () => {
    existingConfig();
    const io = scripted([""]); // default answer: no
    expect(await runInit(flags, io)).toBe(false);
    expect(io.asked).toHaveLength(1);
    expect(readFileSync(configPath(), "utf8")).toBe("# mine\n");
    expect(existsSync(dbPath())).toBe(false);
  });

  it("overwrites without asking when --yes is given", async () => {
    existingConfig();
    const io = scripted([]);
    await runInit({ ...flags, yes: true }, io);
    expect(io.asked).toEqual([]);
    expect(readConfig().locations?.[0]?.city).toBe("Omaha");
  });

  it("keeps an existing database and its jobs", async () => {
    const db = openDb(dbPath());
    upsertJobs(db, [
      {
        sourceId: "1",
        source: "greenhouse",
        title: "SWE",
        company: "Acme",
        location: "Omaha",
        remoteType: "onsite",
        url: "https://e.com/1",
        postedAt: null,
        description: null,
      },
    ]);
    db.close();
    await runInit(flags, scripted([]));
    const again = openDb(dbPath());
    expect(allJobs(again)).toHaveLength(1);
    again.close();
    expect(logs.join("\n")).toContain("Using existing database");
  });
});
```

Append to `tests/cli.test.ts`:

```ts
describe("init command", () => {
  it("is registered with repeatable prompt-skipping flags", () => {
    const cmd = createProgram().commands.find((c) => c.name() === "init");
    expect(cmd?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(["--location", "--keywords", "--work", "--db", "--yes"]),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/init.test.ts tests/cli.test.ts 2>&1 | tail -15`
Expected: FAIL, cannot find module `../src/init.ts`.

- [ ] **Step 3: Create `src/init.ts`**

```ts
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  ConfigError,
  type Flexibility,
  resolveDbPath,
  writeConfig,
} from "./config.ts";
import { openDb } from "./db.ts";
import { type Env, globalConfigPath } from "./paths.ts";

export interface InitOptions {
  location?: string[];
  keywords?: string[];
  work?: string[];
  yes?: boolean;
  db?: string;
}

export interface InitIO {
  ask(question: string): Promise<string>;
  log(message: string): void;
  env?: Env;
  cwd?: string;
}

const WORK_ANSWERS: Record<string, Flexibility> = {
  r: "remote",
  remote: "remote",
  i: "in-person",
  "in-person": "in-person",
  "in person": "in-person",
  onsite: "in-person",
  "on-site": "in-person",
  hybrid: "in-person",
  e: "any",
  either: "any",
  a: "any",
  any: "any",
};

const WORK_CHOICES = "[r]emote, [i]n-person (onsite or hybrid), or [e]ither";

export function parseWork(value: string): Flexibility | null {
  return WORK_ANSWERS[value.trim().toLowerCase()] ?? null;
}

/**
 * `--work` values: a plain type applies to every location without its own
 * entry; `<location>:<type>` (split at the last colon, so "Omaha, NE:remote"
 * works) sets one. Returns null when no --work was given.
 */
export function parseWorkFlags(
  values: string[],
  cities: string[],
): Flexibility[] | null {
  if (values.length === 0) return null;
  let fallback: Flexibility | null = null;
  const perCity = new Map<string, Flexibility>();
  for (const value of values) {
    const colon = value.lastIndexOf(":");
    const type = colon === -1 ? value : value.slice(colon + 1);
    const flexibility = parseWork(type);
    if (!flexibility) {
      throw new ConfigError(
        `invalid work type "${type.trim()}" in --work (use remote, in-person, or any)`,
      );
    }
    if (colon === -1) {
      if (fallback) {
        throw new ConfigError("--work without a location may be given once");
      }
      fallback = flexibility;
      continue;
    }
    const place = value.slice(0, colon).trim();
    if (!cities.some((city) => city.toLowerCase() === place.toLowerCase())) {
      throw new ConfigError(
        `--work names "${place}", which is not one of the locations`,
      );
    }
    perCity.set(place.toLowerCase(), flexibility);
  }
  return cities.map((city) => {
    const flexibility = perCity.get(city.toLowerCase()) ?? fallback;
    if (!flexibility) throw new ConfigError(`no --work entry for "${city}"`);
    return flexibility;
  });
}

function clean(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

/** One item per line until a blank line. Commas are part of an item. */
async function askLines(
  io: InitIO,
  intro: string,
  what: string,
): Promise<string[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    io.log(intro);
    const items: string[] = [];
    let line = (await io.ask("> ")).trim();
    while (line !== "") {
      items.push(line);
      line = (await io.ask("> ")).trim();
    }
    if (items.length > 0) return items;
    io.log(`Enter at least one ${what}.`);
  }
  throw new ConfigError(`no ${what} given`);
}

async function askFlexibility(
  io: InitIO,
  question: string,
  allowPerLocation: boolean,
): Promise<Flexibility | "per-location"> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await io.ask(question)).trim().toLowerCase();
    if (answer === "") return "any";
    if (allowPerLocation && (answer === "p" || answer === "per location")) {
      return "per-location";
    }
    const flexibility = parseWork(answer);
    if (flexibility) return flexibility;
    io.log(
      `Please answer remote, in-person, or either${allowPerLocation ? ", or p to choose per location" : ""}.`,
    );
  }
  throw new ConfigError("no valid work type given");
}

async function askWork(io: InitIO, cities: string[]): Promise<Flexibility[]> {
  if (cities.length > 1) {
    const all = await askFlexibility(
      io,
      `Work type, same for all locations: ${WORK_CHOICES}? Or [p] to choose per location. (default: either) `,
      true,
    );
    if (all !== "per-location") return cities.map(() => all);
  }
  const perCity: Flexibility[] = [];
  for (const city of cities) {
    const one = await askFlexibility(
      io,
      `Work type for ${city}: ${WORK_CHOICES}? (default: either) `,
      false,
    );
    if (one !== "per-location") perCity.push(one);
  }
  return perCity;
}

/**
 * Writes the global config and creates the database if missing. Never
 * deletes anything: an existing db is kept, and an existing config is only
 * replaced after confirmation (or --yes).
 */
export async function runInit(
  options: InitOptions,
  io: InitIO,
): Promise<boolean> {
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const configPath = globalConfigPath(env);

  if (existsSync(configPath) && !options.yes) {
    const answer = await io.ask(
      `${configPath} already exists. Overwrite it? [y/N] `,
    );
    if (!/^y(es)?$/i.test(answer.trim())) {
      io.log(`Left ${configPath} unchanged; nothing was written.`);
      return false;
    }
  }

  const flagCities = clean(options.location);
  const cities =
    flagCities.length > 0
      ? flagCities
      : await askLines(
          io,
          "Locations to search, one per line; a blank line ends the list. Use specific cities for in-person work (e.g. Omaha, NE); a region like United States suits remote work.",
          "location",
        );
  const flagRoles = clean(options.keywords);
  const roles =
    flagRoles.length > 0
      ? flagRoles
      : await askLines(
          io,
          "Keywords (job titles) to search for, one per line; a blank line ends the list (e.g. software engineer).",
          "keyword",
        );
  const flexibilities =
    parseWorkFlags(clean(options.work), cities) ??
    (await askWork(io, cities));

  writeConfig(configPath, {
    govmil: false,
    locations: cities.map((city, i) => ({
      city,
      flexibility: flexibilities[i] ?? "any",
      region: [],
    })),
    keywords: roles,
  });

  const dbPath = resolveDbPath({ db: options.db, cwd, env });
  const existed = existsSync(dbPath);
  // Creates tables only if missing; existing data is untouched.
  openDb(dbPath).close();

  io.log(`Wrote ${configPath}`);
  io.log(`${existed ? "Using existing" : "Created"} database ${dbPath}`);
  io.log(
    'Next: run "igor tui" and press Ctrl+S to search, or run "igor search".',
  );
  return true;
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

- [ ] **Step 4: Register the command**

In `src/cli.ts` add `import { type InitOptions, runInit, terminalIO } from "./init.ts";` and, above `export function createProgram(`:

```ts
/** Commander reducer for repeatable options. */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
```

Before `return program;` in `createProgram` add:

```ts
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
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/init.test.ts tests/cli.test.ts 2>&1 | tail -15 && bun run typecheck 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 6: Smoke the real command against a scratch dir**

Run:
```bash
T=$(mktemp -d) && XDG_CONFIG_HOME=$T/c XDG_DATA_HOME=$T/d bun run src/cli.ts init --location "Omaha, NE" --location "United States" --keywords "software engineer" --work "Omaha, NE:in-person" --work "United States:remote" && XDG_CONFIG_HOME=$T/c XDG_DATA_HOME=$T/d bun run src/cli.ts config
```
Expected: init prints `Wrote ...`, `Created database ...`, and the next-step hint; `config` lists the file, the DB under `$T/d`, and two `[[location]]` tables with the right flexibility.

- [ ] **Step 7: Commit**

```bash
bunx @biomejs/biome check --write src/init.ts src/cli.ts tests/init.test.ts tests/cli.test.ts
git add src/init.ts src/cli.ts tests/init.test.ts tests/cli.test.ts
git commit -m "feat: igor init creates the global config and database" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: TUI background search launcher

**Files:**
- Create: `src/tui/search.ts`
- Test: `tests/tuiSearch.test.ts`

**Interfaces:**
- Consumes: `runningRuns`, `startRun`, `SEARCH_RUN_KEY`, `Run` (Task 6); `NO_DELEGATE_ENV` (`src/checkout.ts`).
- Produces (from `src/tui/search.ts`):
  - `interface SpawnRequest { cmd: string[]; cwd: string; env: Record<string, string | undefined>; stdio: ["ignore", number, number]; detached: true }`
  - `interface SpawnedProcess { pid: number; unref(): void }`
  - `type SpawnFn = (request: SpawnRequest) => SpawnedProcess` (injected in tests; defaults to `Bun.spawn`)
  - `searchLogPath(dbPath: string): string`: `igor-search.log` next to the DB.
  - `startBackgroundSearch(options: { db: Database; dbPath: string; configPath?: string; cwd?: string; spawn?: SpawnFn }): { started: boolean; message: string }`
  - `describeSearchRun(run: Run, dbPath: string): string`: `"Search done: <message>"` or `"Search failed: <message>"`, adding `" (see <log path>)"` when the process exited unexpectedly.

Behavior (spec, "TUI changes"):
- A live search run: `{ started: false, message: "search already running" }`, no spawn.
- Otherwise spawn `<bun> <cli.ts> search --db <absolute db>` plus `--config <absolute path>` only when the TUI was given an explicit config (flag or `IGOR_CONFIG`). Without one, no `--config` is passed, so the child reads the same global plus `./igor.toml` chain; the child gets the TUI's `cwd`, so the local file resolves identically. The child gets `IGOR_NO_DELEGATE=1`, is detached, and its stdout and stderr go to the log file, truncated (opened with `"w"`) on every launch. Then `startRun(db, "search", "search", child.pid)`.
- The TUI never reads search settings (keywords, locations, `govmil`).

- [ ] **Step 1: Write the failing test**

Create `tests/tuiSearch.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEARCH_RUN_KEY, finishRun, getRun, openDb } from "../src/db.ts";
import {
  type SpawnRequest,
  describeSearchRun,
  searchLogPath,
  startBackgroundSearch,
} from "../src/tui/search.ts";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "igor-tui-"));
  const dbPath = join(dir, "igor.db");
  const db = openDb(dbPath);
  const requests: SpawnRequest[] = [];
  // Returning our own pid keeps the recorded run live for the whole test.
  const spawn = (request: SpawnRequest) => {
    requests.push(request);
    return { pid: process.pid, unref() {} };
  };
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, db, dbPath, requests, spawn, cleanup };
}

const argAfter = (cmd: string[], flag: string) =>
  cmd.includes(flag) ? cmd[cmd.indexOf(flag) + 1] : undefined;

describe("startBackgroundSearch", () => {
  it("spawns a detached igor search with absolute paths and records the run", () => {
    const h = harness();
    const result = startBackgroundSearch({
      db: h.db,
      dbPath: "igor.db",
      configPath: "my.toml",
      cwd: h.dir,
      spawn: h.spawn,
    });
    expect(result.started).toBe(true);
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0] as SpawnRequest;
    expect(request.cmd).toContain("search");
    expect(argAfter(request.cmd, "--db")).toBe(join(h.dir, "igor.db"));
    expect(argAfter(request.cmd, "--config")).toBe(join(h.dir, "my.toml"));
    expect(request.cwd).toBe(h.dir);
    expect(request.detached).toBe(true);
    expect(request.env.IGOR_NO_DELEGATE).toBe("1");
    expect(getRun(h.db, "search", SEARCH_RUN_KEY)).toMatchObject({
      pid: process.pid,
      finishedAt: null,
    });
    h.cleanup();
  });

  it("passes no --config when the TUI has none, so the child reads the same chain", () => {
    const h = harness();
    startBackgroundSearch({ db: h.db, dbPath: h.dbPath, cwd: h.dir, spawn: h.spawn });
    expect(h.requests[0]?.cmd).not.toContain("--config");
    h.cleanup();
  });

  it("sends output to a log next to the db, truncated per run", () => {
    const h = harness();
    const log = searchLogPath(h.dbPath);
    expect(log).toBe(join(h.dir, "igor-search.log"));
    writeFileSync(log, "output from an older run\n");
    startBackgroundSearch({ db: h.db, dbPath: h.dbPath, cwd: h.dir, spawn: h.spawn });
    expect(readFileSync(log, "utf8")).toBe("");
    const [stdin, stdout, stderr] = h.requests[0]?.stdio ?? [];
    expect(stdin).toBe("ignore");
    expect(typeof stdout).toBe("number");
    expect(stderr).toBe(stdout);
    h.cleanup();
  });

  it("refuses to start a second search while one is running", () => {
    const h = harness();
    startBackgroundSearch({ db: h.db, dbPath: h.dbPath, cwd: h.dir, spawn: h.spawn });
    expect(
      startBackgroundSearch({ db: h.db, dbPath: h.dbPath, cwd: h.dir, spawn: h.spawn }),
    ).toEqual({ started: false, message: "search already running" });
    expect(h.requests).toHaveLength(1);
    h.cleanup();
  });

  it("allows a new search once the previous one finished", () => {
    const h = harness();
    startBackgroundSearch({ db: h.db, dbPath: h.dbPath, cwd: h.dir, spawn: h.spawn });
    finishRun(h.db, "search", SEARCH_RUN_KEY, true, "3 found, 1 new");
    expect(
      startBackgroundSearch({ db: h.db, dbPath: h.dbPath, cwd: h.dir, spawn: h.spawn })
        .started,
    ).toBe(true);
    expect(h.requests).toHaveLength(2);
    h.cleanup();
  });
});

describe("describeSearchRun", () => {
  const run = (ok: boolean, message: string) => ({
    kind: "search" as const,
    key: SEARCH_RUN_KEY,
    pid: 1,
    startedAt: "",
    finishedAt: "",
    ok,
    message,
  });

  it("shows the summary or the failure", () => {
    expect(describeSearchRun(run(true, "3 found, 1 new"), "/d/igor.db")).toBe(
      "Search done: 3 found, 1 new",
    );
    expect(describeSearchRun(run(false, "bad config"), "/d/igor.db")).toBe(
      "Search failed: bad config",
    );
  });

  it("points at the log when the process died", () => {
    expect(
      describeSearchRun(run(false, "search process exited unexpectedly"), "/d/igor.db"),
    ).toBe(
      "Search failed: search process exited unexpectedly (see /d/igor-search.log)",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tuiSearch.test.ts 2>&1 | tail -15`
Expected: FAIL, cannot find module `../src/tui/search.ts`.

- [ ] **Step 3: Implement**

Create `src/tui/search.ts`:

```ts
import type { Database } from "bun:sqlite";
import { closeSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NO_DELEGATE_ENV } from "../checkout.ts";
import { type Run, SEARCH_RUN_KEY, runningRuns, startRun } from "../db.ts";

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
}

export type SpawnFn = (request: SpawnRequest) => SpawnedProcess;

const defaultSpawn: SpawnFn = (request) => Bun.spawn(request);

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

/**
 * Starts a detached `igor search` that outlives the TUI. The TUI only
 * resolves paths; the child reads the search settings and reports any
 * problem through its run row.
 */
export function startBackgroundSearch(options: BackgroundSearchOptions): {
  started: boolean;
  message: string;
} {
  const { db, spawn = defaultSpawn } = options;
  const cwd = options.cwd ?? process.cwd();
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
  startRun(db, "search", SEARCH_RUN_KEY, child.pid);
  return {
    started: true,
    message: `Searching in the background (survives quitting); log: ${logPath}`,
  };
}

export function describeSearchRun(run: Run, dbPath: string): string {
  const message = run.message ?? "";
  if (run.ok) return `Search done: ${message}`;
  const hint = message.endsWith("exited unexpectedly")
    ? ` (see ${searchLogPath(resolve(dbPath))})`
    : "";
  return `Search failed: ${message}${hint}`;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/tuiSearch.test.ts 2>&1 | tail -15 && bun run typecheck 2>&1 | tail -5`
Expected: PASS. Bun's `stdio` accepts a numeric file descriptor for stdout and stderr; if `tsc` rejects `Bun.spawn(request)` on the tuple type, change only `defaultSpawn` to `(request) => Bun.spawn({ ...request, stdio: [...request.stdio] })`, keeping the runtime behavior.

- [ ] **Step 5: Commit**

```bash
bunx @biomejs/biome check --write src/tui/search.ts tests/tuiSearch.test.ts
git add src/tui/search.ts tests/tuiSearch.test.ts
git commit -m "feat: detached background search launcher for the TUI" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 13: Wire Ctrl+S into the TUI

**Files:**
- Modify: `src/tui/index.ts`, `src/tui/App.tsx`, `src/cli.ts` (`node:path` import; `tui` action)

**Interfaces:**
- Consumes: `startBackgroundSearch`, `describeSearchRun` (Task 12); `getRun`, `runningRuns`, `SEARCH_RUN_KEY` (Task 6); `resolveDbPath` (Task 3).
- Produces: `TuiOptions.config?: string`; `JobBrowser` prop `configPath?: string`; Ctrl+S runs `handleSearch`; a pulsing "Searching..." header indicator driven by `runs` (so it survives TUI restarts); on finish the job list reloads and the status shows `describeSearchRun`; footer gains `search [⌃s]`.

- [ ] **Step 1: `src/tui/index.ts`**

Replace the file with:

```ts
import { render } from "ink";
import React from "react";
import { openDb } from "../db.ts";
import { formatGitVersion, gitVersion } from "../version.ts";
import JobBrowser from "./App.tsx";

export interface TuiOptions {
  /** Absolute db path (from resolveDbPath). */
  db: string;
  /** Explicit config file, forwarded to detached `igor search` children. */
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
```

(The old file destructured an unused `unmount`; dropping it is intentional.)

- [ ] **Step 2: `src/cli.ts` `tui` command**

Change `import { dirname } from "node:path";` to `import { dirname, resolve } from "node:path";`. Replace the `tui` command's action (as left by Task 5) with:

```ts
    .action(async (options: { db?: string; config?: string }) => {
      // The TUI resolves paths only; the spawned search reads the settings.
      const config = options.config ?? (process.env.IGOR_CONFIG || undefined);
      await runTui({
        db: resolveDbPath({ db: options.db, config }),
        config: config ? resolve(config) : undefined,
      });
    });
```

- [ ] **Step 3: `src/tui/App.tsx`**

(a) Imports. Replace

```ts
import {
  allJobs,
  getTailorRun,
  getTailoredResume,
  runningTailorIds,
  setJobApplied,
  setJobState,
  startTailorRun,
  tailoredListingIds,
} from "../db.ts";
import { linkifyPdfPath, openTarget } from "./open.ts";
```

with

```ts
import {
  SEARCH_RUN_KEY,
  allJobs,
  getRun,
  getTailorRun,
  getTailoredResume,
  runningRuns,
  runningTailorIds,
  setJobApplied,
  setJobState,
  startTailorRun,
  tailoredListingIds,
} from "../db.ts";
import { linkifyPdfPath, openTarget } from "./open.ts";
import { describeSearchRun, startBackgroundSearch } from "./search.ts";
```

(b) Props. Replace

```ts
  /** Path to the sqlite file, passed to the detached `igor tailor` children. */
  dbPath: string;
```

with

```ts
  /** Absolute path to the sqlite file, passed to the detached igor children. */
  dbPath: string;
  /** Explicit config file (--config or IGOR_CONFIG), forwarded to `igor search`. */
  configPath?: string;
```

and change `export default function JobBrowser({ db, dbPath, version = null }: AppProps) {` to `export default function JobBrowser({ db, dbPath, configPath, version = null }: AppProps) {`.

(c) Footer. Replace

```ts
const FOOTER_AFTER =
  " [a] | toggle view [⌃e] | refresh (auto-archives dead jobs) [⌃r] | quit [q/Ctrl+C]";
```

with

```ts
const FOOTER_AFTER =
  " [a] | toggle view [⌃e] | search [⌃s] | refresh (auto-archives dead jobs) [⌃r] | quit [q/Ctrl+C]";
```

`FOOTER_TEXT` is built from it, so the wrap-height math stays in sync.

(d) State. In the comment above `tailoringIds`, change `the tailor_runs table is the` to `the runs table is the`. Directly after `const prevRunning = useRef<Set<string>>(tailoringIds);` add:

```tsx
  // A detached `igor search`; the runs table is the source of truth, so the
  // indicator survives restarting the TUI.
  const [isSearching, setIsSearching] = useState(
    () => runningRuns(db, "search").length > 0,
  );
  const prevSearching = useRef(isSearching);
```

(e) Poll. Replace the end of the polling effect

```tsx
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [db]);
```

with

```tsx
      }
      const searching = runningRuns(db, "search").length > 0;
      if (prevSearching.current && !searching) {
        setJobs(allJobs(db));
        const run = getRun(db, "search", SEARCH_RUN_KEY);
        // Stays until the next status, so a failure can be read.
        if (run) setStatusMessage(describeSearchRun(run, dbPath));
      }
      prevSearching.current = searching;
      setIsSearching(searching);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [db, dbPath]);
```

(f) Pulse timer. Replace

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

(g) Handler. Directly after the line `}, [db, dbPath, visibleJobs, selectedIndex, tailoringIds]);` that closes `handleTailor`, add:

```tsx
  const handleSearch = useCallback(() => {
    const result = startBackgroundSearch({ db, dbPath, configPath });
    if (!result.started) {
      showStatus(result.message);
      return;
    }
    prevSearching.current = true;
    setIsSearching(true);
    setStatusMessage(result.message);
  }, [db, dbPath, configPath, showStatus]);
```

(h) Key binding. In `handleInput`, directly after the Ctrl+R block

```tsx
      if (key.ctrl && input === "r") {
        if (!isRefreshing) handleRefresh();
        return;
      }
```

add

```tsx
      if (key.ctrl && input === "s") {
        handleSearch();
        return;
      }
```

and add `handleSearch,` to that callback's dependency array next to `handleTailor,`.

(i) Header indicator. In the header's left `<Box flexShrink={1} marginRight={2}>`, directly after the `{version && ( ... )}` block, add:

```tsx
          {isSearching && (
            <Text color={pulseColor(pulseTick)} wrap="truncate-end">
              {"  Searching..."}
            </Text>
          )}
```

It sits in the existing single header line, so `HEADER_LINES` and the layout math are unchanged.

(j) Empty state. Replace

```tsx
            <Text dimColor>Run a search first:</Text>
            <Text dimColor> igor search --role "software engineer"</Text>
```

with

```tsx
            <Text dimColor>Press ctrl+S to search (run igor init first if you have no config)</Text>
```

- [ ] **Step 4: Verify**

Run: `bun test 2>&1 | tail -20 && bun run typecheck 2>&1 | tail -10 && bunx @biomejs/biome check src tests 2>&1 | tail -10`
Expected: all green.

- [ ] **Step 5: Manual check (tmux and Terminal.app)**

Needs a real terminal; if none is available, report this step as not run rather than skipping it silently. Ctrl+S is unbound elsewhere in `App.tsx` and Ink's raw mode disables XOFF flow control, so this is a check, not a design change.

```bash
export T=$(mktemp -d) XDG_CONFIG_HOME=$T/c XDG_DATA_HOME=$T/d
bun run src/cli.ts init --location "Omaha, NE" --keywords "software engineer" --work any
bun run tui
```

In both tmux and Terminal.app: press Ctrl+S. The terminal must not freeze; the header shows a pulsing `Searching...` and the status line shows the log path. Quit with `q` while it runs, start `bun run tui` again: the indicator is still shown until the search finishes, then the list reloads and `Search done: N found, M new` appears. Press Ctrl+S twice quickly: the second shows `search already running`. Then break the config (`printf '[[keyword]]\n' > $T/c/igor/config.toml`), press Ctrl+S, and confirm `Search failed: .../config.toml: top level has unknown key "keyword" ...`. Confirm `$T/d/igor/igor-search.log` holds only the latest run's output.

- [ ] **Step 6: Commit**

```bash
bunx @biomejs/biome check --write src/tui src/cli.ts
git add src/tui src/cli.ts
git commit -m "feat: ctrl+S starts a detached background search from the TUI" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 14: Docs and example config

**Files:**
- Create: `igor.example.toml`
- Modify: `README.md` (the `## Usage` block; the `## TUI` usage line and key list), `.env.example`

- [ ] **Step 1: Write `igor.example.toml`**

```toml
# Copy to igor.toml (per project) or ~/.config/igor/config.toml (global).
# `igor init` writes the global one for you. A local igor.toml is merged over
# the global file: [job] keys override one by one, while [[location]] and
# [[keywords]] REPLACE the global lists if the local file defines them.

[job]
govmil = false             # true to include jobs that mention a clearance

# Uncomment for a self-contained sandbox next to this file (relative paths
# resolve against this file's directory). Default: ~/.local/share/igor/igor.db
# [db]
# path = "igor.db"

# Every keyword is searched in every location. At least one of each is required.
# Use specific cities for in-person work; broad regions only match listings
# that name the region.
[[location]]
city = "Omaha"
flexibility = "in-person"  # remote | in-person (onsite or hybrid) | any (default)
region = ["Nebraska"]      # optional: extra places a REMOTE listing may name

[[location]]
city = "United States"
flexibility = "remote"

[[keywords]]
role = "Software Engineer"

[[keywords]]
role = "DevOps Engineer"
```

- [ ] **Step 2: Update `README.md`**

Replace the `## Usage` section (the fenced `igor search --role ...` command and its bullet list, through the `--db` bullet) with:

````markdown
## Setup

```bash
igor init
```

asks for locations and keywords (one per line; "Omaha, NE" is one location)
and a work type, then writes `~/.config/igor/config.toml` and creates
`~/.local/share/igor/igor.db` (`XDG_CONFIG_HOME` / `XDG_DATA_HOME` are
honored). It never deletes anything, and asks before replacing an existing
config. Non-interactive: `igor init --location "Omaha, NE" --keywords
"software engineer" --work in-person` (each flag repeatable; `--work
"Omaha, NE:in-person"` sets one location). See `igor.example.toml`.

A `./igor.toml` in the current directory is merged over the global config:
`[job]` keys override one by one, and `[[location]]` / `[[keywords]]` replace
the global lists. `[db] path = "igor.db"` in a local file gives a
self-contained sandbox (relative paths resolve against that file's
directory). `igor config` shows which files and database are in use.

Precedence, high to low: CLI flags, `IGOR_DB` / `IGOR_CONFIG`, local
`igor.toml`, global `config.toml`, defaults. `--config <path>` (or
`IGOR_CONFIG`) uses only that one file. There is no fallback to a
`./igor.db` in the current directory.

`flexibility` per `[[location]]`:

- `remote`: listings marked remote whose location is blank, global
  ("Worldwide", "Anywhere"), or names the place. "United States" also
  matches USA, US, and North America; Omaha also matches Nebraska. Add
  `region = ["Texas", "TX"]` to widen another city.
- `in-person` (onsite or hybrid): anything not marked remote, located in the
  city (Omaha includes La Vista, Elkhorn, and Ralston).
- `any` (default): either of the above.

Only some sources say whether a job is remote, so `remote` favors precision
over recall, and hybrid is not told apart from onsite.

## Usage

```bash
igor search [--role <query...>] [--location <place...>] [--remote|--onsite] [--clearance] [--json] [--csv] [--db <path>] [--config <path>]
```

- no `--role`: the config's `[[keywords]]` and `[[location]]` entries drive the search
- `--role`: search for exactly these roles instead (the config is not read); accepts multiple values, e.g. `--role engineer manager`
- `--location`: replace the config's locations; accepts multiple values, e.g. `--location Omaha "San Francisco"`
- `--remote` / `--onsite`: only remote / only not-remote jobs for every location (mutually exclusive)
- `--clearance`: include jobs that mention a clearance requirement (`govmil = true` in the config does the same)
- `--json` / `--csv`: print all jobs stored in the db
- `--db`: path to the sqlite db (default: the precedence chain above)
- `--config`: config file to use instead of the global plus local chain

Every `igor search`, including one started by hand, registers itself as the
db's single search run: it shows in the TUI, and a second one started while
it runs exits with "search already running". Failed sources are listed in
the run summary without failing the search.
````

In the `## TUI` section, change the usage line to `igor tui [--db <path>] [--config <path>]`, and add to the key list, before the `⌃t` entry:

```markdown
- ⌃s: search in the background with your config. It keeps running if you quit or restart the TUI; the header shows `Searching...`, the list reloads when it finishes, and output goes to `igor-search.log` next to the db
```

Also replace any remaining README mention of a default `igor.db` in the current directory with the global DB path.

- [ ] **Step 3: Update `.env.example`**

Append:

```
# Optional overrides (see README "Setup"): where the sqlite db lives, and a
# config file to use instead of the global config plus ./igor.toml.
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

---

### Task 15: Rollout: copy the main checkout's database (maintainer only)

This is the last step and it is for Tara only. It copies, never moves: the original `igor.db` in the main checkout is left in place. `sqlite3 .backup` is WAL-safe even if a TUI has the db open.

**Files:** none in the repo.

- [ ] **Step 1: Ask for confirmation**

Do not run anything yet. Tell Tara the exact source and destination below and wait for an explicit yes. Run it only after Tasks 1 to 14 are merged, or the branch is the one Tara runs. Recommend doing it before running `igor init` for real, since `init` creates an empty global DB (it keeps an existing one).

- [ ] **Step 2: Copy (only after Tara confirms)**

```bash
SRC=/Users/kitsune/projects/igor/igor.db
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/igor/igor.db"
test -f "$SRC" || { echo "no source db at $SRC"; exit 1; }
test -e "$DEST" && { echo "refusing: $DEST already exists ($(sqlite3 "$DEST" 'select count(*) from jobs') jobs); ask Tara"; exit 1; }
mkdir -p "$(dirname "$DEST")" && sqlite3 "$SRC" ".backup '$DEST'" && echo "copied to $DEST"
```

If `DEST` exists, stop and ask Tara; never overwrite or delete it.

- [ ] **Step 3: Verify**

```bash
sqlite3 "$SRC" "select count(*) from jobs where state = 'active'"
bun run src/cli.ts jobs active --db "$DEST" | jq 'length'
```

Expected: the same count. The copy's legacy `tailor_runs` table is migrated to `runs` the first time igor opens it; the source file is unchanged.

---

## Self-Review Notes

- **Spec coverage:**
  - Config schema, `smol-toml` parsing with `TomlError` line and column, hand-written validation of unknown keys and wrong types, `region`, `writeConfig` via `stringify`: Task 2.
  - Global/local layout, merge rules, precedence, `--config`, `IGOR_DB`/`IGOR_CONFIG`, relative `[db] path`, read per use: Task 3. `igor config`: Task 5.
  - Required locations and keywords, flag/config semantics, `--remote` with `--onsite` error, `igor init` hint: Task 4 (`toSearchOptions`), enforced in Task 10.
  - Removing every `--db` default in favor of the shared resolver: Task 5.
  - One central predicate (`matches` with remoteType semantics), `remoteEligible` with global terms and the alias table, `region`, word-boundary `matchesLocation`, Omaha metro plus "nebraska" for remote only, central normalization of unknown plus "remote": Task 7.
  - Scoped versus unscoped sources (`scoped: boolean`; jsearch and adzuna scoped; unscoped called once per keyword with no location; scoped skip place checks): Tasks 8 and 9.
  - `runSearch` returning `{ found, new, failures }`, per-(keyword, location) filtering, run message from returned failures, `ok = false` only when the run throws or every source fails: Tasks 9 and 10.
  - `runs` table, migration from `tailor_runs` (idempotent, `INSERT OR IGNORE`, one transaction), `startRun`/`finishRun`/`getRun`/`runningRuns(kind)`, crash handling in `runningRuns`, `runningTailorIds` on top: Task 6. `igor tailor` on `runs`: Task 6 via the wrappers `runTailor` already calls.
  - Search registration for every invocation and "search already running": Task 10.
  - `igor init` (one location per line, keywords per line, "same for all" first, `--yes`, repeatable `--location`/`--keywords`, `--work` for all or `city:flexibility`, never deletes, prints paths and next steps, no `region` prompt): Task 11.
  - TUI: `handleSearch` with injected spawn and already-running guard, absolute `--db`/`--config`, child cwd, `igor-search.log` truncated per run, poll with "Searching..." across restarts, reload and summary on finish, footer `^S` hint, manual tmux and Terminal.app check: Tasks 12 and 13.
  - Testing list: config (Tasks 2, 3), runs (Task 6, in `tailorRuns.test.ts`), location/predicate (Task 7), search (Tasks 9, 10), init (Task 11), TUI (Task 12).
  - Rollout: README and `igor.example.toml` (Task 14); `sqlite3 .backup` copy as the last step, maintainer only, confirmation first, original left in place (Task 15).
- **Ambiguities resolved (the spec is silent or loose here):**
  - Export names: the spec's `loadConfig` reads the file chain and returns `{ config, files }`; `resolveDbPath` and `describeConfig` also live in `src/config.ts`; `parseConfig` and `formatConfig` are exported helpers; `toSearchOptions(flags, load)` returns a `SearchPlan` (keywords times targets), not the CLI's `SearchOptions` type.
  - Required `[[location]]`/`[[keywords]]` is checked when a search is planned, not when a file is parsed, because a local file may define only `[job]` or `[db]`.
  - "Bare global term": after removing punctuation and the word "remote", the rest is empty or one of worldwide, anywhere, global, international, "anywhere in the world" (the last added so We Work Remotely's "Anywhere in the World" is eligible).
  - The "united states" aliases apply wherever a location is matched (so an onsite "Austin, TX, USA" matches in-person "United States", which names the region); "nebraska" for Omaha is remote-only, as the spec's tests require.
  - Ashby lists secondary locations ("Remote (US)" beside "New York, NY (HQ)"), which its old internal filter checked. To keep that recall once sources stop deciding location, `NormalizedJob.otherLocations` (matching only, not stored) carries them to the predicate.
  - "Every source fails" means at least one source call was made and none succeeded; failures are recorded once per source (first message). When every source fails the CLI also exits nonzero.
  - A failing `resolveDbPath` (broken config file and no `--db`) cannot be recorded because there is no DB path yet; it is printed by `main`. The TUI always passes `--db`, so its children always record config errors on the run.
  - The TUI forwards `--config` only when it has an explicit one (flag or `IGOR_CONFIG`); otherwise passing a single file would replace the global plus local chain. Same cwd covers the local file.
  - "The run message points at the log path on unexpected failure": `runningRuns` stays generic and writes "search process exited unexpectedly"; the TUI appends `(see <log>)` when showing it (`describeSearchRun`), and the start message also shows the log path.
  - `igor init` work prompt: with several locations, one question accepts r, i, or e for all, or `p` to ask per location; blank means either. A plain `--work` value is the default for locations without a `city:type` entry.
  - greenhouse keeps its own "remote in location text" rule (its tests expect it); the central normalization produces the same result for it and extends the rule to lever, adzuna, and jsearch.
- **Deliberate deviations from the old plan:** `Bun.TOML.parse`, `settings.ts`, `groupByFlexibility`/`SearchGroup`, the per-source `{ remote }` option on `matchesLocation`, `runningRunKeys`, and the separate `runs.test.ts` are gone.
- **Type consistency:** `Flexibility`, `LocationEntry`, `IgorConfig`, `ConfigError`, `LoadedConfig`, `SearchTarget`, `SearchPlan`, `SearchFlags`, `Run`, `RunKind`, `SEARCH_RUN_KEY`, `SourceFailure`, `CollectResult`, `SearchResult`, `SearchDeps`, `SpawnRequest`, `SpawnFn` are each defined once (see the produces/consumes table) and used with the same names and signatures downstream.
