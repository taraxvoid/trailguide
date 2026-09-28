# igor

a minion to find and apply for jorbs

## Requirements

- [Bun](https://bun.sh) >= 1.4.0

## Setup

```bash
bun install
```

Optional API credentials go in a `.env` file (copy `.env.example`):

```bash
cp .env.example .env
```

- `JSEARCH_API_KEY` — [RapidAPI key for JSearch](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch)
- `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` — [Adzuna developer credentials](https://developer.adzuna.com/)
- `OLLAMA_HOST` / `OLLAMA_MODEL` — only needed if you want to override the defaults for `igor tailor` (see below)
- `IGOR_DB` / `IGOR_CONFIG`: optional overrides for the db path and config file (see Configuration below)

Other sources don't require creds

## Running `igor` on your PATH

`igor` is defined as a `bin` in `package.json`, pointing at `src/cli.ts`. To
run your local checkout as a global `igor` command:

```bash
bun link
```

This adds `igor` to your PATH (via Bun's global bin dir) and points it at
this working copy — edits to `src/` take effect immediately, no rebuild step.
Verify it resolves:

```bash
igor --help
```

To remove the link later:

```bash
bun unlink
```

Alternatively, without linking, run it directly from the repo:

```bash
bun run src/cli.ts search --role "software engineer"
```

## Configuration

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

Every keyword is searched in every location, so at least one `[[location]]`
and one `[[keywords]]` entry are required.

A `./igor.toml` in the current directory is merged over the global config:
`[job]` keys override one by one, and `[[location]]` / `[[keywords]]` replace
the global lists. `[db] path = "igor.db"` in a local file gives a
self-contained sandbox (relative paths resolve against that file's
directory). `igor config` shows which files and database are in use.

Precedence, high to low: CLI flags, `IGOR_*` environment variables
(`IGOR_DB`, `IGOR_CONFIG`), local `igor.toml`, global `config.toml`,
defaults. `--config <path>` (or `IGOR_CONFIG`) replaces the whole chain and
uses only that one file. There is no fallback to a `./igor.db` in the
current directory: if you have an old database there, move it to the path
`igor config` reports.

`flexibility` per `[[location]]`:

- `remote`: listings marked remote whose location is blank, global
  ("Worldwide", "Anywhere"), or names the place. "United States" also
  matches USA, US, and North America; Omaha also matches Nebraska.
- `in-person` (onsite or hybrid): anything not marked remote, located in the
  city (Omaha includes La Vista, Elkhorn, and Ralston).
- `any` (default): either of the above.

`region` is optional and only extends which remote listings are eligible for
a city, e.g. `region = ["Texas", "TX"]` for a Texas city. Omaha gets Nebraska
built in. Broad places like "United States" with `in-person` or `any` only
match listings that name that place, so use specific cities for in-person
work.

Only some sources say whether a job is remote, so `remote` is high
precision but limited recall: adzuna and listings with no remote label are
missed, and hybrid is not told apart from onsite.

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

## TUI

Browse stored jobs interactively:

```bash
igor tui [--db <path>] [--config <path>]
```

The header shows the branch and last commit of the checkout that's running
(`*` = uncommitted changes). A global `igor` from `bun link` runs whichever
igor checkout (or worktree) you're currently inside, and the linked one
everywhere else. Set `IGOR_NO_DELEGATE=1` to always run the linked one.

- ↑↓ / k j — navigate job list
- ←→ / h l — switch between Active / Applied / Archived tabs
- ↵ — expand/collapse the selected job's description
- o — open the listing URL in your browser
- ⌃s: search in the background with your config. It keeps running if you quit or restart the TUI; the header shows `Searching...`, the list reloads when it finishes, and output goes to `igor-search.log` next to the db
- ⌃t — tailor your resume to the selected job, or regenerate its PDF if it already has one (see below)
- e — archive
- a — mark applied
- ⌃r — refresh (checks whether active listings are still live)
- q / esc — quit

Internship postings are always filtered out. Results are deduped across
sources and persisted to the sqlite db so repeated searches only flag what's
`NEW`.

## Tailoring your resume

`igor tailor <listingId>` (or ⌃t in the TUI) reorders your resume's
Highlights, each job's accomplishment bullets, and your Skills section to
foreground whatever's most relevant to a specific listing, then renders a
PDF. It never invents, rewrites, or drops factual content — a local model
only ever picks and orders *which of your own bullets* to show; everything
else (your contact info, employer names/dates/titles, education,
certifications, ...) is reproduced exactly as written.

A Skills section is keyword stuffing rather than a set of claims, so it gets
treated a little differently: its sub-groups ("Technical", "Cyber
Security", ...) are reordered so the ones a posting cares about lead, and
individual skill lines a posting has no use for are pruned — a gig that
never mentions the cloud doesn't need to read your cloud-hosting line. The
groups themselves are only ever reordered, never dropped.

Setup:

1. Put your resume master in `input/<name>.md` (gitignored - this is your
   personal resume, not project source). It needs a `## Highlights` section
   and a `## Career Experience` section with each employer's bullets for
   tailoring to have anything to work with. A section whose heading mentions
   skills, technologies, or competencies is tailored too. Other sections and
   their formatting are free-form and always passed through unchanged.
2. Install [Typst](https://typst.app) (`brew install typst` or see
   [installation docs](https://github.com/typst/typst#installation)) - used
   to render the PDF.
3. Install [Ollama](https://ollama.com) and pull a thinking-capable model
   (the default is `qwen3:8b`, a good fit for 16GB of RAM):
   ```bash
   ollama pull qwen3:8b
   ```

```bash
igor tailor <listingId> [--db <path>] [--resume <path>] [--output-dir <path>] [--ollama-host <host>] [--ollama-model <model>] [--fresh]
```

Output goes to `output/resumes/<company>-<title>.md` and `.pdf` (also
gitignored). If Ollama or the resume's Highlights section isn't available,
or the model's response doesn't make sense, tailoring is skipped with a
warning and the resume is still rendered unmodified - you always get a
usable PDF out of this, never nothing and never garbage.

The tailored `.md` is then the canonical resume for that job: igor records
which file belongs to which listing, so you can edit it by hand and run
`igor tailor <listingId>` (or ⌃t) again to regenerate the PDF from your
edits. That skips the model and the master entirely. To start over from the
master, delete the `.md` or pass `--fresh` (which overwrites it). If two
listings share a company and title, the second gets its listing id appended
to the filename so neither overwrites the other's edits.

Example:

```bash
igor search --role "backend engineer" --location remote --remote
```

## Development

```bash
just lint      # biome + gitleaks
just typecheck # tsc --noEmit
just test      # bun test
just check     # lint + typecheck + test
just smoke-live  # hits real third-party APIs; skips sources with no credentials set
```
