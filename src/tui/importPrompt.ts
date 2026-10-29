import type { Key } from "ink";

// The TUI's `I` prompt: type or paste a link, then pick a trail. Pure, so
// App.tsx only routes keys here and acts on `done`.

export type ImportPrompt =
  | { step: "url"; text: string }
  /** `index` points into `[...trails, "none"]`. */
  | { step: "trail"; url: string; index: number };

export type PromptResult =
  | { prompt: ImportPrompt }
  | { done: { url: string; trail: string | null } }
  | { cancelled: true };

export function stepImportPrompt(
  prompt: ImportPrompt,
  input: string,
  key: Key,
  trails: string[],
): PromptResult {
  if (key.escape) return { cancelled: true };

  if (prompt.step === "url") {
    if (key.return) {
      const url = prompt.text.trim();
      if (url === "") return { prompt };
      if (trails.length === 0) return { done: { url, trail: null } };
      return { prompt: { step: "trail", url, index: 0 } };
    }
    if (key.backspace || key.delete) {
      return { prompt: { ...prompt, text: prompt.text.slice(0, -1) } };
    }
    // Drop line breaks from a paste, and tabs or other control characters.
    const printable = [...input].filter((c) => c >= " " && c !== "\x7f");
    return {
      prompt: { ...prompt, text: prompt.text + printable.join("") },
    };
  }

  const count = trails.length + 1;
  if (key.return) {
    return {
      done: { url: prompt.url, trail: trails[prompt.index] ?? null },
    };
  }
  if (key.rightArrow || input === "l") {
    return { prompt: { ...prompt, index: (prompt.index + 1) % count } };
  }
  if (key.leftArrow || input === "h") {
    return { prompt: { ...prompt, index: (prompt.index - 1 + count) % count } };
  }
  return { prompt };
}
