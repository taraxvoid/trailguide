import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse, stringify, TomlError } from "smol-toml";
import {
  type Env,
  globalConfigPath,
  globalDbPath,
  globalResumeDir,
  localConfigPath,
} from "./paths.ts";
import type { Board } from "./sources/boards.ts";
import { defaultBoards } from "./sources/seed.ts";

export type Flexibility = "remote" | "in-person" | "any";
export const FLEXIBILITIES: readonly Flexibility[] = [
  "remote",
  "in-person",
  "any",
];

/** A named job market: `[region.<name>]`. */
export interface RegionEntry {
  name: string;
  work: Flexibility;
  /** Places searched for this region; built-in metro names work too. */
  places: string[];
  /** Absolute resume folder; default `<resume dir>/<name>`. */
  resumes?: string;
}

export const BOARD_SYSTEMS: readonly Board["ats"][] = [
  "greenhouse",
  "lever",
  "ashby",
  "workday",
  "workable",
];

export interface KeywordEntry {
  role: string;
  /** Resume trail: jobs found by this keyword tailor from `<resume dir>/<trail>.md`. */
  trail?: string;
}

/** Trail names double as file names, so they stay simple. */
export const TRAIL_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** What one config file (or a merge of several) says; everything optional. */
export interface TrailguideConfig {
  /** Drop listings that require a security clearance (default: keep them). */
  clearance?: "include" | "exclude";
  /** Extra terms: a listing mentioning any of them is dropped. */
  excludeTerms?: string[];
  /** Absolute path (relative values are resolved against the file's dir). */
  db?: string;
  /** Absolute path to the resume masters (same resolution as `db`). */
  resumeDir?: string;
  /** In file order, which is the order everywhere regions are listed. */
  regions?: RegionEntry[];
  keywords?: KeywordEntry[];
  /** Company job boards searched in addition to the built-in ones. */
  boards?: Board[];
  /** false: search only `boards`, not the built-in set. */
  builtinBoards?: boolean;
}

/** The `[[keywords]] trail` values, each once, in config order. */
export function configuredTrails(config: TrailguideConfig): string[] {
  return [
    ...new Set(
      (config.keywords ?? []).flatMap((k) => (k.trail ? [k.trail] : [])),
    ),
  ];
}

/** The configured regions, in config order. */
export function configuredRegions(config: TrailguideConfig): RegionEntry[] {
  return config.regions ?? [];
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

function parseStrings(
  file: string,
  where: string,
  key: string,
  value: unknown,
): string[] {
  if (value === undefined) return [];
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
    throw new ConfigError(
      `${file}: ${where} "${key}" must be a string or a list of strings`,
    );
  }
  return (list as string[]).map((item) => item.trim()).filter(Boolean);
}

export function parseConfig(text: string, file: string): TrailguideConfig {
  const raw = parseToml(text, file);
  if (raw.job !== undefined) {
    throw new ConfigError(
      `${file}: [job] was replaced by [filter]: "govmil = true" is now the default; use [filter] clearance = "exclude" to drop clearance jobs`,
    );
  }
  if (raw.location !== undefined) {
    throw new ConfigError(
      `${file}: [[location]] was replaced by [region.<name>]. For example:\n  [region.home]\n  work = "in-person"\n  places = ["Austin, TX"]`,
    );
  }
  rejectUnknown(file, "top level", raw, [
    "filter",
    "db",
    "resume",
    "region",
    "keywords",
    "board",
    "sources",
  ]);
  const config: TrailguideConfig = {};

  if (raw.filter !== undefined) {
    if (!isTable(raw.filter))
      throw new ConfigError(`${file}: [filter] must be a table`);
    rejectUnknown(file, "[filter]", raw.filter, ["clearance", "exclude"]);
    const { clearance, exclude } = raw.filter;
    if (clearance !== undefined) {
      if (clearance !== "include" && clearance !== "exclude") {
        throw new ConfigError(
          `${file}: [filter] "clearance" must be "include" or "exclude"`,
        );
      }
      config.clearance = clearance;
    }
    if (exclude !== undefined) {
      if (
        !Array.isArray(exclude) ||
        !exclude.every((t) => typeof t === "string")
      ) {
        throw new ConfigError(
          `${file}: [filter] "exclude" must be a list of strings`,
        );
      }
      config.excludeTerms = exclude.map((t) => t.trim()).filter(Boolean);
    }
  }

  if (raw.db !== undefined) {
    if (!isTable(raw.db))
      throw new ConfigError(`${file}: [db] must be a table`);
    rejectUnknown(file, "[db]", raw.db, ["path"]);
    const path = requireString(file, "[db]", raw.db, "path");
    config.db = isAbsolute(path) ? path : resolve(dirname(file), path);
  }

  if (raw.resume !== undefined) {
    if (!isTable(raw.resume))
      throw new ConfigError(`${file}: [resume] must be a table`);
    rejectUnknown(file, "[resume]", raw.resume, ["dir"]);
    const dir = requireString(file, "[resume]", raw.resume, "dir");
    config.resumeDir = isAbsolute(dir) ? dir : resolve(dirname(file), dir);
  }

  if (raw.region !== undefined) {
    if (!isTable(raw.region) || !Object.values(raw.region).every(isTable)) {
      throw new ConfigError(
        `${file}: regions must be written as [region.<name>] tables`,
      );
    }
    config.regions = Object.entries(raw.region as Record<string, Table>).map(
      ([name, entry]) => {
        const where = `[region.${name}]`;
        if (!TRAIL_PATTERN.test(name)) {
          throw new ConfigError(
            `${file}: region name ${JSON.stringify(name)} must be lowercase letters, digits, - or _ (it names a resume folder)`,
          );
        }
        rejectUnknown(file, where, entry, ["work", "places", "resumes"]);
        const work = entry.work ?? "any";
        if (
          typeof work !== "string" ||
          !FLEXIBILITIES.includes(work as Flexibility)
        ) {
          throw new ConfigError(
            `${file}: ${where} has invalid work ${JSON.stringify(work)} (use remote, in-person, or any)`,
          );
        }
        const places = parseStrings(file, where, "places", entry.places);
        if (places.length === 0) {
          throw new ConfigError(`${file}: ${where} is missing "places"`);
        }
        const region: RegionEntry = {
          name,
          work: work as Flexibility,
          places,
        };
        if (entry.resumes !== undefined) {
          const dir = requireString(file, where, entry, "resumes");
          region.resumes = isAbsolute(dir) ? dir : resolve(dirname(file), dir);
        }
        return region;
      },
    );
  }

  if (raw.sources !== undefined) {
    if (!isTable(raw.sources))
      throw new ConfigError(`${file}: [sources] must be a table`);
    rejectUnknown(file, "[sources]", raw.sources, ["builtin_boards"]);
    if (raw.sources.builtin_boards !== undefined) {
      if (typeof raw.sources.builtin_boards !== "boolean") {
        throw new ConfigError(
          `${file}: [sources] "builtin_boards" must be true or false`,
        );
      }
      config.builtinBoards = raw.sources.builtin_boards;
    }
  }

  if (raw.board !== undefined) {
    config.boards = tableArray(file, "board", raw.board).map((entry, i) => {
      const where = `[[board]] entry ${i + 1}`;
      rejectUnknown(file, where, entry, [
        "company",
        "ats",
        "slug",
        "host",
        "site",
      ]);
      const company = requireString(file, where, entry, "company");
      const ats = requireString(file, where, entry, "ats");
      if (!BOARD_SYSTEMS.includes(ats as Board["ats"])) {
        throw new ConfigError(
          `${file}: ${where} has invalid ats ${JSON.stringify(ats)} (use ${BOARD_SYSTEMS.join(", ")})`,
        );
      }
      const slug = requireString(file, where, entry, "slug");
      if (ats !== "workday") {
        if (entry.host !== undefined || entry.site !== undefined) {
          throw new ConfigError(
            `${file}: ${where} "host" and "site" only apply to workday boards`,
          );
        }
        return { company, ats: ats as Board["ats"], slug };
      }
      return {
        company,
        ats: "workday",
        slug,
        host: requireString(file, where, entry, "host"),
        site: requireString(file, where, entry, "site"),
      };
    });
  }

  if (raw.keywords !== undefined) {
    config.keywords = tableArray(file, "keywords", raw.keywords).map(
      (entry, i) => {
        const where = `[[keywords]] entry ${i + 1}`;
        rejectUnknown(file, where, entry, ["role", "trail"]);
        const role = requireString(file, where, entry, "role");
        if (entry.trail === undefined) return { role };
        const trail = requireString(file, where, entry, "trail");
        if (!TRAIL_PATTERN.test(trail)) {
          throw new ConfigError(
            `${file}: ${where} trail ${JSON.stringify(trail)} must be lowercase letters, digits, - or _ (it names <trail>.md)`,
          );
        }
        return { role, trail };
      },
    );
  }

  return config;
}

/** Scalars override per key; lists are replaced wholesale, never joined. */
export function mergeConfigs(
  base: TrailguideConfig,
  override: TrailguideConfig,
): TrailguideConfig {
  const merged: TrailguideConfig = { ...base };
  if (override.clearance !== undefined) merged.clearance = override.clearance;
  if (override.excludeTerms !== undefined) {
    merged.excludeTerms = override.excludeTerms;
  }
  if (override.db !== undefined) merged.db = override.db;
  if (override.resumeDir !== undefined) merged.resumeDir = override.resumeDir;
  if (override.regions !== undefined) merged.regions = override.regions;
  if (override.keywords !== undefined) merged.keywords = override.keywords;
  if (override.boards !== undefined) merged.boards = override.boards;
  if (override.builtinBoards !== undefined) {
    merged.builtinBoards = override.builtinBoards;
  }
  return merged;
}

export function formatConfig(config: TrailguideConfig): string {
  const doc: Record<string, unknown> = {};
  if (config.clearance !== undefined || config.excludeTerms !== undefined) {
    doc.filter = {
      ...(config.clearance !== undefined && { clearance: config.clearance }),
      ...(config.excludeTerms !== undefined && {
        exclude: config.excludeTerms,
      }),
    };
  }
  if (config.db !== undefined) doc.db = { path: config.db };
  if (config.resumeDir !== undefined) doc.resume = { dir: config.resumeDir };
  if (config.regions) {
    doc.region = Object.fromEntries(
      config.regions.map(({ name, work, places, resumes }) => [
        name,
        { work, places, ...(resumes !== undefined && { resumes }) },
      ]),
    );
  }
  if (config.keywords) {
    doc.keywords = config.keywords.map(({ role, trail }) =>
      trail ? { role, trail } : { role },
    );
  }
  if (config.builtinBoards !== undefined) {
    doc.sources = { builtin_boards: config.builtinBoards };
  }
  if (config.boards) {
    doc.board = config.boards.map(({ company, ats, slug, host, site }) =>
      ats === "workday"
        ? { company, ats, slug, host, site }
        : { company, ats, slug },
    );
  }
  const text = stringify(doc);
  return text.endsWith("\n") || text === "" ? text : `${text}\n`;
}

export function writeConfig(path: string, config: TrailguideConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatConfig(config));
}

export interface ConfigContext {
  cwd?: string;
  env?: Env;
  /** `--config <path>`: replaces the whole file chain with this one file. */
  config?: string;
}

export interface LoadedConfig {
  config: TrailguideConfig;
  /** Files that were read, lowest precedence first. */
  files: string[];
}

function readConfigFile(path: string): TrailguideConfig {
  return parseConfig(readFileSync(path, "utf8"), path);
}

/** Reads the config chain from disk. Called per use; never cached. */
export function loadConfig(ctx: ConfigContext = {}): LoadedConfig {
  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;

  const explicit = ctx.config ?? (env.TRAILGUIDE_CONFIG || undefined);
  if (explicit) {
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) {
      throw new ConfigError(`config file not found: ${path}`);
    }
    return { config: readConfigFile(path), files: [path] };
  }

  let config: TrailguideConfig = {};
  const files: string[] = [];
  for (const path of [globalConfigPath(env), localConfigPath(cwd)]) {
    if (!existsSync(path)) continue;
    config = mergeConfigs(config, readConfigFile(path));
    files.push(path);
  }
  return { config, files };
}

/**
 * The shared DB resolver for every command: --db, then TRAILGUIDE_DB, then
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
  if (env.TRAILGUIDE_DB) return resolve(cwd, env.TRAILGUIDE_DB);
  return loadConfig(ctx).config.db ?? globalDbPath(env);
}

/**
 * The company boards to search: the built-in set (unless
 * `[sources] builtin_boards = false`) plus the config's `[[board]]` entries,
 * a config entry replacing a built-in one for the same company board.
 */
export function resolveBoards(config: TrailguideConfig): Board[] {
  const key = (b: Board) => `${b.ats}:${b.slug}`;
  const boards = new Map<string, Board>();
  if (config.builtinBoards !== false) {
    for (const board of defaultBoards) boards.set(key(board), board);
  }
  for (const board of config.boards ?? []) boards.set(key(board), board);
  return [...boards.values()];
}

/**
 * Where resume masters live: `[resume] dir`, else ~/.config/trailguide/resumes.
 * For a region, its `resumes` folder, else `<that dir>/<region name>`.
 */
export function resolveResumeDir(
  ctx: ConfigContext = {},
  region?: string,
): string {
  const env = ctx.env ?? process.env;
  const { config } = loadConfig(ctx);
  const base = config.resumeDir ?? globalResumeDir(env);
  if (!region) return base;
  const entry = configuredRegions(config).find((r) => r.name === region);
  return entry?.resumes ?? join(base, region);
}

export function describeConfig(ctx: ConfigContext = {}): string {
  const env = ctx.env ?? process.env;
  const { config, files } = loadConfig(ctx);
  const filesText =
    files.length > 0
      ? `config files (later entries override earlier):\n${files.map((f) => `  ${f}`).join("\n")}`
      : `config files: none (run "trailguide init" to create ${globalConfigPath(env)})`;
  const boards = resolveBoards(config);
  const extra = config.boards?.length ?? 0;
  const boardsText = `company boards: ${boards.length} (${
    config.builtinBoards === false ? "no built-in set" : "built-in set"
  }${extra > 0 ? ` + ${extra} from config` : ""})`;
  return [
    filesText,
    `database: ${resolveDbPath(ctx)}`,
    boardsText,
    "",
    formatConfig(config).trimEnd(),
  ].join("\n");
}

/** One location a search runs in. `city: null` means no location given. */
export interface SearchTarget {
  city: string | null;
  flexibility: Flexibility;
  /** The region this place belongs to; jobs it finds are tagged with it. */
  region?: string;
}

/** Every keyword is searched in every target. */
export interface SearchPlan {
  keywords: string[];
  /** Keyword → resume trail, for the keywords that name one. */
  trails: Record<string, string>;
  targets: SearchTarget[];
  filter: SearchFilter;
}

export interface SearchFilter {
  excludeClearance: boolean;
  excludeTerms: string[];
}

/** The `trailguide search` flags that shape a search. */
export interface SearchFlags {
  role?: string[];
  location?: string[];
  remote?: boolean;
  onsite?: boolean;
  excludeClearance?: boolean;
  includeClearance?: boolean;
  /** Search only these regions (default: all). */
  region?: string[];
}

/**
 * With --role, the flags describe the whole search and the config is not
 * read. Otherwise the config supplies keywords and locations, and
 * --location, --remote/--onsite and --exclude/--include-clearance override
 * pieces of it.
 */
export function toSearchOptions(
  flags: SearchFlags,
  load: () => LoadedConfig,
): SearchPlan {
  if (flags.remote && flags.onsite) {
    throw new ConfigError("--remote and --onsite are mutually exclusive");
  }
  if (flags.excludeClearance && flags.includeClearance) {
    throw new ConfigError(
      "--exclude-clearance and --include-clearance are mutually exclusive",
    );
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
    }),
  );

  if (flags.role && flags.role.length > 0) {
    return {
      keywords: flags.role,
      trails: {},
      targets: flagTargets ?? [
        { city: null, flexibility: flagFlexibility ?? "any" },
      ],
      filter: {
        excludeClearance: flags.excludeClearance ?? false,
        excludeTerms: [],
      },
    };
  }

  const { config, files } = load();
  if (files.length === 0) {
    throw new ConfigError(
      'no config file found. Run "trailguide init" to create one, or pass --role.',
    );
  }
  const where = files.join(", ");
  if (!config.keywords || config.keywords.length === 0) {
    throw new ConfigError(
      `no [[keywords]] configured (${where}). Add at least one [[keywords]] role, or pass --role.`,
    );
  }
  const regions = configuredRegions(config);
  const unknown = (flags.region ?? []).find(
    (name) => !regions.some((r) => r.name === name),
  );
  if (unknown !== undefined) {
    throw new ConfigError(
      `unknown region ${JSON.stringify(unknown)} (configured: ${regions.map((r) => r.name).join(", ") || "none"})`,
    );
  }
  const chosen =
    flags.region && flags.region.length > 0
      ? regions.filter((r) => flags.region?.includes(r.name))
      : regions;
  const targets =
    flagTargets ??
    chosen.flatMap((region) =>
      region.places.map(
        (city): SearchTarget => ({
          city,
          flexibility: flagFlexibility ?? region.work,
          region: region.name,
        }),
      ),
    );
  if (targets.length === 0) {
    throw new ConfigError(
      `no [region.<name>] configured (${where}). At least one region with places is required so a search is never unbounded.`,
    );
  }
  return {
    keywords: config.keywords.map((k) => k.role),
    trails: Object.fromEntries(
      config.keywords.flatMap((k) => (k.trail ? [[k.role, k.trail]] : [])),
    ),
    targets,
    filter: {
      excludeClearance: flags.includeClearance
        ? false
        : (flags.excludeClearance ?? config.clearance === "exclude"),
      excludeTerms: config.excludeTerms ?? [],
    },
  };
}
