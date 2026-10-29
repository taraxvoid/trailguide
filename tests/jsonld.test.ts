import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { parseJobPosting } from "../src/sources/jsonld.ts";

// Bun types *.html imports as HTML bundles, so read the fixture as text.
const fixture = await Bun.file(
  new URL("./fixtures/jsonld-openaifoundation.html", import.meta.url),
).text();

const PAGE =
  "https://openaifoundation.org/careers/ai-deployment-engineer-4f16ada0-a2da-4509-9016-ed4879d2fe67";

function page(...blocks: unknown[]): string {
  return `<html><head>${blocks
    .map(
      (b) =>
        `<script type="application/ld+json">${typeof b === "string" ? b : JSON.stringify(b)}</script>`,
    )
    .join("\n")}</head></html>`;
}

const posting = {
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Platform Engineer",
  hiringOrganization: { "@type": "Organization", name: "Example Co" },
  jobLocation: {
    "@type": "Place",
    address: { addressLocality: "Oakland", addressRegion: "CA" },
  },
};

describe("parseJobPosting", () => {
  it("reads the OpenAI Foundation posting", () => {
    const job = parseJobPosting(fixture, PAGE);
    expect(job).toMatchObject({
      title: "AI Deployment Engineer",
      company: "OpenAI Foundation",
      location: "San Francisco, California, United States",
      source: "web",
      sourceId: "openaifoundation.org:4f16ada0-a2da-4509-9016-ed4879d2fe67",
      url: PAGE,
      postedAt: "2026-09-21",
      remoteType: "unknown",
    });
    expect(job?.description).toContain("About OpenAI Foundation");
    expect(job?.description).not.toContain("<");
  });

  it("finds the posting inside @graph, an array @type, or after other blocks", () => {
    const wrapped = { "@context": "https://schema.org", "@graph": [posting] };
    expect(parseJobPosting(page(wrapped), PAGE)?.title).toBe(
      "Platform Engineer",
    );
    const arrayType = { ...posting, "@type": ["JobPosting"] };
    expect(parseJobPosting(page(arrayType), PAGE)?.title).toBe(
      "Platform Engineer",
    );
    const org = { "@type": "Organization", name: "Example Co" };
    expect(parseJobPosting(page(org, posting), PAGE)?.title).toBe(
      "Platform Engineer",
    );
    expect(parseJobPosting(page([org, posting]), PAGE)?.title).toBe(
      "Platform Engineer",
    );
  });

  it("skips a block that isn't valid JSON", () => {
    expect(parseJobPosting(page("{not json", posting), PAGE)?.title).toBe(
      "Platform Engineer",
    );
  });

  it("treats TELECOMMUTE with no place as remote", () => {
    const remote = {
      ...posting,
      jobLocation: undefined,
      jobLocationType: "TELECOMMUTE",
    };
    expect(parseJobPosting(page(remote), PAGE)).toMatchObject({
      location: "Remote",
      remoteType: "remote",
    });
  });

  it("splits several places into location and otherLocations", () => {
    const multi = {
      ...posting,
      jobLocation: [
        {
          "@type": "Place",
          address: { addressLocality: "Oakland", addressCountry: "US" },
        },
        {
          "@type": "Place",
          address: {
            addressLocality: "Toronto",
            addressCountry: { "@type": "Country", name: "Canada" },
          },
        },
      ],
    };
    expect(parseJobPosting(page(multi), PAGE)).toMatchObject({
      location: "Oakland, US",
      otherLocations: ["Toronto, Canada"],
    });
  });

  it("accepts hiringOrganization as a plain string", () => {
    const plain = { ...posting, hiringOrganization: "Plain Co" };
    expect(parseJobPosting(page(plain), PAGE)?.company).toBe("Plain Co");
  });

  it("hashes the URL without query or fragment when there's no identifier", () => {
    const base = "https://example.org/jobs/platform";
    const hash = createHash("sha256").update(base).digest("hex").slice(0, 16);
    expect(parseJobPosting(page(posting), base)?.sourceId).toBe(
      `example.org:${hash}`,
    );
    expect(parseJobPosting(page(posting), `${base}/`)?.sourceId).toBe(
      `example.org:${hash}`,
    );
    const noisy = parseJobPosting(page(posting), `${base}?utm_source=x#apply`);
    expect(noisy?.sourceId).toBe(`example.org:${hash}`);
    expect(noisy?.url).toBe(base);
  });

  it("ignores an identifier that only names the company", () => {
    const base = "https://example.org/jobs/platform";
    const hash = createHash("sha256").update(base).digest("hex").slice(0, 16);
    const named = {
      ...posting,
      identifier: { "@type": "PropertyValue", name: "Example Co" },
    };
    expect(parseJobPosting(page(named), base)?.sourceId).toBe(
      `example.org:${hash}`,
    );
  });

  it("returns null without a title, a company, or any JobPosting", () => {
    expect(
      parseJobPosting(page({ ...posting, title: undefined }), PAGE),
    ).toBeNull();
    expect(
      parseJobPosting(
        page({ ...posting, hiringOrganization: undefined }),
        PAGE,
      ),
    ).toBeNull();
    expect(
      parseJobPosting(page({ "@type": "Organization", name: "x" }), PAGE),
    ).toBeNull();
    expect(parseJobPosting("<html></html>", PAGE)).toBeNull();
  });
});
