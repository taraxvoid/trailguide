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
    parseWorkFlags(clean(options.work), cities) ?? (await askWork(io, cities));

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
