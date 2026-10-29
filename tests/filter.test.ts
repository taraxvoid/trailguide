import { describe, expect, it } from "bun:test";
import type { Key } from "ink";
import type { StoredJob } from "../src/db.ts";
import { filterJobs, stepFilterPrompt } from "../src/tui/filter.ts";

const NO_KEY = {} as Key;
const key = (k: Partial<Key>) => k as Key;

function job(id: string, fields: Partial<StoredJob>): StoredJob {
  return {
    listingId: id,
    title: "",
    company: "",
    location: "",
    remoteType: "unknown",
    source: "greenhouse",
    url: "",
    description: null,
    ...fields,
  } as StoredJob;
}

describe("stepFilterPrompt", () => {
  it("appends typed and pasted text, dropping line breaks", () => {
    expect(stepFilterPrompt({ text: "" }, "r", NO_KEY)).toEqual({
      prompt: { text: "r" },
    });
    expect(stepFilterPrompt({ text: "r" }, "ust\r\n", NO_KEY)).toEqual({
      prompt: { text: "rust" },
    });
  });

  it("removes the last character on backspace", () => {
    expect(
      stepFilterPrompt({ text: "ab" }, "", key({ backspace: true })),
    ).toEqual({ prompt: { text: "a" } });
  });

  it("keeps the trimmed query on enter and drops it on escape", () => {
    expect(
      stepFilterPrompt({ text: " rust " }, "", key({ return: true })),
    ).toEqual({ done: "rust" });
    expect(
      stepFilterPrompt({ text: "rust" }, "", key({ escape: true })),
    ).toEqual({ cancelled: true });
  });
});

describe("filterJobs", () => {
  const jobs = [
    job("a", { title: "Staff Engineer", company: "Acme" }),
    job("b", { title: "Engineer", description: "We write Rust in Berlin" }),
    job("c", { title: "Designer", company: "Rusty Co", trail: "platform" }),
  ];
  const ids = (query: string) =>
    filterJobs(jobs, query).map((j) => j.listingId);

  it("returns every job for a blank query", () => {
    expect(ids("  ")).toEqual(["a", "b", "c"]);
  });

  it("matches case-insensitively across title, company, description and trail", () => {
    expect(ids("RUST")).toEqual(["b", "c"]);
    expect(ids("acme")).toEqual(["a"]);
    expect(ids("platform")).toEqual(["c"]);
  });

  it("requires every term to match", () => {
    expect(ids("engineer berlin")).toEqual(["b"]);
    expect(ids("engineer nowhere")).toEqual([]);
  });
});
