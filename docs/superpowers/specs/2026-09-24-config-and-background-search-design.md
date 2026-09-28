# TOML config, global/local layout, and background search

Date: 2026-09-24 (revised 2026-09-28 after review against the code)

## Goal

Make igor usable as an open-source tool and make the TUI a thin wrapper over
async work:

1. A TOML config describes what to search for.
2. Config and DB live in global (XDG) locations, with a local override.
3. `igor init` bootstraps a fresh install.
4. Ctrl+S in the TUI starts a detached `igor search` process that survives
   closing or restarting the TUI. The TUI launches and observes; it does not
   own the operation.

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
region = ["Nebraska"]     # optional; extra terms a remote listing may match

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
- `flexibility` is `remote`, `in-person` (docs and prompts say "onsite or
  hybrid"), or `any`. Exact matching rules are in "Work type and location
  matching" below.
- The CLI flags `--remote` / `--onsite` remain and apply to every `--location`
  given on the command line. `--onsite` keeps its current meaning (not remote).

### Parsing and validation (`src/config.ts`)

- Parse with `smol-toml` (new dependency, zero transitive deps). It is TOML
  1.0 compliant, throws `TomlError` with line and column, and provides
  `stringify`, which `igor init` uses to write the file. `Bun.TOML.parse` is
  not used: it has no stringify and no positional errors. A syntax error is
  reported as `<file>:<line>:<col>: <message>`.
- Validation is a small hand-written checker over the parsed object (no
  schema library; the shape is three tables). It rejects unknown keys and
  wrong types, and produces the field-level messages above.
- Exports: `loadConfig`, `mergeConfigs`, `toSearchOptions`, `writeConfig`.

## Work type and location matching

One central predicate, in `src/sources/location.ts`, decides whether a job
satisfies a (city, flexibility) pair. Sources stop making this decision.

### What each source tells us about remote

`remoteType` is a positive-only signal: `remote` is trustworthy, `unknown`
means "no signal", not "onsite".

| Source | remoteType |
| --- | --- |
| remoteok, remotive, weworkremotely | always `remote` (site definition) |
| ashby, lever | from `workplaceType` (best signal; lever `unknown` if absent, ashby falls back to `isRemote`) |
| greenhouse | `remote` if location text contains "remote", else `unknown` |
| jsearch | `remote` if `job_is_remote`, else `unknown` |
| adzuna | always `unknown` |
| jobaps | always `onsite` |

One central normalization is added: a job with `remoteType == "unknown"`
whose location text contains the word "remote" becomes `remote` (greenhouse
does this today for its own jobs; it moves to a shared step so it also covers
lever, adzuna, and jsearch). No other free-text inference: hybrid versus onsite
is still not detected beyond what ashby and lever report.

### The predicate

```
matches(job, { city, flexibility }):
  if job.remoteType == "remote":
    flexibility != "in-person" and remoteEligible(job.location, city)
  else:
    flexibility != "remote"    and cityMatches(job.location, city)
```

- No `city` (flag-only search without `--location`) means both location
  checks pass, as today.
- `cityMatches` is `matchesLocation` (metro aliases included).
- `remoteEligible` is true when the listing location is blank or a bare
  global term ("remote", "worldwide", "anywhere", "global", "international"),
  or when `matchesLocation` matches the city or any of the entry's optional
  `region` terms (a string or list of strings; only used for remote
  eligibility, never for onsite matching), each extended with aliases.
  Alias table: "united states" = usa, u.s., us, north america, americas;
  "omaha" (metro) additionally gets "nebraska". Other cities get state-level
  eligibility by setting `region` (e.g. `region = ["Texas", "TX"]`); there is
  no built-in city-to-state data. A listing like "Remote - Europe" is not
  eligible for "United States". `igor init` does not prompt for `region`.
- Consequence for `remote` mode: high precision, limited recall. Remote jobs
  from adzuna, or lever and greenhouse listings that never say "remote" in
  structured data, are missed.
- Consequence for `in-person` mode: `unknown` jobs are included, which could
  admit unlabeled remote jobs, but the city gate keeps that small (an unlabeled
  remote job located "United States" does not match "Omaha").
- Broad regions with `in-person` or `any` match only listings whose text names
  the region ("San Francisco, CA" does not match "United States"). `igor init`
  and the README say to use specific cities for in-person work.

### `matchesLocation` fixes

- Match on word boundaries instead of `includes`, so the alias "us" does not
  match "Houston" or "Australia".
- Region and metro alias tables live next to it.

### Scoped versus unscoped sources

- Scoped sources apply the location inside the API query: jsearch and adzuna.
  The runner passes them the city (and `remote` for jsearch when flexibility
  is `remote`) and trusts the result, so for their jobs only the work-type
  half of the predicate applies (city and region checks are skipped).
- Unscoped sources return everything for the role: greenhouse, lever, ashby,
  remoteok, remotive, weworkremotely, jobaps. The runner calls them with no
  `location`, so their existing internal location filters do nothing, and the
  predicate runs centrally against every location entry.

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
- DB path: `--db`, then `IGOR_DB`, then `[db] path`, then the global default.
  There is no legacy `./igor.db` fallback (hard switch).
- The commander `--db` option currently defaults to `"igor.db"` on every
  command that takes it (`search`, `tui`, `tailor`, and the rest). Those
  defaults are removed so the precedence chain can run; a shared resolver
  supplies the path instead.
- `igor config` prints resolved paths and the merged config.
- The config is read when a search starts, never cached.

## `igor init`

Creates the global DB and writes the global `config.toml`. Prompts:

1. Location(s), one per line (blank line ends input). Commas are not
   separators, since "Omaha, NE" is one place.
2. Keyword(s), one per line, e.g. "software engineer", "devops engineer".
3. Work type per location: remote, in-person (onsite or hybrid), or either.
   The prompt offers "same for all" as the first answer, so a single reply
   covers every location; otherwise it asks per location. Mixed setups are
   also editable in the file afterward.

Never deletes anything. An existing DB is kept as is (opening creates tables
only if missing). If the global config already exists, init asks before
overwriting it and does nothing if declined; `--yes` answers that question.
Non-interactive: repeatable `--location`, repeatable `--keywords`, and
`--work` (applies to all given locations, or `city:flexibility` per
`--location`) skip their prompts. Prints resolved paths and next steps
(`igor tui`, Ctrl+S).

## Runs table (replaces `tailor_runs`)

```
runs(kind TEXT, key TEXT, pid INTEGER, started_at, finished_at, ok, message,
     PRIMARY KEY (kind, key))
```

- Latest run per (kind, key), as `tailor_runs` does today.
- `kind='tailor'`, `key=<listingId>`; `kind='search'`, `key='search'`
  (one search at a time per DB).
- Migration in `openDb`: if `tailor_runs` exists, in one transaction copy rows
  to `runs` as `kind='tailor'` (`INSERT OR IGNORE`), then drop it. Idempotent.
- API in `src/db.ts`: `startRun`, `finishRun`, `getRun`, `runningRuns(kind)`.
  Existing rules stay: the same pid may re-claim (the TUI records the child's
  pid before it starts); a different live pid is refused.
- Crash handling lives in one place (`runningRuns`): `finished_at IS NULL`
  with a dead pid is closed out as failed with "<kind> process exited
  unexpectedly". `runningTailorIds` is reimplemented on top of it.
- Search summary message: "N found, M new", plus failed sources (e.g.
  "jsearch: 429"). It comes from the return value of `runSearch` (below), not
  from parsing logs.

## Search execution (`runSearch`)

`runSearch` is refactored to return a result instead of only printing:
`{ found, new, failures: { source, message }[] }`. `console.error` for failed
sources stays for interactive use, but the run message is built from the
returned failures.

- Filtering is per combination. Each (keyword, location) pair is searched and
  filtered with that location's `flexibility` (plus `govmil`, internship, and
  dead-URL checks) before the results are merged and deduped. A remote job
  found via "United States" is therefore not dropped by Omaha's `in-person`
  rule, and the reverse. With flags only (`--role`), there is one implicit
  combination and behavior is as today.
- Source calls follow the scoped/unscoped split above. Unscoped sources run
  once per keyword (no location passed), and their results are evaluated
  against every location's predicate. Scoped sources (jsearch, adzuna) run once
  per combination, and are the only ones that cost quota per location. Each
  source declares `scoped: boolean`.
- A source failing does not fail the run; it is recorded in `failures`. The run
  is `ok = false` only when the run itself throws (bad config, DB error) or
  every source fails.

## CLI changes

- `igor search`: with `--role`, the flags describe the whole search and the
  config is not read (today's behavior, `--location` optional). Without
  `--role`, the config supplies keywords and locations, and `--location`,
  `--remote`/`--onsite`, and `--clearance` override pieces of it. `--remote`
  with `--onsite` is an error. A missing config with no `--role` errors with a
  hint to run `igor init`.
- `igor search` registers itself in `runs` (`kind='search'`) on start and
  records the outcome on finish, for every invocation including flag-only
  manual runs, since they write to the same DB. If a search is already live,
  a new one exits with "search already running" and a nonzero status. Manual
  runs therefore also show in the TUI.
- New: `igor init`, `igor config`, `--config <path>` on `search`, `tui`.
- `igor tailor` moves onto `runs`.

## TUI changes

- Ctrl+S runs `handleSearch`, modeled on `handleTailor`:
  - if a search is live, show "search already running";
  - else spawn a detached `igor search` and call `startRun`, show a status
    message.
- The TUI resolves paths only (the config chain, `IGOR_*`, flags), which it
  needs to open the right DB. It does not read the search settings
  (keywords, locations, `govmil`); the child does. The child is spawned with
  fully resolved absolute `--db` and `--config` values and the TUI's cwd, so a
  local `./igor.toml` resolves identically in both processes. A bad config
  surfaces as a failed run with the message, not a TUI crash.
- The child's stdout and stderr go to a log file next to the DB
  (`igor-search.log`, truncated per run), so a crash leaves a trace. The run
  message points at the log path on unexpected failure.
- The existing poll timer watches `runs`: shows a "Searching..." indicator
  (persists across TUI restarts since state is in the db), and on finish
  reloads jobs and shows the summary or failure.
- Footer gains a `^S search` hint. Ctrl+S is unbound in `App.tsx` (Ctrl+R, E,
  O, T are taken), and Ink raw mode disables XOFF flow control. Do a manual
  check in tmux and Terminal.app rather than a design change.

## Testing

- `config`: parse (including `TomlError` line/column reporting), validation
  errors (unknown keys, wrong types, missing fields), merge rules (scalar
  override, list replace), precedence, XDG path resolution with env overrides,
  relative `[db] path` resolution, `writeConfig` round trip.
- `runs`: migration from `tailor_runs` (including a rerun), claim/finish,
  dead-pid detection per kind, concurrent claim refusal (extends
  `tailorRuns.test.ts`).
- `location`/predicate: table-driven cases for each (remoteType, flexibility)
  pair; "USA Only", "Worldwide", blank, bare "Remote", and "Remote - Europe"
  against city "United States"; "Houston" and "Australia" do not match "us";
  Omaha metro aliases; "Remote - Nebraska" eligible for Omaha via the alias and
  via `region`, not via onsite matching; unknown plus "remote" in location text normalizes to
  remote; scoped-source jobs skip city and region checks.
- `search`: config-driven run, flag overrides, per-location `flexibility`
  filtering with one `in-person` and one `remote` location in the same run,
  location-independent sources called once per keyword, summary and failures
  returned, run row written and finished, flag-only run claims the search key
  and a second concurrent run is refused.
- `init`: prompts and non-interactive flags against a temp XDG dir; "Omaha, NE"
  stays one location; refuses to overwrite without confirmation.
- TUI: `handleSearch` spawn and already-running guard (spawn injected), spawn
  receives absolute `--db` and `--config`.

## Rollout notes

- Last plan step, for the maintainer only: copy the main checkout's `igor.db`
  to the global DB path using `sqlite3 .backup` (WAL-safe). The original is
  left in place.
- README: config reference, `igor.example.toml`, layout and precedence.
- Implementation order: config and DB path resolution (including removing the
  `--db` defaults), then `runs`, then the `runSearch` refactor, then `init`,
  the TUI, and the rollout copy.
