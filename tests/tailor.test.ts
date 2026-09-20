import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { openDb, upsertJobs } from "../src/db.ts";
import type { NormalizedJob } from "../src/sources/types.ts";
import { tailorResume } from "../src/tailor/index.ts";

let counter = 0;
function freshDb() {
  const path = `/tmp/igor-tailor-test-${Date.now()}-${++counter}.db`;
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

const outputDir = `/tmp/igor-tailor-test-output-${Date.now()}`;
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
    expect(result.warnings).toEqual([]);
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
    const plainResumeDir = `/tmp/igor-tailor-plain-${Date.now()}`;
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
