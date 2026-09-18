import { toArray } from "./params.ts";

const METRO_ALIASES: Record<string, string[]> = {
  omaha: ["omaha", "la vista", "elkhorn", "ralston"],
};

export function matchesLocation(
  jobLocation: string,
  queryLocation: string | string[],
): boolean {
  const job = jobLocation.toLowerCase();
  return toArray(queryLocation).some((queryLocation) => {
    const query = queryLocation.toLowerCase();
    const aliases = METRO_ALIASES[query] ?? [query];
    return aliases.some((alias) => job.includes(alias));
  });
}
