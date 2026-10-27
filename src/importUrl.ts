import type { Database } from "bun:sqlite";
import { getJob, type StoredJob, saveImportedJob } from "./db.ts";
import { httpFetch } from "./http.ts";
import { fetchAshbyJob } from "./sources/ashby.ts";
import type { Board } from "./sources/boards.ts";
import { fetchGreenhouseJob } from "./sources/greenhouse.ts";
import { parseJobPosting } from "./sources/jsonld.ts";
import { fetchLeverJob } from "./sources/lever.ts";
import type { NormalizedJob } from "./sources/types.ts";
import { fetchWorkableJob } from "./sources/workable.ts";
import { fetchWorkdayJob } from "./sources/workday.ts";

// `trailguide add <url>`: one job from one link, outside of search. Board
// links go through the board's API (same listing id search would give the
// job); anything else is read from the page's schema.org JobPosting.

/** A link trailguide can't turn into a job; the message says why. */
export class ImportError extends Error {}

export type JobRef =
  | { kind: "greenhouse" | "lever" | "ashby"; slug: string; id: string }
  | { kind: "workable"; slug: string; shortcode: string }
  | {
      kind: "workday";
      slug: string;
      host: string;
      site: string;
      externalPath: string;
    }
  | { kind: "web"; url: string };

const BOARD_NAMES = "Greenhouse, Lever, Ashby, Workable, Workday";
const WORKDAY_HOST = /^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/;

function notSingleJob(url: string, board: string): ImportError {
  return new ImportError(
    `${url} is a ${board} board page, not a single job; open the job and copy its link`,
  );
}

/** Works out which board (or plain page) a link points at, without fetching. */
export function parseJobUrl(url: string): JobRef {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    parsed = new URL("invalid:");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ImportError(
      `${url} is not a web link (expected one starting with https://)`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter((p) => p !== "");

  if (host === "job-boards.greenhouse.io" || host === "boards.greenhouse.io") {
    const slug =
      parts[0] === "embed" ? parsed.searchParams.get("for") : parts[0];
    const id =
      parts[0] === "embed"
        ? parsed.searchParams.get("token")
        : parts[1] === "jobs"
          ? parts[2]
          : undefined;
    if (!slug || !id) throw notSingleJob(url, "Greenhouse");
    return { kind: "greenhouse", slug, id };
  }
  if (host === "jobs.lever.co" || host === "jobs.ashbyhq.com") {
    const kind = host === "jobs.lever.co" ? "lever" : "ashby";
    const [slug, id] = parts;
    if (!slug || !id)
      throw notSingleJob(url, kind === "lever" ? "Lever" : "Ashby");
    return { kind, slug, id };
  }
  if (host === "apply.workable.com") {
    const [slug, j, shortcode] = parts;
    if (slug === "j") {
      throw new ImportError(
        `${url} doesn't name the company; use the link from its Workable page (apply.workable.com/<company>/j/<code>)`,
      );
    }
    if (!slug || j !== "j" || !shortcode) throw notSingleJob(url, "Workable");
    return { kind: "workable", slug, shortcode };
  }
  const workday = WORKDAY_HOST.exec(host);
  if (workday) {
    const jobAt = parts.indexOf("job");
    const site = parts[jobAt - 1];
    if (jobAt < 1 || !site || parts.length <= jobAt + 1) {
      throw notSingleJob(url, "Workday");
    }
    return {
      kind: "workday",
      slug: workday[1] as string,
      host: workday[2] as string,
      site,
      externalPath: `/${parts.slice(jobAt).join("/")}`,
    };
  }
  return { kind: "web", url };
}

function boardCompany(
  boards: Board[],
  ats: Board["ats"],
  slug: string,
  site?: string,
): string | undefined {
  return boards.find(
    (b) =>
      b.ats === ats &&
      b.slug.toLowerCase() === slug.toLowerCase() &&
      (site === undefined || b.site === site),
  )?.company;
}

async function fetchRef(ref: JobRef, boards: Board[]): Promise<NormalizedJob> {
  switch (ref.kind) {
    case "greenhouse":
      return fetchGreenhouseJob(
        ref.slug,
        ref.id,
        boardCompany(boards, "greenhouse", ref.slug),
      );
    case "lever":
      return fetchLeverJob(
        ref.slug,
        ref.id,
        boardCompany(boards, "lever", ref.slug),
      );
    case "ashby":
      return fetchAshbyJob(
        ref.slug,
        ref.id,
        boardCompany(boards, "ashby", ref.slug),
      );
    case "workable":
      return fetchWorkableJob(
        ref.slug,
        ref.shortcode,
        boardCompany(boards, "workable", ref.slug),
      );
    case "workday":
      return fetchWorkdayJob(
        {
          company:
            boardCompany(boards, "workday", ref.slug, ref.site) ?? ref.slug,
          ats: "workday",
          slug: ref.slug,
          host: ref.host,
          site: ref.site,
        },
        ref.externalPath,
      );
    case "web": {
      const res = await httpFetch(ref.url, {
        headers: { Accept: "text/html" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const job = parseJobPosting(await res.text(), ref.url);
      if (!job) {
        throw new ImportError(
          `no job posting found at ${ref.url}; trailguide reads ${BOARD_NAMES} links and pages that embed schema.org JobPosting data`,
        );
      }
      return job;
    }
  }
}

/** Fetches the job a link points at. Every failure is an ImportError. */
export async function resolveJobUrl(
  url: string,
  boards: Board[],
): Promise<NormalizedJob> {
  const ref = parseJobUrl(url);
  try {
    return await fetchRef(ref, boards);
  } catch (err) {
    if (err instanceof ImportError) throw err;
    const cause = err instanceof Error ? err.message : String(err);
    throw new ImportError(`could not fetch ${url}: ${cause}`);
  }
}

/** Resolves a link and stores the job with `trail` (null for none). */
export async function importJob(
  db: Database,
  url: string,
  trail: string | null,
  boards: Board[],
): Promise<{ job: StoredJob; added: boolean }> {
  const resolved = await resolveJobUrl(url, boards);
  const { listingId, added } = saveImportedJob(db, resolved, trail);
  const job = getJob(db, listingId);
  if (!job) throw new ImportError(`could not save ${url}`);
  return { job, added };
}
