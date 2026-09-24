import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The global `igor` is a `bun link` to one checkout, which would otherwise
// run that checkout's code even from inside a different branch's worktree.
// Instead, when the current directory is inside some other igor checkout,
// hand off to that checkout's CLI; anywhere else, the linked one runs.

/** Set on the handed-off process (and settable by hand) to stop delegating. */
export const NO_DELEGATE_ENV = "IGOR_NO_DELEGATE";

function isIgorCheckout(dir: string): boolean {
  if (!existsSync(join(dir, "src", "cli.ts"))) return false;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return pkg.name === "igor";
  } catch {
    return false;
  }
}

/** The nearest igor checkout containing `startDir`, if any. */
export function findCheckout(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (isIgorCheckout(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The `cli.ts` to hand off to, or null to keep running this one: when the
 * current directory is inside an igor checkout other than `selfCheckout`.
 */
export function delegateTarget(
  cwd: string,
  selfCheckout: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env[NO_DELEGATE_ENV]) return null;
  const local = findCheckout(cwd);
  if (!local || realpathSync(local) === realpathSync(selfCheckout)) return null;
  return join(local, "src", "cli.ts");
}

/** Runs `cliPath` with this process's args and stdio, returning its exit code. */
export async function runDelegate(
  cliPath: string,
  args: string[],
): Promise<number> {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliPath, ...args],
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, [NO_DELEGATE_ENV]: "1" },
  });
  return proc.exited;
}
