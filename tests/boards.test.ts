import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Board } from "../src/sources/boards.ts";
import { searchBoards } from "../src/sources/boards.ts";
import { createGreenhouseSource } from "../src/sources/greenhouse.ts";
import { createLeverSource } from "../src/sources/lever.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const boards: Board[] = [
  { company: "Good Co", ats: "greenhouse", slug: "good" },
  { company: "Gone Co", ats: "greenhouse", slug: "gone" },
  { company: "Slow Co", ats: "greenhouse", slug: "slow" },
];

describe("searchBoards", () => {
  it("skips a failing board, warns about it, and keeps the others", async () => {
    const warnings: string[] = [];
    const jobs = await searchBoards(
      boards,
      { role: "x", warn: (m) => warnings.push(m) },
      async (board) => {
        if (board.slug === "gone") throw new Error("HTTP 404");
        if (board.slug === "slow") throw "timed out";
        return [
          {
            sourceId: board.slug,
            source: "greenhouse",
            title: "x",
            company: board.company,
            location: "",
            remoteType: "unknown",
            url: "https://e.com",
            postedAt: null,
            description: null,
          },
        ];
      },
    );
    expect(jobs.map((j) => j.sourceId)).toEqual(["good"]);
    expect(warnings).toEqual(["Gone Co: HTTP 404", "Slow Co: timed out"]);
  });

  it("does not need a warn callback", async () => {
    expect(
      await searchBoards(boards, { role: "x" }, async () => {
        throw new Error("boom");
      }),
    ).toEqual([]);
  });
});

describe("board sources", () => {
  it("reports a non-OK board instead of dropping it silently", async () => {
    globalThis.fetch = mock(async (url: string | URL) =>
      String(url).includes("/gone/")
        ? new Response("nope", { status: 404 })
        : new Response(JSON.stringify({ jobs: [] })),
    ) as unknown as typeof fetch;
    const warnings: string[] = [];
    const jobs = await createGreenhouseSource(boards).search({
      role: "x",
      warn: (m) => warnings.push(m),
    });
    expect(jobs).toEqual([]);
    expect(warnings).toEqual(["Gone Co: HTTP 404"]);
  });

  it("searches only the boards it is given", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL) => {
      urls.push(String(url));
      return new Response("[]");
    }) as unknown as typeof fetch;
    await createLeverSource([
      { company: "Mine", ats: "lever", slug: "mine" },
    ]).search({ role: "x" });
    expect(urls).toEqual(["https://api.lever.co/v0/postings/mine?mode=json"]);
  });
});
