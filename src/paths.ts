import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Env = Record<string, string | undefined>;

function xdgDir(env: Env, key: string, homeRelative: string): string {
  const value = env[key];
  // The XDG spec says relative values must be ignored.
  if (value && isAbsolute(value)) return value;
  return join(env.HOME || homedir(), homeRelative);
}

export function globalConfigPath(env: Env = process.env): string {
  return join(xdgDir(env, "XDG_CONFIG_HOME", ".config"), "igor", "config.toml");
}

export function globalDbPath(env: Env = process.env): string {
  return join(xdgDir(env, "XDG_DATA_HOME", ".local/share"), "igor", "igor.db");
}

export function localConfigPath(cwd: string): string {
  return join(cwd, "igor.toml");
}

/** Resume masters: `<lane>.md`, or the one `.md` when no lane applies. */
export function globalResumeDir(env: Env = process.env): string {
  return join(xdgDir(env, "XDG_CONFIG_HOME", ".config"), "igor", "resumes");
}

/** Tailored resumes (.md and .pdf), next to the database. */
export function globalOutputDir(env: Env = process.env): string {
  return join(xdgDir(env, "XDG_DATA_HOME", ".local/share"), "igor", "resumes");
}
