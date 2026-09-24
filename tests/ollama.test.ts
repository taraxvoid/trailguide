import { describe, expect, it } from "bun:test";
import {
  buildPlanContext,
  isModelAvailable,
  requestTailorPlan,
  resolveOllamaHost,
  resolveOllamaModel,
} from "../src/tailor/ollama.ts";
import { parseResume } from "../src/tailor/resumeDoc.ts";

const fixturePath = new URL("./fixtures/resume-sample.md", import.meta.url);
const fixture = await Bun.file(fixturePath).text();

describe("resolveOllamaHost", () => {
  it("defaults to the local daemon", () => {
    expect(resolveOllamaHost(undefined)).toBe("http://127.0.0.1:11434");
  });

  it("adds a scheme to a bare host:port, matching Ollama's own OLLAMA_HOST convention", () => {
    expect(resolveOllamaHost("192.168.1.5:11434")).toBe(
      "http://192.168.1.5:11434",
    );
  });

  it("leaves an explicit scheme alone", () => {
    expect(resolveOllamaHost("https://ollama.example.com")).toBe(
      "https://ollama.example.com",
    );
  });
});

describe("resolveOllamaModel", () => {
  it("defaults to a thinking-capable local model", () => {
    expect(resolveOllamaModel(undefined)).toBe("qwen3:8b");
  });

  it("honors an override", () => {
    expect(resolveOllamaModel("mistral")).toBe("mistral");
  });
});

describe("buildPlanContext", () => {
  it("exposes only ids and plain bullet text, not markdown chrome", () => {
    const doc = parseResume(fixture);
    const ctx = buildPlanContext(doc);
    expect(ctx.highlights.length).toBeGreaterThan(0);
    expect(ctx.highlights[0]?.text).not.toMatch(/^-/);
    expect(ctx.jobs.map((j) => j.employer)).toEqual([
      "Acme Corp",
      "Beta Industries",
      "Gamma LLC",
    ]);
    expect(ctx.jobs[0]?.bullets.length).toBe(3);
  });
});

describe("requestTailorPlan", () => {
  const job = {
    title: "Backend Engineer",
    company: "Acme",
    description: "AWS, Python",
  };

  it("parses the model's JSON content out of the chat response", async () => {
    const doc = parseResume(fixture);
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              highlightOrder: ["highlight0"],
              experience: [],
            }),
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const plan = await requestTailorPlan(job, doc, { fetchImpl });
    expect(plan).toEqual({ highlightOrder: ["highlight0"], experience: [] });
  });

  it("raises a clear error when Ollama is unreachable", async () => {
    const doc = parseResume(fixture);
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await expect(requestTailorPlan(job, doc, { fetchImpl })).rejects.toThrow(
      /Ollama/,
    );
  });

  it("raises a clear error when the model's content isn't valid JSON", async () => {
    const doc = parseResume(fixture);
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: { content: "not json" } }), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(requestTailorPlan(job, doc, { fetchImpl })).rejects.toThrow(
      /valid JSON/,
    );
  });
});

describe("isModelAvailable", () => {
  it("is true when the model appears in the tags list", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await isModelAvailable("qwen3:8b", "http://x", fetchImpl)).toBe(
      true,
    );
  });

  it("is false when Ollama is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    expect(await isModelAvailable("qwen3:8b", "http://x", fetchImpl)).toBe(
      false,
    );
  });
});
