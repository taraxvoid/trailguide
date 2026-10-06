import { mapLimit } from "../limit.ts";
import type { NormalizedJob, SearchParams } from "./types.ts";

/** A company's public job board on one applicant tracking system. */
export interface Board {
  company: string;
  ats: "greenhouse" | "lever" | "ashby" | "workday";
  /** Board id; for workday, the tenant (<tenant>.<host>.myworkdayjobs.com). */
  slug: string;
  /** Workday only: the wdN host and the career site name from the board URL. */
  host?: string;
  site?: string;
}

/** Boards fetched at once per source. */
const BOARD_CONCURRENCY = 4;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs `search` over every board. One board failing (renamed slug, outage)
 * is reported through `params.warn` and skips only that board.
 */
export async function searchBoards(
  boards: Board[],
  params: SearchParams,
  search: (board: Board) => Promise<NormalizedJob[]>,
): Promise<NormalizedJob[]> {
  const found = await mapLimit(boards, BOARD_CONCURRENCY, async (board) => {
    try {
      return await search(board);
    } catch (err) {
      params.warn?.(`${board.company}: ${errorMessage(err)}`);
      return [];
    }
  });
  return found.flat();
}
