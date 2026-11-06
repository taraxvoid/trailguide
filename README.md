# trailguide

Job search and resume tailoring that only rearranges what you've already written.

trailguide searches company job boards (Greenhouse, Lever, Ashby, Workday, Workable) and
aggregators for the roles and places you configure, keeps what it finds in a
local SQLite database, and lets you browse, triage and apply from a terminal
UI. For each job it can also tailor your resume: a local model picks and
orders *which of your own bullets* to show, and a PDF comes out the other end.

Everything runs on your machine. Your resume never leaves it; the only network
traffic is requests to public job-board APIs (see [Network use](#network-use)).

## Why a model can't change your resume

Tailoring is built so the model has no way to write resume text. Your master
is parsed into small bullets with ids; the model only returns a list of ids in
the order it wants them, and anything it invents, misspells or repeats is
dropped. Contact details, employers, dates and education are copied through
verbatim. If Ollama or Typst is missing, or the model's answer is nonsense, you
still get your resume, untailored. See [docs/architecture.md](docs/architecture.md).

## Quick start

Requires [Bun](https://bun.sh) >= 1.4.0. If you use [mise](https://mise.jdx.dev),
`mise install` sets up Bun and the rest of the toolchain (Typst, just,
lefthook, gitleaks) at the pinned versions.

```bash
git clone https://github.com/taraxvoid/trailguide && cd trailguide
bun install
bun link          # puts `trailguide` on your PATH, pointing at this checkout
trailguide init         # asks for locations and keywords, writes your config
trailguide tui          # then press Ctrl+S to search
```

Without linking: `bun run src/cli.ts <command>`. Tailoring additionally needs
[Typst](https://typst.app) and [Ollama](https://ollama.com); see
[Tailoring your resume](#tailoring-your-resume).

Optional API credentials go in a `.env` file (copy `.env.example`):

- `JSEARCH_API_KEY`: [RapidAPI key for JSearch](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch), which searches Google for Jobs
- `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`: [Adzuna developer credentials](https://developer.adzuna.com/)
- `OLLAMA_HOST` / `OLLAMA_MODEL`: override the defaults used by `trailguide tailor`
- `TRAILGUIDE_DB` / `TRAILGUIDE_CONFIG`: override the database path and config file

Every other source needs no credentials.

## Configuration

`trailguide init` asks for locations and keywords (one per line; "Austin, TX" is one
location) and a work type, then writes `~/.config/trailguide/config.toml` and
creates `~/.local/share/trailguide/trailguide.db` (`XDG_CONFIG_HOME` / `XDG_DATA_HOME` are
honored). It never deletes anything, and asks before replacing an existing
config. Non-interactive:

```bash
trailguide init --location "Austin, TX" --keywords "software engineer" --work in-person
```

(each flag is repeatable; `--work "Austin, TX:in-person"` sets one location).
init groups the locations into one region per work type (`home` for
in-person, `remote`, `anywhere` for either).
[`trailguide.example.toml`](trailguide.example.toml) shows every section;
[`examples/bay-area.toml`](examples/bay-area.toml) is a complete Bay Area search
to copy and adapt.

Every keyword is searched in every place of every region, so at least one
`[region.<name>]` and one `[[keywords]]` entry are required.

A `./trailguide.toml` in the current directory is merged over the global config:
scalar keys override one by one, and lists (the regions, `[[keywords]]`,
`[[board]]`, `[filter] exclude`) replace the global ones. `[db] path =
"trailguide.db"` in a local file gives a self-contained sandbox (relative paths
resolve against that file's directory). `trailguide config` shows which files,
database and boards are in use.

Precedence, high to low: CLI flags, `TRAILGUIDE_*` environment variables, local
`trailguide.toml`, global `config.toml`, defaults. `--config <path>` (or
`TRAILGUIDE_CONFIG`) replaces the whole chain and uses only that one file.

### Regions

A region is a job market with its own places, work type and resume folder.
Each job is tagged with every region it matches, and the TUI shows one region
at a time:

```toml
[resume]
dir = "resumes"            # relative to this file; each region reads <dir>/<region name>/<trail>.md

[region.bay]
work = "in-person"
places = ["East Bay", "San Francisco", "San Jose, CA"]

[region.omaha]
work = "in-person"
places = ["Omaha metro"]
resumes = "resumes/omaha-v2"     # optional: overrides <dir>/omaha

[region.remote]
work = "remote"
places = ["United States"]
```

Regions keep the order they have in the file. `work` is one of:

- `remote`: listings marked remote whose location is blank, global
  ("Worldwide", "Anywhere"), or names the place. "United States" also
  matches USA, US, North America, and any US state or city ("Remote, Texas").
- `in-person` (onsite or hybrid): anything not marked remote, located in the
  place.
- `any` (default): either of the above.

Another name for a place is just another place in the list. "City, ST" also
matches the state spelled out.

"Bay Area", "East Bay", "South Bay", "Seattle" and "Omaha metro" are built-in
places covering their metro's main towns. They only match listings that name
the state ("Dublin, CA", not "Dublin, Ireland") or use a bare town name. Broad
places like "United States" with `in-person` or `any` only match listings
that name that place, so use specific cities for in-person work.

Only some sources say whether a job is remote, so `remote` is high precision
but limited recall: adzuna is skipped for remote locations, listings with no
remote label are missed, and hybrid is not told apart from onsite.

### Company job boards

The Greenhouse, Lever, Ashby, Workday and Workable boards of a built-in set of companies
are searched (see `seed/ats-companies.json`). Add your own with `[[board]]`
entries, taking the slug from the board's URL:

```toml
[[board]]
company = "Cadence"
ats = "workday"
slug = "cadence"      # https://cadence.wd1.myworkdayjobs.com/External_Careers
host = "wd1"          #          ^slug    ^host            ^site
site = "External_Careers"

[[board]]
company = "10x Genomics"
ats = "greenhouse"
slug = "10xgenomics"  # https://boards.greenhouse.io/10xgenomics

[[board]]
company = "Mission Bit"
ats = "workable"
slug = "missionbit"   # https://apply.workable.com/missionbit
```

[`examples/nonprofits.toml`](examples/nonprofits.toml) lists mission-driven
nonprofits whose boards trailguide can read.

`[sources] builtin_boards = false` searches only your own. A board that fails
(wrong slug, outage) is listed in the run summary and skipped; the rest are
still searched. Workday is searched once per keyword per company (up to 60
results each), and each matching posting is fetched for its description and
locations.

### Filters

Internship postings are always dropped. `[filter]` adds two optional settings:

```toml
[filter]
clearance = "exclude"            # drop listings that require a security clearance (default: include)
exclude = ["Some Staffing Co"]   # drop listings mentioning any of these
```

`exclude` terms match whole words, case-insensitively, in the company, title
and description. On the command line, `--exclude-clearance` and
`--include-clearance` override the config for one search.

## Usage

```bash
trailguide search [--role <query...>] [--region <name...>] [--location <place...>] [--remote|--onsite] [--exclude-clearance|--include-clearance] [--json] [--csv] [--db <path>] [--config <path>]
```

- no `--role`: the config's `[[keywords]]` and regions drive the search
- `--region`: search only these regions; accepts multiple values (default: every region)
- `--role`: search for exactly these roles instead (the config's keywords and locations are not used); accepts multiple values, e.g. `--role engineer manager`
- `--location`: replace the config's region places; accepts multiple values, e.g. `--location Austin "San Francisco"`
- `--remote` / `--onsite`: only remote / only not-remote jobs for every place (mutually exclusive)
- `--json` / `--csv`: print all jobs stored in the db
- `--db`: path to the sqlite db (default: the precedence chain above)
- `--config`: config file to use instead of the global plus local chain

Other commands: `trailguide tui`, `trailguide add`, `trailguide jobs`, `trailguide refresh`, `trailguide tailor`,
`trailguide trail`, `trailguide remove <listingId>` (delete one job), `trailguide region <listingId> [region...] [--clear]` (show, replace or clear a job's regions, e.g. one `add`ed into the wrong region), `trailguide clear`, `trailguide config`, `trailguide init`; `trailguide --help` lists them.

Every `trailguide search`, including one started by hand, registers itself as the
db's single search run: it shows in the TUI, and a second one started while
it runs exits with "search already running". Failed sources and boards are
listed in the run summary without failing the search.

## TUI

Browse stored jobs interactively:

```bash
trailguide tui [--db <path>] [--config <path>]
```

The header's left side lists your regions (in config order, the current one
highlighted, plus `unassigned` while some job matches none), then the
Active, Applied and Archived views with the current region's counts. A job in
two regions shows in both. The TUI reopens on the region you used last.

The right side shows the branch and last commit of the checkout that's running
(`*` = uncommitted changes). A global `trailguide` from `bun link` runs whichever
trailguide checkout (or worktree) you're currently inside, and the linked one
everywhere else. Set `TRAILGUIDE_NO_DELEGATE=1` to always run the linked one.

Anything that does something or changes state is a Ctrl chord; plain keys only move around or open things (case doesn't matter). The footer groups them, most used first.

Main actions:

- Ctrl+T: tailor your resume (the current region's master) to the selected job, or re-tailor, which regenerates its PDF if it already has one (see below)
- Ctrl+A: mark applied. The row stays in the list for a moment, marked "Moved to Applied", then leaves; press it again on an applied job to undo. On an archived job it toggles the applied mark without unarchiving

Job:

- o: open the listing URL in your browser
- y: copy the selected job's listing id (shown under its URL in the detail panel) to the clipboard, e.g. for `trailguide tailor <listingId>`
- v: view the job's tailored resume PDF
- Ctrl+X: archive
- Ctrl+L: cycle the job's resume trail (none, then each trail in the config)
- Ctrl+D / Delete: delete the selected job from the database (asks you to press again to confirm; any other key cancels). Tailored files on disk are kept

Find:

- Ctrl+S: search the current region in the background. It keeps running if you quit or restart the TUI; the header shows `Searching...`, the list reloads when it finishes, and output goes to `trailguide-search.log` next to the db
- Ctrl+N: import a job from a link: paste it, pick a trail (see [Importing a job from a link](#importing-a-job-from-a-link)). Not Ctrl+I, which terminals send as Tab
- Ctrl+R: refresh (checks whether active listings are still live)
- /: filter the list as you type. Matches title, company, location, trail, URL and description, case-insensitively; every space-separated word must appear. ↑↓ move through matches while typing, ↵ keeps the filter (shown on the separator line, across regions and views), Esc clears it

View and move:

- Tab: switch between the Active and Applied views. Active is grouped into one section per configured trail, then "Not on a trail (for now)"; with no trails configured it is a single flat list. Applied lists tailored jobs first
- Ctrl+E: view the archive; press it again to go back
- h / l or ←→: switch region; 1-9 jumps to region N
- ↑↓ / k j: move through the job list; PgUp / PgDn page
- ↵: expand/collapse the selected job's description
- q / esc: quit (esc clears an applied filter first)

Results are deduped across sources and persisted to the sqlite db, so
repeated searches only flag what's `NEW`.

## Tailoring your resume

`trailguide tailor <listingId>` (or Ctrl+T in the TUI) reorders your resume's
Highlights, each job's accomplishment bullets, and your Skills section to
foreground whatever's most relevant to a specific listing, then renders a
PDF. It never invents, rewrites, or drops factual content: a local model only
ever picks and orders *which of your own bullets* to show; everything else
(your contact info, employer names/dates/titles, education, certifications,
...) is reproduced exactly as written.

A Skills section is keyword stuffing rather than a set of claims, so it gets
treated a little differently: its sub-groups ("Technical", "Cyber
Security", ...) are reordered so the ones a posting cares about lead, and
individual skill lines a posting has no use for are pruned. The groups
themselves are only ever reordered, never dropped.

Setup:

1. Put your resume master in `~/.config/trailguide/resumes/<name>.md` (or the
   `[resume] dir` from your config; it's your personal resume, so keep it
   out of this repo). It needs a `## Highlights` section
   and a `## Career Experience` section with each employer's bullets for
   tailoring to have anything to work with. A section whose heading mentions
   skills, technologies, or competencies is tailored too. Other sections and
   their formatting are free-form and always passed through unchanged.
2. Install [Typst](https://typst.app), used to render the PDF. The version
   is pinned in `mise.toml` - with [mise](https://mise.jdx.dev) installed
   run `mise install` from the repo. (or [get typst another way](https://github.com/typst/typst#installation)) and
3. Install [Ollama](https://ollama.com) and pull a thinking-capable model
   (the default is `qwen3:8b`, a good fit for 16GB of RAM):
   ```bash
   ollama pull qwen3:8b
   ```

```bash
trailguide tailor <listingId> [--db <path>] [--config <path>] [--region <name>] [--resume <path>] [--output-dir <path>] [--ollama-host <host>] [--ollama-model <model>] [--fresh]
```

Output goes to `~/.local/share/trailguide/resumes/<company>-<title>.md` and `.pdf`
(`--output-dir` to change it). If Ollama or the resume's Highlights section
isn't available, or the model's response doesn't make sense, tailoring is
skipped with a warning and the resume is still rendered unmodified: you always
get a usable PDF out of this, never nothing and never garbage.

The tailored `.md` is then the canonical resume for that job: trailguide records
which file belongs to which listing, so you can edit it by hand and run
`trailguide tailor <listingId>` (or `T`) again to regenerate the PDF from your
edits. That skips the model and the master entirely. To start over from the
master, delete the `.md` or pass `--fresh` (which overwrites it). If two
listings share a company and title, the second gets its listing id appended
to the filename so neither overwrites the other's edits.

### Trails: one master per kind of role

To pitch different roles from different masters, give a `[[keywords]]` entry
a `trail`:

```toml
[[keywords]]
role = "Security Platform Engineer"
trail = "secplat"        # tailors from <region resume folder>/secplat.md
```

Search records the trail of the keyword that found each job. For sources
searched with every keyword at once, it's the first keyword (in config
order) the job title contains. Tailoring then picks, in order: `--resume`,
the job's `<trail>.md` (an error if missing), `default.md`, or the only `.md`
in the dir. It never guesses between masters. Change a job's trail with Ctrl+L
in the TUI or `trailguide trail <listingId> [trail] [--clear]`.

With regions, each region has its own folder of masters
(`<resume dir>/<region name>/`, or the region's `resumes`), so the Omaha and
Bay Area versions of `secplat.md` can say different things. Ctrl+T in the TUI
tailors with the region you are looking at; `trailguide tailor` uses
`--region`, else the job's first region in config order. The tailored resume
remembers which region's master it came from (shown in the TUI's detail
panel) and keeps it when regenerated from your edits.

### Importing a job from a link

A job that search wouldn't find (a link someone sent, a board you don't
watch, a title your keywords don't match) can be added by hand:

```bash
trailguide add https://job-boards.greenhouse.io/codeorg/jobs/4727981005 --trail platform
```

or Ctrl+N in the TUI. Search filters don't apply: the job goes in because you
picked it. Greenhouse, Lever, Ashby, Workable and Workday links are read
through the board's API, and get the same listing id search would give
them, so a later search finds the same row. Any other link is read from the
schema.org `JobPosting` data most careers pages embed; a page without it
can't be imported.

`--trail` takes a configured trail or `none`. In a terminal, leaving it out
asks; in a script it's required. Adding a job that's already tracked
refreshes its details and sets the trail you chose, keeping its state and
applied date. The job joins every region its location matches; if none
does, it goes in `--region`; without that, a terminal asks which region (or
`none`) and a script leaves it in no region (`unassigned`).

## Network use

trailguide only talks to the public job-board APIs of the sources it searches
(and, for `trailguide add` with a link that isn't a job board's, that one
page), and tries to be a polite client: every request sends `User-Agent: trailguide/<version>
(+https://github.com/taraxvoid/trailguide)`, times out after 20 seconds, and runs
under small concurrency limits (4 boards at a time per source, 8 link checks).
Searches run when you ask for them, not on a timer. Please keep it that way
if you script it.

## Development

`mise install` provides the tools below (see `mise.toml`).

```bash
mise install          # typst, lefthook, gitleaks, jactionlint, shellcheck (pinned in mise.toml)
bun install           # also installs the git hooks (lefthook.yml)

bun run lint          # biome
bun run lint:secrets  # gitleaks over the git history
bun run check         # tsc --noEmit
bun run test          # bun test
bun run validate      # lint + check + test
bun run smoke-live    # hits real third-party APIs; skips sources with no credentials set
```

Pre-commit runs typecheck and the test suite minus the slow files
(`test:unit:precommit`); pre-push runs the full suite. The hooks come from
[voidflow](https://github.com/taraxvoid/voidflow)'s shared lefthook set plus
`lefthook.yml`.

[docs/architecture.md](docs/architecture.md) explains how the pieces fit.

## License

MIT
