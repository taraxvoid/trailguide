import type { Key } from "ink";
import type { StoredJob } from "../db.ts";

// The TUI's `/` quick filter: full-text, case-insensitive, every
// whitespace-separated term must appear somewhere in the job. Pure, so
// App.tsx only routes keys here.

export interface FilterPrompt {
  text: string;
}

export type FilterResult =
  | { prompt: FilterPrompt }
  /** Enter: keep the filter and go back to the list. */
  | { done: string }
  /** Esc: drop the filter. */
  | { cancelled: true };

export function stepFilterPrompt(
  prompt: FilterPrompt,
  input: string,
  key: Key,
): FilterResult {
  if (key.escape) return { cancelled: true };
  if (key.return) return { done: prompt.text.trim() };
  if (key.backspace || key.delete) {
    return { prompt: { text: prompt.text.slice(0, -1) } };
  }
  // Drop line breaks from a paste, and tabs or other control characters.
  const printable = [...input].filter((c) => c >= " " && c !== "\x7f");
  return { prompt: { text: prompt.text + printable.join("") } };
}

function haystack(job: StoredJob): string {
  return [
    job.title,
    job.company,
    job.location,
    job.remoteType,
    job.trail ?? "",
    job.source,
    job.url,
    job.description ?? "",
  ]
    .join("\n")
    .toLowerCase();
}

/** Jobs matching every term of `query`; all of them for a blank query. */
export function filterJobs(jobs: StoredJob[], query: string): StoredJob[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return jobs;
  return jobs.filter((job) => {
    const text = haystack(job);
    return terms.every((term) => text.includes(term));
  });
}
