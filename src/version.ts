import { dirname } from "node:path";

// Which checkout of igor is actually running. The global `igor` is usually a
// `bun link` to one checkout, so running it from inside a different worktree
// still runs the linked code - this makes that visible in the TUI.

export interface GitVersion {
  hash: string;
  subject: string;
  /** null when HEAD is detached. */
  branch: string | null;
  /** Whether the checkout has uncommitted changes. */
  dirty: boolean;
}

function git(cwd: string, args: string[]): string | null {
  try {
    const proc = Bun.spawnSync({
      cmd: ["git", "-C", cwd, ...args],
      stdout: "pipe",
      stderr: "ignore",
    });
    return proc.exitCode === 0 ? proc.stdout.toString().trim() : null;
  } catch {
    // git isn't installed.
    return null;
  }
}

/**
 * Reads the last commit of the git checkout containing `dir` (by default,
 * the one this source file lives in - not the current directory). Returns
 * null outside a git checkout, e.g. an installed package.
 */
export function gitVersion(dir = dirname(import.meta.dir)): GitVersion | null {
  const log = git(dir, ["log", "-1", "--format=%h%x00%s"]);
  if (!log) return null;
  const [hash = "", subject = ""] = log.split("\0");
  const branch = git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const status = git(dir, ["status", "--porcelain"]);
  return {
    hash,
    subject,
    branch: branch || null,
    dirty: Boolean(status),
  };
}

export function formatGitVersion(version: GitVersion): string {
  const branch = version.branch ? `${version.branch}@` : "";
  const dirty = version.dirty ? "*" : "";
  return `${branch}${version.hash}${dirty} ${version.subject}`;
}
