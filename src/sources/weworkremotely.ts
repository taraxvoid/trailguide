import { httpFetch } from "../http.ts";
import { stripHtml } from "./html.ts";
import { matchesLocation } from "./location.ts";
import { toArray } from "./params.ts";
import type { NormalizedJob, SearchParams, Source } from "./types.ts";

interface WwrItem {
  title: string;
  region: string;
  link: string;
  guid: string;
  pubDate: string;
  description: string;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.trim() ?? "";
}

function parseItems(xml: string): WwrItem[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return items.map((block) => ({
    title: decodeEntities(extractTag(block, "title")),
    region: decodeEntities(extractTag(block, "region")),
    link: extractTag(block, "link"),
    guid: extractTag(block, "guid"),
    pubDate: extractTag(block, "pubDate"),
    description: decodeEntities(extractTag(block, "description")),
  }));
}

function splitTitle(title: string): { company: string; jobTitle: string } {
  const idx = title.indexOf(": ");
  if (idx === -1) return { company: "unknown", jobTitle: title };
  return { company: title.slice(0, idx), jobTitle: title.slice(idx + 2) };
}

function matchesRole(title: string, role: string | string[]): boolean {
  const lowerTitle = title.toLowerCase();
  return toArray(role).some((r) => lowerTitle.includes(r.toLowerCase()));
}

export function createWeWorkRemotelySource(): Source {
  return {
    name: "weworkremotely",
    scoped: false,
    async search(params: SearchParams): Promise<NormalizedJob[]> {
      const res = await httpFetch(
        "https://weworkremotely.com/categories/remote-programming-jobs.rss",
      );
      if (!res.ok) {
        throw new Error(
          `We Work Remotely request failed: ${res.status} ${await res.text()}`,
        );
      }

      const jobs = parseItems(await res.text())
        .filter((item) => item.guid && item.title.includes(": "))
        .map((item) => {
          const { company, jobTitle } = splitTitle(item.title);
          return {
            sourceId: item.guid,
            source: "weworkremotely" as const,
            title: jobTitle,
            company,
            location: item.region || "Worldwide",
            remoteType: "remote" as const,
            url: item.link,
            postedAt: item.pubDate
              ? new Date(item.pubDate).toISOString()
              : null,
            description: stripHtml(item.description),
          };
        });

      return jobs
        .filter((job) => matchesRole(job.title, params.role))
        .filter(
          (job) =>
            !params.location || matchesLocation(job.location, params.location),
        );
    },
  };
}
