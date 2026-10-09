import seedData from "../../seed/ats-companies.json" with { type: "json" };
import type { Board } from "./boards.ts";

/** The boards searched when the config adds none of its own. */
export const defaultBoards = seedData as Board[];

export function companiesForAts(
  ats: Board["ats"],
  boards: Board[] = defaultBoards,
): Board[] {
  return boards.filter((b) => b.ats === ats);
}
