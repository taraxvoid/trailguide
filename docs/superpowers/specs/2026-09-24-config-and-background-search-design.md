# TOML config, global/local layout, and background search

Date: 2026-09-24

## Goal

Make igor usable as an open-source tool and make the TUI a thin wrapper over
async work:

1. A TOML config describes what to search for.
2. Config and DB live in global (XDG) locations, with a local override.
3. `igor init` bootstraps a fresh install.
4. Ctrl+S in the TUI reads the config and starts a detached `igor search`
   process that survives closing or restarting the TUI. The TUI launches and
   observes; it does not own the operation.

## Non-goals

- No daemon, queue, scheduler, or cancellation.
- No per-keyword overrides (every keyword is searched in every location).
- No free-text parsing to tell hybrid from onsite.
- No auto-migration of a legacy `./igor.db`.

## Config schema

```toml
[job]
govmil = false            # include jobs requiring clearance (was --clearance)

[[location]]
city = "Omaha"
flexibility = "in-person" # "remote" | "in-person" | "any" (default "any")

[[location]]
city = "United States"
flexibility = "remote"

[[keywords]]
role = "Software Engineer"

[[keywords]]
role = "DevOps Engineer"
```

Semantics:

- A search runs the cross product of keywords and locations. `govmil` applies
  to all combinations.
- At least one `[[location]]` and one `[[keywords]]` are required, so a search
  can never be unbounded. Validation errors name the file and the field, e.g.
  `igor.toml: [[keywords]] entry 2 is missing "role"`.
- `flexibility`:
  - `remote`: only jobs with `remoteType == "remote"`. `city` acts as an
    eligibility region and matches loosely. Listings whose location is blank,
    "Worldwide", or "Anywhere" also match.
  - `in-person`: `remoteType !== "remote"`, so onsite, hybrid, and unknown.
    Docs and prompts spell this out as "onsite or hybrid". Only Lever, Ashby,
    and jobaps emit a hybrid/onsite signal, so no finer distinction is made.
  - `any`: no work-type filter.
- The CLI flags `--remote` / `--onsite` remain and apply to every `--location`
  given on the command line. `--onsite` keeps its current meaning (not remote).

Parsing uses `Bun.TOML.parse` (no new dependency), in `src/config.ts`:
`loadConfig`, `mergeConfigs`, `toSearchOptions`.

## File layout and precedence

- Global config: `${XDG_CONFIG_HOME:-~/.config}/igor/config.toml`
- Global DB: `${XDG_DATA_HOME:-~/.local/share}/igor/igor.db`
- Local override: `./igor.toml`, merged over the global file.
  - `[job]` scalars override per key.
  - `[[location]]` and `[[keywords]]` are replaced wholesale if the local file
    defines them (never concatenated), so a search can be narrowed locally.
- Optional `[db] path = "..."` in either file sets the DB path. A local
  `igor.toml` with `[db] path = "igor.db"` gives a self-contained sandbox.
- Precedence, high to low: CLI flags, `IGOR_*` env vars, local `igor.toml`,
  global `config.toml`, built-in defaults.
- `--config <path>` replaces the whole file chain with that single file.
- The `IGOR_*` env vars are `IGOR_DB` (database path) and `IGOR_CONFIG` (same
  effect as `--config`). Relative `[db] path` values resolve against the
  directory of the config file that set them, not the cwd.
- DB path: `--db`, then `[db] path`, then the global default. There is no
  legacy `./igor.db` fallback (hard switch).
- `igor config` prints resolved paths and the merged config.
- The config is read when a search starts, never cached.

## `igor init`

Creates the global DB and writes the global `config.toml`. Prompts:

1. Location(s), comma separated (become `[[location]] city` entries).
2. Keyword(s), comma separated, e.g. "software engineer, devops engineer".
3. Work type: remote, in-person (onsite or hybrid), or either. Applied as
   `flexibility` on every location entered.

Never deletes anything. An existing DB is kept as is (opening creates tables
only if missing). If the global config already exists, init asks before
overwriting it and does nothing if declined; `--yes` answers that question.
Non-interactive: `--location`, `--keywords`, `--work` skip their prompts.
Prints resolved paths and next steps (`igor tui`, Ctrl+S).

## Runs table (replaces `tailor_runs`)

```
runs(kind TEXT, key TEXT, pid INTEGER, started_at, finished_at, ok, message,
     PRIMARY KEY (kind, key))
```

- Latest run per (kind, key), as `tailor_runs` does today.
- `kind='tailor'`, `key=<listingId>`; `kind='search'`, `key='search'`
  (one search at a time).
- Migration in `openDb`: if `tailor_runs` exists, copy rows to `runs` as
  `kind='tailor'`, then drop it. Idempotent.
- API in `src/db.ts`: `startRun`, `finishRun`, `getRun`, `runningRuns(kind)`.
  Existing rules stay: the same pid may re-claim (the TUI records the child's
  pid before it starts); a different live pid is refused.
- Crash handling: `finished_at IS NULL` with a dead pid is reported as failed,
  "process exited unexpectedly".
- Search summary message: "N found, M new", plus failed sources (e.g.
  "jsearch: 429").

## CLI changes

- `igor search`: with `--role`, the flags describe the whole search and the
  config is not read (today's behavior, `--location` optional). Without
  `--role`, the config supplies keywords and locations, and `--location`,
  `--remote`/`--onsite`, and `--clearance` override pieces of it. `--remote`
  with `--onsite` is an error. A missing config with no `--role` errors with a
  hint to run `igor init`.
- `igor search` registers itself in `runs` on start and records the outcome on
  finish, whether launched by the TUI or by hand, so manual runs show in the
  TUI.
- New: `igor init`, `igor config`, `--config <path>` on `search`, `tui`.
- `igor tailor` moves onto `runs`.

## TUI changes

- Ctrl+S runs `handleSearch`, modeled on `handleTailor`:
  - if a search is live, show "search already running";
  - else spawn a detached `igor search` with the TUI's `--db` and `--config`,
    call `startRun`, show a status message.
- The TUI never reads the config; the child does. A bad config surfaces as a
  failed run with the message, not a TUI crash.
- The existing poll timer watches `runs`: shows a "Searching..." indicator
  (persists across TUI restarts since state is in the db), and on finish
  reloads jobs and shows the summary or failure.
- Footer gains a `^S search` hint. Verify Ctrl+S does not clash with existing
  keys or terminal XOFF handling under Ink raw mode.

## Testing

- `config`: parse, validation errors, merge rules (scalar override, list
  replace), precedence, XDG path resolution with env overrides.
- `runs`: migration from `tailor_runs`, claim/finish, dead-pid detection,
  concurrent claim refusal (extends `tailorRuns.test.ts`).
- `search`: config-driven run, flag overrides, per-location `flexibility`
  filtering, run row written and finished.
- `init`: prompts and non-interactive flags against a temp XDG dir; refuses to
  overwrite without confirmation.
- TUI: `handleSearch` spawn and already-running guard (spawn injected).

## Rollout notes

- Last plan step, for the maintainer only: copy the main checkout's `igor.db`
  to the global DB path using `sqlite3 .backup` (WAL-safe). The original is
  left in place.
- README: config reference, `igor.example.toml`, layout and precedence.
