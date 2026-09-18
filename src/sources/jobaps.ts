import { matchesLocation } from "./location.ts";
import type { NormalizedJob, SearchParams, Source } from "./types.ts";

/**
 * JobAPS (jobapscloud.com) is a job board platform used by a handful of
 * California counties. Only Alameda County is confirmed working here;
 * most Bay Area cities/counties (Oakland, Hayward, Livermore, San Mateo)
 * instead run on GovernmentJobs.com/NEOGOV, which renders postings
 * client-side with no public API or feed, or on CalOpps, which blocks
 * non-browser requests at the CDN. See #31 for that research.
 */
interface JobApsAgency {
  agency: string;
  slug: string;
  location: string;
}

const AGENCIES: JobApsAgency[] = [
  { agency: "Alameda County", slug: "Alameda", location: "Alameda County, CA" },
];

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

const HTML_BLOCK_TAGS = /<\/(p|div|li|br|ul|ol|h[1-6])\s*>|<(br)\s*\/?>/gi;

function stripHtml(html: string): string {
  return html
    .replace(HTML_BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n")
    .trim();
}

interface JobApsItem {
  title: string;
  link: string;
  guid: string;
  pubDate: string;
  description: string;
}

function parseItems(xml: string): JobApsItem[] {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return blocks.map((block) => ({
    title: decodeEntities(extractTag(block, "title")),
    link: decodeEntities(extractTag(block, "link")),
    guid: decodeEntities(extractTag(block, "guid")),
    pubDate: extractTag(block, "pubDate"),
    description: decodeEntities(extractTag(block, "description")),
  }));
}

function matchesRole(title: string, role: string): boolean {
  return title.toLowerCase().includes(role.toLowerCase());
}

const WORK_LOCATION_PATTERN = /Work Location:\s*([^\n]+)/i;

// Postings within a county-wide feed still name the office city
// (e.g. "Work Location: Oakland"), so prefer that over the agency's
// county-wide default when it's present.
function extractWorkLocation(description: string): string | null {
  return WORK_LOCATION_PATTERN.exec(description)?.[1]?.trim() || null;
}

export function createJobApsSource(): Source {
  return {
    name: "jobaps",
    async search(params: SearchParams): Promise<NormalizedJob[]> {
      const results: NormalizedJob[] = [];

      for (const agency of AGENCIES) {
        const res = await fetch(
          `https://www.jobapscloud.com/${agency.slug}/rss.asp`,
        );
        if (!res.ok) {
          continue;
        }

        for (const item of parseItems(await res.text())) {
          if (!item.guid || !matchesRole(item.title, params.role)) continue;
          const description = stripHtml(item.description);
          const workLocation = extractWorkLocation(description);
          const location = workLocation
            ? `${workLocation}, CA`
            : agency.location;
          if (params.location && !matchesLocation(location, params.location)) {
            continue;
          }
          results.push({
            sourceId: item.guid,
            source: "jobaps",
            title: item.title,
            company: agency.agency,
            location,
            remoteType: "onsite",
            url: item.link,
            postedAt: item.pubDate
              ? new Date(item.pubDate).toISOString()
              : null,
            description,
          });
        }
      }

      return results;
    },
  };
}
