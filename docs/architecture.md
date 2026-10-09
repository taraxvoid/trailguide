# How trailguide works

trailguide searches company job boards and aggregators, stores what it finds in a
local SQLite database, and tailors a resume to a listing without ever writing
new resume text. Everything runs on your machine; the only network traffic is
requests to public job-board APIs.

```
config chain ──► SearchPlan ──► sources ──► collectJobs ──► dedupe/filter ──► upsertJobs ──► SQLite
 (flags, env,     keywords ×      (one per      match work     internships,      listings,         ▲
  local, global)  locations       board/API)    type + place   clearance,        runs, tailored    │
                                                                custom terms      resumes          TUI / CLI
```

## Search

- **Config** (`src/config.ts`) is layered: CLI flags, `TRAILGUIDE_*` environment
  variables, a local `trailguide.toml`, the global `~/.config/trailguide/config.toml`.
  Scalars override per key and lists replace wholesale. Parsing is strict:
  unknown keys and wrong types are errors that name the file and the entry.
  `toSearchOptions` turns it into a `SearchPlan` (keywords, locations, filters).
- **Sources** (`src/sources/*`) implement one interface:
  `search(params) → NormalizedJob[]`. Company-board sources (Greenhouse,
  Lever, Ashby, Workday) take their boards from the built-in seed list plus
  `[[board]]` entries and run four boards at a time; a board that fails is
  reported and skipped. Aggregators (JSearch, Adzuna) are scoped by location
  inside their query; the rest are called once with every keyword.
- **`collectJobs`** (`src/search.ts`) runs every source, then decides what
  stays. One predicate, `matches`, answers "does this job satisfy this
  (place, remote | in-person | any) target?"; place matching is word-boundary
  based, understands regions and aliases, and never lets "Dublin, Ireland"
  satisfy "Dublin, CA". Then it dedupes across sources, drops internships,
  applies `[filter]`, and strips tracking parameters.
- **Storage** (`src/db.ts`): `upsertJobs` keeps one row per listing, so
  repeated searches only flag what is new. Dead links are checked eight at a
  time with a timeout; a slow host is not a dead listing.
- **Runs** are rows in a `runs` table keyed by (kind, key). Claiming a run is
  one `IMMEDIATE` transaction, so two processes cannot both start the same
  search or tailor. A run whose process died is closed out as failed, guarded
  on the observed pid so a fresh claim is never clobbered. This is how the TUI
  starts a detached search, shows its progress, and picks it back up after a
  restart.

## Tailoring

`trailguide tailor` is built so that the model cannot change what your resume says.

1. `parseResume` splits the master into small, id-addressed pieces (highlight
   bullets, each employer's bullets, skill lines). Everything else, including
   contact details, employers, dates and education, is kept as opaque text.
2. A local model (Ollama) is shown the listing and the ids and returns a plan:
   which ids to show, in what order.
3. `sanitizePlan` drops every id that is invented, misspelled or duplicated,
   and anything the model leaves out keeps its original order. Employers and
   skill groups are never dropped, only reordered. `applyPlan` can only select
   and reorder.
4. The result is written as markdown, which is then the canonical copy for
   that job (hand edits survive), and rendered to PDF with Typst.

If Ollama, the model or Typst is missing, or the plan is nonsense, you still
get the untailored resume rather than an error or garbage. A resume master is
chosen per listing from its *trail* (`<trail>.md`), never guessed.

## Layout

| path | what |
|---|---|
| `src/cli.ts` | commands (commander), `runSearch`, `runTailor`, `runTrail` |
| `src/config.ts`, `src/paths.ts` | config parsing, merging, XDG paths |
| `src/search.ts` | collecting, matching and filtering jobs |
| `src/sources/` | one file per job source, plus location matching |
| `src/db.ts` | schema, migrations, listings, runs |
| `src/tailor/` | resume parsing, plan, Ollama client, Typst rendering |
| `src/tui/` | the Ink terminal UI |
| `seed/ats-companies.json` | the built-in company boards |
