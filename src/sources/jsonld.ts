import { createHash } from "node:crypto";
import { stripTrackingParams } from "../url.ts";
import { stripHtml } from "./html.ts";
import type { NormalizedJob } from "./types.ts";

// schema.org JobPosting, as careers pages embed it for search engines
// (<script type="application/ld+json">). Only the fields trailguide stores.

type Node = Record<string, unknown>;

const LD_JSON =
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function isJobPosting(node: Node): boolean {
  const type = node["@type"];
  return Array.isArray(type)
    ? type.includes("JobPosting")
    : type === "JobPosting";
}

/** Depth-first search through arrays and @graph for the first JobPosting. */
function findPosting(value: unknown): Node | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (!isNode(value)) return null;
  if (isJobPosting(value)) return value;
  return findPosting(value["@graph"]);
}

function placeName(place: unknown): string {
  if (!isNode(place)) return "";
  const address = place.address;
  if (!isNode(address)) return text(address) ?? text(place.name) ?? "";
  const country = isNode(address.addressCountry)
    ? text(address.addressCountry.name)
    : text(address.addressCountry);
  return [text(address.addressLocality), text(address.addressRegion), country]
    .filter((p) => p !== undefined)
    .join(", ");
}

function identifierValue(value: unknown): string | undefined {
  // A PropertyValue's `name` is usually the company, not an id: same on
  // every posting from the site, so only `value` counts.
  if (isNode(value)) {
    return typeof value.value === "number"
      ? String(value.value)
      : text(value.value);
  }
  return typeof value === "number" ? String(value) : text(value);
}

/** The page URL with tracking params and the fragment removed. */
function canonicalUrl(pageUrl: string): string {
  const url = new URL(stripTrackingParams(pageUrl));
  url.hash = "";
  return url.toString();
}

/**
 * Reads the first schema.org JobPosting embedded in a page. Null when there
 * is none, or it lacks a title or hiring organization.
 */
export function parseJobPosting(
  html: string,
  pageUrl: string,
): NormalizedJob | null {
  let posting: Node | null = null;
  for (const [, body] of html.matchAll(LD_JSON)) {
    try {
      posting = findPosting(JSON.parse(body ?? ""));
    } catch {
      continue;
    }
    if (posting) break;
  }
  if (!posting) return null;

  const org = posting.hiringOrganization;
  const title = text(posting.title);
  const company = isNode(org) ? text(org.name) : text(org);
  if (!title || !company) return null;

  const places = [posting.jobLocation]
    .flat()
    .map(placeName)
    .filter((p) => p !== "");
  const telecommute = [posting.jobLocationType]
    .flat()
    .some((t) => typeof t === "string" && t.toUpperCase() === "TELECOMMUTE");
  const url = canonicalUrl(pageUrl);
  const parsed = new URL(url);
  const id =
    identifierValue(posting.identifier) ??
    createHash("sha256")
      // A trailing slash is the same page, so it must be the same job.
      .update(`${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`)
      .digest("hex")
      .slice(0, 16);
  const description = text(posting.description);

  return {
    sourceId: `${parsed.hostname}:${id}`,
    source: "web",
    title,
    company,
    location: places[0] ?? (telecommute ? "Remote" : ""),
    ...(places.length > 1 ? { otherLocations: places.slice(1) } : {}),
    remoteType: telecommute ? "remote" : "unknown",
    url,
    postedAt: text(posting.datePosted) ?? null,
    description: description ? stripHtml(description) : null,
  };
}
