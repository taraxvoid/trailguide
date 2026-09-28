import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { TomlError, parse, stringify } from "smol-toml";
import {
  type Env,
  globalConfigPath,
  globalDbPath,
  localConfigPath,
} from "./paths.ts";

export type Flexibility = "remote" | "in-person" | "any";
export const FLEXIBILITIES: readonly Flexibility[] = [
  "remote",
  "in-person",
  "any",
];

export interface LocationEntry {
  city: string;
  flexibility: Flexibility;
  /** Extra terms a remote listing may match; never used for onsite matching. */
  region: string[];
}

/** What one config file (or a merge of several) says; everything optional. */
export interface IgorConfig {
  govmil?: boolean;
  /** Absolute path (relative values are resolved against the file's dir). */
  db?: string;
  locations?: LocationEntry[];
  keywords?: string[];
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

function parseRegion(file: string, where: string, value: unknown): string[] {
  if (value === undefined) return [];
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
    throw new ConfigError(
      `${file}: ${where} "region" must be a string or a list of strings`,
    );
  }
  return (list as string[]).map((item) => item.trim()).filter(Boolean);
}

export function parseConfig(text: string, file: string): IgorConfig {
  const raw = parseToml(text, file);
  rejectUnknown(file, "top level", raw, ["job", "db", "location", "keywords"]);
  const config: IgorConfig = {};

  if (raw.job !== undefined) {
    if (!isTable(raw.job))
      throw new ConfigError(`${file}: [job] must be a table`);
    rejectUnknown(file, "[job]", raw.job, ["govmil"]);
    if (raw.job.govmil !== undefined) {
      if (typeof raw.job.govmil !== "boolean") {
        throw new ConfigError(`${file}: [job] "govmil" must be true or false`);
      }
      config.govmil = raw.job.govmil;
    }
  }

  if (raw.db !== undefined) {
    if (!isTable(raw.db))
      throw new ConfigError(`${file}: [db] must be a table`);
    rejectUnknown(file, "[db]", raw.db, ["path"]);
    const path = requireString(file, "[db]", raw.db, "path");
    config.db = isAbsolute(path) ? path : resolve(dirname(file), path);
  }

  if (raw.location !== undefined) {
    config.locations = tableArray(file, "location", raw.location).map(
      (entry, i) => {
        const where = `[[location]] entry ${i + 1}`;
        rejectUnknown(file, where, entry, ["city", "flexibility", "region"]);
        const city = requireString(file, where, entry, "city");
        const flexibility = entry.flexibility ?? "any";
        if (
          typeof flexibility !== "string" ||
          !FLEXIBILITIES.includes(flexibility as Flexibility)
        ) {
          throw new ConfigError(
            `${file}: ${where} has invalid flexibility ${JSON.stringify(flexibility)} (use remote, in-person, or any)`,
          );
        }
        return {
          city,
          flexibility: flexibility as Flexibility,
          region: parseRegion(file, where, entry.region),
        };
      },
    );
  }

  if (raw.keywords !== undefined) {
    config.keywords = tableArray(file, "keywords", raw.keywords).map(
      (entry, i) => {
        const where = `[[keywords]] entry ${i + 1}`;
        rejectUnknown(file, where, entry, ["role"]);
        return requireString(file, where, entry, "role");
      },
    );
  }

  return config;
}

/** Scalars override per key; lists are replaced wholesale, never joined. */
export function mergeConfigs(
  base: IgorConfig,
  override: IgorConfig,
): IgorConfig {
  const merged: IgorConfig = { ...base };
  if (override.govmil !== undefined) merged.govmil = override.govmil;
  if (override.db !== undefined) merged.db = override.db;
  if (override.locations !== undefined) merged.locations = override.locations;
  if (override.keywords !== undefined) merged.keywords = override.keywords;
  return merged;
}

export function formatConfig(config: IgorConfig): string {
  const doc: Record<string, unknown> = {};
  if (config.govmil !== undefined) doc.job = { govmil: config.govmil };
  if (config.db !== undefined) doc.db = { path: config.db };
  if (config.locations) {
    doc.location = config.locations.map(({ city, flexibility, region }) =>
      region.length > 0 ? { city, flexibility, region } : { city, flexibility },
    );
  }
  if (config.keywords) doc.keywords = config.keywords.map((role) => ({ role }));
  const text = stringify(doc);
  return text.endsWith("\n") || text === "" ? text : `${text}\n`;
}

export function writeConfig(path: string, config: IgorConfig): void {
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
  config: IgorConfig;
  /** Files that were read, lowest precedence first. */
  files: string[];
}

function readConfigFile(path: string): IgorConfig {
  return parseConfig(readFileSync(path, "utf8"), path);
}

/** Reads the config chain from disk. Called per use; never cached. */
export function loadConfig(ctx: ConfigContext = {}): LoadedConfig {
  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;

  const explicit = ctx.config ?? (env.IGOR_CONFIG || undefined);
  if (explicit) {
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) {
      throw new ConfigError(`config file not found: ${path}`);
    }
    return { config: readConfigFile(path), files: [path] };
  }

  let config: IgorConfig = {};
  const files: string[] = [];
  for (const path of [globalConfigPath(env), localConfigPath(cwd)]) {
    if (!existsSync(path)) continue;
    config = mergeConfigs(config, readConfigFile(path));
    files.push(path);
  }
  return { config, files };
}

/**
 * The shared DB resolver for every command: --db, then IGOR_DB, then
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
  if (env.IGOR_DB) return resolve(cwd, env.IGOR_DB);
  return loadConfig(ctx).config.db ?? globalDbPath(env);
}

export function describeConfig(ctx: ConfigContext = {}): string {
  const env = ctx.env ?? process.env;
  const { config, files } = loadConfig(ctx);
  const filesText =
    files.length > 0
      ? `config files (later entries override earlier):\n${files.map((f) => `  ${f}`).join("\n")}`
      : `config files: none (run "igor init" to create ${globalConfigPath(env)})`;
  return [
    filesText,
    `database: ${resolveDbPath(ctx)}`,
    "",
    formatConfig(config).trimEnd(),
  ].join("\n");
}
