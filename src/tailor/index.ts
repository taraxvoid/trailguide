import type { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { getJob } from "../db.ts";
import {
  isModelAvailable,
  requestTailorPlan,
  resolveOllamaHost,
  resolveOllamaModel,
} from "./ollama.ts";
import { applyPlan, sanitizePlan } from "./plan.ts";
import { parseResume, toMarkdown } from "./resumeDoc.ts";
import { renderResumePdf } from "./typst.ts";

// Orchestrates the "tailor this resume to this job" action: find the
// master resume, ask a local model how to reorder/select its bullets for
// this job, apply that (sanitized) plan, and render both a tailored .md and
// .pdf. Shared by the CLI (`igor tailor`) and the TUI's `t` key so both get
// the same sanity checks and the same graceful fallbacks.
//
// Every failure mode short of "the job doesn't exist" or "there's no
// resume to tailor" degrades to still producing an untailored-but-correct
// resume rather than nothing at all - see the inline comments below for
// which situations do that.

export interface TailorOptions {
  resumeDir?: string;
  resumePath?: string;
  outputDir?: string;
  ollamaHost?: string;
  ollamaModel?: string;
  /** Overridable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface TailorResult {
  ok: boolean;
  markdownPath?: string;
  pdfPath?: string;
  warnings: string[];
  error?: string;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "resume"
  );
}

/**
 * Finds the resume master file. There's deliberately no hardcoded personal
 * filename in this codebase - it looks for the one `.md` file under
 * `input/` (gitignored; see README) unless a path is given explicitly.
 */
async function resolveResumePath(options: TailorOptions): Promise<string> {
  if (options.resumePath) return options.resumePath;
  const dir = options.resumeDir ?? "input";
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    throw new Error(
      `no "${dir}/" directory found. Put your resume master at ${dir}/<name>.md (this directory is gitignored).`,
    );
  }
  const candidates = entries.filter((f) => f.endsWith(".md"));
  if (candidates.length === 0) {
    throw new Error(
      `no .md resume found in ${dir}/. Put your resume master at ${dir}/<name>.md.`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `multiple .md files in ${dir}/ (${candidates.join(", ")}) - pass --resume <path> to pick one.`,
    );
  }
  return `${dir}/${candidates[0]}`;
}

export async function tailorResume(
  db: Database,
  listingId: string,
  options: TailorOptions = {},
): Promise<TailorResult> {
  const warnings: string[] = [];

  const job = getJob(db, listingId);
  if (!job)
    return { ok: false, warnings, error: `no job found with id ${listingId}` };

  let resumePath: string;
  try {
    resumePath = await resolveResumePath(options);
  } catch (err) {
    return { ok: false, warnings, error: (err as Error).message };
  }

  const resumeFile = Bun.file(resumePath);
  if (!(await resumeFile.exists())) {
    return {
      ok: false,
      warnings,
      error: `resume file not found: ${resumePath}`,
    };
  }
  const source = await resumeFile.text();
  if (source.trim().length === 0) {
    return {
      ok: false,
      warnings,
      error: `resume file is empty: ${resumePath}`,
    };
  }

  const doc = parseResume(source);
  const hasTailorableSections = doc.sections.some(
    (s) => s.kind === "highlights" || s.kind === "experience",
  );

  let tailoredDoc = doc;
  if (!hasTailorableSections) {
    warnings.push(
      'no "Highlights" section found in the resume master - rendering it unmodified instead of tailoring.',
    );
  } else {
    const host = resolveOllamaHost(options.ollamaHost);
    const model = resolveOllamaModel(options.ollamaModel);
    const available = await isModelAvailable(model, host, options.fetchImpl);
    if (!available) {
      warnings.push(
        `Ollama model "${model}" isn't available at ${host} (is it pulled? try \`ollama pull ${model}\`) - rendering the resume unmodified instead of tailoring.`,
      );
    } else {
      try {
        const rawPlan = await requestTailorPlan(
          {
            title: job.title,
            company: job.company,
            description: job.description,
          },
          doc,
          { host, model, fetchImpl: options.fetchImpl },
        );
        const { plan, warnings: planWarnings } = sanitizePlan(doc, rawPlan);
        warnings.push(...planWarnings.map((w) => w.message));
        tailoredDoc = applyPlan(doc, plan);
      } catch (err) {
        warnings.push(
          `tailoring failed (${(err as Error).message}) - rendering the resume unmodified instead.`,
        );
      }
    }
  }

  const outputDir = options.outputDir ?? "output/resumes";
  const slug = slugify(`${job.company}-${job.title}`);
  const markdownPath = `${outputDir}/${slug}.md`;
  const pdfPath = `${outputDir}/${slug}.pdf`;

  await Bun.write(markdownPath, toMarkdown(tailoredDoc));

  const renderResult = await renderResumePdf(tailoredDoc, pdfPath);
  if (!renderResult.ok) {
    warnings.push(
      `PDF render failed: ${renderResult.stderr || "unknown typst error"}`,
    );
    return { ok: true, markdownPath, warnings };
  }

  return { ok: true, markdownPath, pdfPath, warnings };
}
