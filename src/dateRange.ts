export interface DateRange {
  /** Inclusive start. */
  from: Date;
  /** Exclusive end. */
  to: Date;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Sunday 00:00 local of the week containing `d`. */
function startOfWeek(d: Date): Date {
  return addDays(startOfDay(d), -d.getDay());
}

/** Sunday 00:00 to next Sunday 00:00 (Sunday through Saturday), `offset` weeks from this one. */
export function weekRange(now: Date, offset = 0): DateRange {
  const from = addDays(startOfWeek(now), offset * 7);
  return { from, to: addDays(from, 7) };
}

function monthRange(now: Date, offset: number): DateRange {
  return {
    from: new Date(now.getFullYear(), now.getMonth() + offset, 1),
    to: new Date(now.getFullYear(), now.getMonth() + offset + 1, 1),
  };
}

export const RANGE_MNEMONICS = [
  "today",
  "yesterday",
  "this week",
  "last week",
  "this month",
  "last month",
  "last <N> days",
] as const;

/** Parses a mnemonic like "last week" or "yesterday" into a local-time range. Weeks run Sunday to Saturday. */
export function parseRange(input: string, now = new Date()): DateRange {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, " ");
  const today = startOfDay(now);
  switch (text) {
    case "today":
      return { from: today, to: addDays(today, 1) };
    case "yesterday":
      return { from: addDays(today, -1), to: today };
    case "this week":
      return weekRange(now, 0);
    case "last week":
      return weekRange(now, -1);
    case "this month":
      return monthRange(now, 0);
    case "last month":
      return monthRange(now, -1);
  }
  const days = text.match(/^(?:last|past) (\d+) days?$/);
  if (days) {
    return { from: addDays(today, -Number(days[1])), to: addDays(today, 1) };
  }
  throw new Error(
    `Unrecognized range "${input}". Try: ${RANGE_MNEMONICS.join(", ")}`,
  );
}

/** Parses a bare date (YYYY-MM-DD, local midnight), an ISO datetime, or a mnemonic (its start). */
export function parseBoundary(input: string, now = new Date()): Date {
  const bare = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (bare)
    return new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]));
  const iso = new Date(input);
  if (!Number.isNaN(iso.getTime())) return iso;
  return parseRange(input, now).from;
}

export function truncateWords(text: string | null, max: number): string | null {
  if (text === null) return null;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(" ");
  return `${words.slice(0, max).join(" ")}...`;
}
