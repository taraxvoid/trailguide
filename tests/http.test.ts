import { afterEach, describe, expect, it, mock } from "bun:test";
import { getJson, httpFetch, USER_AGENT } from "../src/http.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function capture(response: () => Response) {
  const seen: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return response();
  }) as unknown as typeof fetch;
  return seen;
}

describe("httpFetch", () => {
  it("identifies igor and sets a timeout", async () => {
    const seen = capture(() => new Response("{}"));
    await httpFetch("https://example.com/a");
    expect(USER_AGENT).toMatch(
      /^igor\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\//,
    );
    expect(seen[0]?.init?.headers).toEqual({ "User-Agent": USER_AGENT });
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("lets a caller override the User-Agent and keeps its other headers", async () => {
    const seen = capture(() => new Response("{}"));
    await httpFetch("https://example.com/a", {
      headers: { "User-Agent": "custom", Accept: "application/json" },
    });
    expect(seen[0]?.init?.headers).toEqual({
      "User-Agent": "custom",
      Accept: "application/json",
    });
  });
});

describe("getJson", () => {
  it("parses a 2xx body", async () => {
    capture(() => new Response('{"ok":true}'));
    expect(await getJson<{ ok: boolean }>("https://example.com/a")).toEqual({
      ok: true,
    });
  });

  it("throws on a non-2xx status", async () => {
    capture(() => new Response("gone", { status: 404 }));
    await expect(getJson("https://example.com/a")).rejects.toThrow("HTTP 404");
  });
});
