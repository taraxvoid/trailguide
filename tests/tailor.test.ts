import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { getTailoredResume, openDb, upsertJobs } from "../src/db.ts";
import type { NormalizedJob } from "../src/sources/types.ts";
import {
  regenerateResume,
  tailorOrRegenerate,
  tailorResume,
} from "../src/tailor/index.ts";

let counter = 0;
function freshDb() {
  const path = `/tmp/trailguide-tailor-test-${Date.now()}-${++counter}.db`;
  rmSync(path, { force: true });
  return openDb(path);
}

function mockJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    sourceId: "1",
    source: "jsearch",
    title: "Backend Engineer",
    company: "Acme",
    location: "Remote",
    remoteType: "remote",
    url: "https://example.com",
    postedAt: null,
    description: "Looking for someone with AWS and Python experience.",
    ...overrides,
  };
}

const outputDir = `/tmp/trailguide-tailor-test-output-${Date.now()}`;
const resumeDir = `${import.meta.dir}/fixtures`;
const resumePath = `${resumeDir}/resume-sample.md`;

afterEach(() => {
  rmSync(outputDir, { recursive: true, force: true });
});

describe("tailorResume", () => {
  it("fails clearly when the job doesn't exist", async () => {
    const db = openDb(":memory:");
    const result = await tailorResume(db, "jsearch:missing", {
      resumePath,
      outputDir,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no job found/);
  });

  it("fails clearly when the resume file doesn't exist", async () => {
    const db = freshDb();
    upsertJobs(db, [mockJob()]);
    const result = await tailorResume(db, "jsearch:1", {
      resumePath: "/nonexistent/resume.md",
      outputDir,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it("falls back to an untailored render when Ollama is unreachable", async () => {
    const db = freshDb();
    upsertJobs(db, [mockJob()]);
    const result = await tailorResume(db, "jsearch:1", {
      resumePath,
      outputDir,
      ollamaHost: "http://127.0.0.1:1",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("isn't available"))).toBe(
      true,
    );
    expect(await Bun.file(result.markdownPath ?? "").text()).toContain(
      "Owned widget infrastructure end to end",
    );
  });

  it("applies a successful tailoring plan and writes both .md and .pdf", async () => {
    const db = freshDb();
    upsertJobs(db, [mockJob()]);
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen3:8b" }] }),
          { status: 200 },
        );
      }
      // Reverse Acme's bullets - a deliberately detectable, non-default order.
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              highlightOrder: ["highlight2", "highlight1", "highlight0"],
              experience: [
                {
                  id: "experience0",
                  bulletOrder: [
                    "experience0_2",
                    "experience0_0",
                    "experience0_1",
                  ],
                },
                {
                  id: "experience1",
                  bulletOrder: ["experience1_0", "experience1_1"],
                },
                {
                  id: "experience2",
                  bulletOrder: ["experience2_0", "experience2_1"],
                },
              ],
              // Lead with the security group, and pull the cloud line.
              skillGroupOrder: ["skill1", "skill0"],
              skills: [
                { id: "skill0", bulletOrder: ["skill0_0", "skill0_2"] },
                { id: "skill1", bulletOrder: ["skill1_0", "skill1_1"] },
              ],
            }),
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await tailorResume(db, "jsearch:1", {
      resumePath,
      outputDir,
      ollamaModel: "qwen3:8b",
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    // Whether a PDF can actually be produced depends on `typst` being
    // installed, which CI doesn't have; the tailoring itself must still be
    // warning-free either way.
    expect(
      result.warnings.filter((w) => !w.startsWith("PDF render failed")),
    ).toEqual([]);
    const md = await Bun.file(result.markdownPath ?? "").text();
    expect(md.indexOf("Mentored two junior engineers")).toBeLessThan(
      md.indexOf("Owned widget infrastructure end to end"),
    );
    // Employers are never dropped or reordered, only their bullets.
    expect(md).toContain("Beta Industries");
    expect(md).toContain("Gamma LLC");
    // Skills: the security group leads and the cloud line is gone.
    expect(md.indexOf("Threat modeling")).toBeLessThan(
      md.indexOf("Python (expert)"),
    );
    expect(md).not.toContain("Cloud/Hosting");
  });

  it("renders the resume unmodified (with a warning) when there's no Highlights section", async () => {
    const db = freshDb();
    upsertJobs(db, [mockJob()]);
    const plainResumeDir = `/tmp/trailguide-tailor-plain-${Date.now()}`;
    await Bun.write(
      `${plainResumeDir}/resume.md`,
      "# Just a title\n\nNo sections here.\n",
    );
    const result = await tailorResume(db, "jsearch:1", {
      resumeDir: plainResumeDir,
      outputDir,
    });
    expect(result.ok).toBe(true);
    expect(
      result.warnings.some((w) => w.includes('no "Highlights" section')),
    ).toBe(true);
    rmSync(plainResumeDir, { recursive: true, force: true });
  });
});

describe("tailorOrRegenerate", () => {
  // Unreachable Ollama keeps these fast and offline: tailoring falls back to
  // an unmodified render, which is all the tracking logic needs.
  const offline = { resumePath, outputDir, ollamaHost: "http://127.0.0.1:1" };

  it("tailors a new .md the first time and records it against the listing", async () => {
    const db = freshDb();
    upsertJobs(db, [mockJob()]);
    const result = await tailorOrRegenerate(db, "jsearch:1", offline);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("tailored");
    expect(getTailoredResume(db, "jsearch:1")?.markdownPath).toBe(
      result.markdownPath,
    );
  });

  it("regenerates from the hand-edited .md on later calls instead of re-tailoring", async () => {
    const db = freshDb();
    upsertJobs(db, [mockJob()]);
    const first = await tailorOrRegenerate(db, "jsearch:1", offline);
    const markdownPath = first.markdownPath ?? "";
    const edited = (await Bun.file(markdownPath).text()).replace(
      "Owned widget infrastructure end to end",
      "Hand-edited bullet about widgets",
    );
    await Bun.write(markdownPath, edited);

    const second = await tailorOrRegenerate(db, "jsearch:1", offline);
    expect(second.ok).toBe(true);
    expect(second.action).toBe("regenerated");
    expect(second.markdownPath).toBe(markdownPath);
    // The .md is left alone, and the render is built from the edit.
    expect(await Bun.file(markdownPath).text()).toBe(edited);
    const typ = await Bun.file(markdownPath.replace(/\.md$/, ".typ")).text();
    expect(typ).toContain("Hand-edited bullet about widgets");
    expect(typ).not.toContain("Owned widget infrastructure end to end");
  });

  it("keeps hand-added text the resume structure doesn't model", async () => {
    const db = freshDb();
    upsertJobs(db, [mockJob()]);
    const first = await tailorOrRegenerate(db, "jsearch:1", offline);
    const markdownPath = first.markdownPath ?? "";
    const original = await Bun.file(markdownPath).text();
    // Unedited: no fallback warning.
    const clean = await regenerateResume(db, "jsearch:1");
    expect(
      clean.warnings.filter((w) => !w.startsWith("PDF render failed")),
    ).toEqual([]);

    await Bun.write(
      markdownPath,
      original.replace(
        /(#+ \**Highlights\**\n)/,
        "$1\nA hand-written intro paragraph.\n",
      ),
    );
    const edited = await regenerateResume(db, "jsearch:1");
    expect(edited.warnings.some((w) => w.includes("rendered verbatim"))).toBe(
      true,
    );
    const typ = await Bun.file(markdownPath.replace(/\.md$/, ".typ")).text();
    expect(typ).toContain("A hand-written intro paragraph.");
  });

  it("re-tailors when the tracked .md has been deleted", async () => {
    const db = freshDb();
    upsertJobs(db, [mockJob()]);
    const first = await tailorOrRegenerate(db, "jsearch:1", offline);
    rmSync(first.markdownPath ?? "");
    const second = await tailorOrRegenerate(db, "jsearch:1", offline);
    expect(second.action).toBe("tailored");
    expect(await Bun.file(second.markdownPath ?? "").exists()).toBe(true);
  });

  it("re-tailors over an existing .md when asked for a fresh one", async () => {
    const db = freshDb();
    upsertJobs(db, [mockJob()]);
    const first = await tailorOrRegenerate(db, "jsearch:1", offline);
    await Bun.write(first.markdownPath ?? "", "# scribbles\n");
    const second = await tailorOrRegenerate(db, "jsearch:1", {
      ...offline,
      fresh: true,
    });
    expect(second.action).toBe("tailored");
    expect(await Bun.file(second.markdownPath ?? "").text()).toContain(
      "Owned widget infrastructure end to end",
    );
  });

  it("never lets two listings with the same company and title share a .md", async () => {
    const db = freshDb();
    upsertJobs(db, [mockJob({ sourceId: "1" }), mockJob({ sourceId: "2" })]);
    const a = await tailorOrRegenerate(db, "jsearch:1", offline);
    const b = await tailorOrRegenerate(db, "jsearch:2", offline);
    expect(a.markdownPath).not.toBe(b.markdownPath);
    // And re-tailoring the first keeps its original name.
    const again = await tailorOrRegenerate(db, "jsearch:1", {
      ...offline,
      fresh: true,
    });
    expect(again.markdownPath).toBe(a.markdownPath);
  });

  it("regenerateResume fails clearly when nothing has been tailored yet", async () => {
    const db = freshDb();
    upsertJobs(db, [mockJob()]);
    const result = await regenerateResume(db, "jsearch:1");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/tailor it first/);
  });
});

describe("resume selection by trail", () => {
  const offline = { outputDir, ollamaHost: "http://127.0.0.1:1" };
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function masters(files: Record<string, string>): Promise<string> {
    dir = `/tmp/trailguide-tailor-trails-${Date.now()}-${++counter}`;
    for (const [name, title] of Object.entries(files)) {
      await Bun.write(`${dir}/${name}`, `# ${title}\n\nNo sections here.\n`);
    }
    return dir;
  }

  it("uses <trail>.md for a job with a trail", async () => {
    const resumeDir = await masters({
      "platform.md": "Platform",
      "secplat.md": "Security",
    });
    const db = freshDb();
    upsertJobs(db, [mockJob({ trail: "secplat" })]);
    const result = await tailorResume(db, "jsearch:1", {
      ...offline,
      resumeDir,
    });
    expect(result.ok).toBe(true);
    expect(await Bun.file(result.markdownPath ?? "").text()).toContain(
      "# Security",
    );
  });

  it("fails clearly when the trail's master is missing", async () => {
    const resumeDir = await masters({ "platform.md": "Platform" });
    const db = freshDb();
    upsertJobs(db, [mockJob({ trail: "secplat" })]);
    const result = await tailorResume(db, "jsearch:1", {
      ...offline,
      resumeDir,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no resume for trail "secplat"/);
  });

  it("uses default.md for a job without a trail", async () => {
    const resumeDir = await masters({
      "default.md": "Default",
      "platform.md": "Platform",
    });
    const db = freshDb();
    upsertJobs(db, [mockJob()]);
    const result = await tailorResume(db, "jsearch:1", {
      ...offline,
      resumeDir,
    });
    expect(await Bun.file(result.markdownPath ?? "").text()).toContain(
      "# Default",
    );
  });

  it("refuses to guess between several masters without a trail", async () => {
    const resumeDir = await masters({ "a.md": "A", "b.md": "B" });
    const db = freshDb();
    upsertJobs(db, [mockJob()]);
    const result = await tailorResume(db, "jsearch:1", {
      ...offline,
      resumeDir,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/multiple resumes .* no trail/);
  });
});
