import { pathToFileURL } from "node:url";

/** Opens a file path or URL with the OS default handler. */
export function openTarget(target: string): void {
  const cmd =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", target]
      : process.platform === "darwin"
        ? ["open", target]
        : ["xdg-open", target];
  Bun.spawn({ cmd, stdio: ["ignore", "ignore", "ignore"] });
}

// Clipboard commands to try in order; the first that runs and exits 0 wins.
function clipboardCommands(): string[][] {
  if (process.platform === "darwin") return [["pbcopy"]];
  if (process.platform === "win32") return [["clip"]];
  return [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "-ib"]];
}

/** Copies `text` to the system clipboard. Resolves false if no clipboard tool worked. */
export async function copyToClipboard(text: string): Promise<boolean> {
  for (const cmd of clipboardCommands()) {
    try {
      const proc = Bun.spawn({
        cmd,
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.stdin.write(text);
      await proc.stdin.end();
      if ((await proc.exited) === 0) return true;
    } catch {
      // Not installed; try the next one.
    }
  }
  return false;
}

/** Wraps `text` in an OSC 8 terminal hyperlink to `url`. */
export function hyperlink(text: string, url: string): string {
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}

// An absolute path to a .pdf, possibly containing spaces.
const PDF_PATH = /(?:[A-Za-z]:\\|\/)[^\n]*?\.pdf\b/;

/**
 * Turns the first absolute .pdf path in a status message into a clickable
 * `file://` link. Terminals' own path detection fails on spaces and on
 * anything they can't resolve against the app's cwd, so link it explicitly.
 */
export function linkifyPdfPath(message: string): string {
  const match = PDF_PATH.exec(message);
  if (!match) return message;
  const path = match[0];
  return message.replace(path, hyperlink(path, pathToFileURL(path).href));
}
