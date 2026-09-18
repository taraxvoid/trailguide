import { matchesLocation } from "./location.ts";
import { toArray } from "./params.ts";
import { companiesForAts } from "./seed.ts";
import type { NormalizedJob, SearchParams, Source } from "./types.ts";

interface GreenhouseJob {
  id: number;
  title: string;
  location: { name: string };
  absolute_url: string;
  updated_at: string;
  content: string;
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[];
}

function matchesRole(title: string, role: string | string[]): boolean {
  const lowerTitle = title.toLowerCase();
  return toArray(role).some((r) => lowerTitle.includes(r.toLowerCase()));
}

const HTML_BLOCK_TAGS = /<\/(p|div|li|br|ul|ol|h[1-6])\s*>|<(br)\s*\/?>/gi;

function stripHtml(html: string): string {
  return html
    .replace(HTML_BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n")
    .trim();
}

export function createGreenhouseSource(): Source {
  return {
    name: "greenhouse",
    async search(params: SearchParams): Promise<NormalizedJob[]> {
      const companies = companiesForAts("greenhouse");
      const results: NormalizedJob[] = [];

      for (const { company, slug } of companies) {
        const res = await fetch(
          `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
        );
        if (!res.ok) {
          continue;
        }
        const body = (await res.json()) as GreenhouseResponse;
        for (const job of body.jobs) {
          if (!matchesRole(job.title, params.role)) continue;
          if (
            params.location &&
            !matchesLocation(job.location.name, params.location)
          ) {
            continue;
          }
          results.push({
            sourceId: String(job.id),
            source: "greenhouse",
            title: job.title,
            company,
            location: job.location.name,
            remoteType: job.location.name.toLowerCase().includes("remote")
              ? "remote"
              : "unknown",
            url: job.absolute_url,
            postedAt: job.updated_at,
            description: stripHtml(job.content),
          });
        }
      }

      return results;
    },
  };
}
