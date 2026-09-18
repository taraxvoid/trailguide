import { describe, expect, it } from "bun:test";
import { stripTrackingParams } from "../src/url.ts";

describe("stripTrackingParams", () => {
  it("removes known tracking params but keeps other query params", () => {
    const result = stripTrackingParams(
      "https://example.com/job?id=42&utm_source=newsletter&utm_medium=email",
    );
    expect(result).toBe("https://example.com/job?id=42");
  });

  it("removes multiple distinct tracking params at once", () => {
    const result = stripTrackingParams(
      "https://example.com/job?fbclid=abc&gclid=def&ref=xyz",
    );
    expect(result).toBe("https://example.com/job");
  });

  it("leaves URLs without tracking params unchanged", () => {
    const result = stripTrackingParams("https://example.com/job?id=42");
    expect(result).toBe("https://example.com/job?id=42");
  });

  it("returns the original string when the URL is invalid", () => {
    expect(stripTrackingParams("not a url")).toBe("not a url");
  });
});
