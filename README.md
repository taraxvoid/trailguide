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

## Usage

```bash
igor search --role <query...> [--location <city...>] [--remote remote|hybrid|onsite] [--clearance] [--json] [--csv] [--db <path>]
```

- `--role` (required) — title/keyword to search for; accepts multiple values, e.g. `--role engineer manager`
- `--location` — filter by location text; accepts multiple values, e.g. `--location Omaha "San Francisco"`
- `--remote` — one of `remote`, `hybrid`, `onsite`
- `--clearance` — include jobs that mention a clearance requirement (excluded by default)
- `--json` — print all jobs currently stored in the db as JSON
- `--csv` — print all jobs currently stored in the db as CSV
- `--db` — path to the sqlite db (default `igor.db`)

## TUI

Browse stored jobs interactively:

```bash
igor tui [--db <path>]
```

The header shows the branch and last commit of the checkout that's running
(`*` = uncommitted changes). A global `igor` from `bun link` always runs the
linked checkout, whatever directory you start it in - to try a branch or
worktree, run `bun run tui` from inside it instead.

- ↑↓ / k j — navigate job list
- ←→ / h l — switch between Active / Applied / Archived tabs
- ↵ — expand/collapse the selected job's description
- o — open the listing URL in your browser
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
igor search --role "backend engineer" --location remote --remote remote
```

## Development

```bash
just lint      # biome + gitleaks
just typecheck # tsc --noEmit
just test      # bun test
just check     # lint + typecheck + test
just smoke-live  # hits real third-party APIs; skips sources with no credentials set
```
