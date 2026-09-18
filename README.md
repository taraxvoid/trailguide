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

Greenhouse, Lever, and Ashby sources work with no credentials.

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

- ↑↓ — navigate job list
- ↵ — quit
- q — quit

Internship postings are always filtered out. Results are deduped across
sources and persisted to the sqlite db so repeated searches only flag what's
`NEW`.

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
