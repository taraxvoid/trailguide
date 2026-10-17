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

Requires [Bun](https://bun.sh) >= 1.4.0.

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
[`trailguide.example.toml`](trailguide.example.toml) shows every section.

Every keyword is searched in every location, so at least one `[[location]]`
and one `[[keywords]]` entry are required.

A `./trailguide.toml` in the current directory is merged over the global config:
scalar keys override one by one, and lists (`[[location]]`, `[[keywords]]`,
`[[board]]`, `[filter] exclude`) replace the global ones. `[db] path =
"trailguide.db"` in a local file gives a self-contained sandbox (relative paths
resolve against that file's directory). `trailguide config` shows which files,
database and boards are in use.

Precedence, high to low: CLI flags, `TRAILGUIDE_*` environment variables, local
`trailguide.toml`, global `config.toml`, defaults. `--config <path>` (or
`TRAILGUIDE_CONFIG`) replaces the whole chain and uses only that one file.

### Locations

`flexibility` per `[[location]]`:

- `remote`: listings marked remote whose location is blank, global
  ("Worldwide", "Anywhere"), or names the place. "United States" also
  matches USA, US, and North America.
- `in-person` (onsite or hybrid): anything not marked remote, located in the
  city.
- `any` (default): either of the above.

`aliases` lists other names for the same place and counts everywhere:
`aliases = ["La Vista", "Elkhorn"]` on "Omaha". `region` only extends which
remote listings are eligible for the city, e.g. `region = ["Texas", "TX"]`.
"City, ST" also matches the state spelled out.

"Bay Area", "East Bay", "South Bay" and "Seattle" are built-in regions
covering their metro's main towns. A region only matches listings that name
its state ("Dublin, CA", not "Dublin, Ireland") or use a bare town name. Broad
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
trailguide search [--role <query...>] [--location <place...>] [--remote|--onsite] [--exclude-clearance|--include-clearance] [--json] [--csv] [--db <path>] [--config <path>]
```

- no `--role`: the config's `[[keywords]]` and `[[location]]` entries drive the search
- `--role`: search for exactly these roles instead (the config's keywords and locations are not used); accepts multiple values, e.g. `--role engineer manager`
- `--location`: replace the config's locations; accepts multiple values, e.g. `--location Austin "San Francisco"`
- `--remote` / `--onsite`: only remote / only not-remote jobs for every location (mutually exclusive)
- `--json` / `--csv`: print all jobs stored in the db
- `--db`: path to the sqlite db (default: the precedence chain above)
- `--config`: config file to use instead of the global plus local chain

Other commands: `trailguide tui`, `trailguide jobs`, `trailguide refresh`, `trailguide tailor`,
`trailguide trail`, `trailguide clear`, `trailguide config`, `trailguide init`; `trailguide --help` lists them.

Every `trailguide search`, including one started by hand, registers itself as the
db's single search run: it shows in the TUI, and a second one started while
it runs exits with "search already running". Failed sources and boards are
listed in the run summary without failing the search.

## TUI

Browse stored jobs interactively:

```bash
trailguide tui [--db <path>] [--config <path>]
```

The header shows the branch and last commit of the checkout that's running
(`*` = uncommitted changes). A global `trailguide` from `bun link` runs whichever
trailguide checkout (or worktree) you're currently inside, and the linked one
everywhere else. Set `TRAILGUIDE_NO_DELEGATE=1` to always run the linked one.

Lowercase keys navigate; capital letters act (the capital in each footer label is its shortcut):

- ↑↓ / k j: navigate job list
- ←→ / h l: page up/down
- Tab: switch between the Active and Archived views (the footer names where it will take you). The Active view is grouped into Applied, then one section per configured trail, then "Not on a trail (for now)"; with no trails configured it is a single flat list
- ↵: expand/collapse the selected job's description
- O: open the listing URL in your browser
- S: search in the background with your config. It keeps running if you quit or restart the TUI; the header shows `Searching...`, the list reloads when it finishes, and output goes to `trailguide-search.log` next to the db
- T: tailor your resume to the selected job, or (re)tailor, which regenerates its PDF if it already has one (see below)
- V: view the job's tailored resume PDF
- E: archive
- A: mark applied
- L: cycle the job's resume trail (none, then each trail in the config)
- R: refresh (checks whether active listings are still live)
- q / esc: quit

Results are deduped across sources and persisted to the sqlite db, so
repeated searches only flag what's `NEW`.

## Tailoring your resume

`trailguide tailor <listingId>` (or `T` in the TUI) reorders your resume's
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
<<<<<<< HEAD
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
trailguide tailor <listingId> [--db <path>] [--config <path>] [--resume <path>] [--output-dir <path>] [--ollama-host <host>] [--ollama-model <model>] [--fresh]
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
trail = "secplat"        # tailors from <resume dir>/secplat.md
```

Search records the trail of the keyword that found each job. For sources
searched with every keyword at once, it's the first keyword (in config
order) the job title contains. Tailoring then picks, in order: `--resume`,
the job's `<trail>.md` (an error if missing), `default.md`, or the only `.md`
in the dir. It never guesses between masters. Change a job's trail with `L`
in the TUI or `trailguide trail <listingId> [trail] [--clear]`.

## Network use

trailguide only talks to the public job-board APIs of the sources it searches, and
tries to be a polite client: every request sends `User-Agent: trailguide/<version>
(+https://github.com/taraxvoid/trailguide)`, times out after 20 seconds, and runs
under small concurrency limits (4 boards at a time per source, 8 link checks).
Searches run when you ask for them, not on a timer. Please keep it that way
if you script it.

## Development

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
