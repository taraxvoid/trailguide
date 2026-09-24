import type { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  getJob,
  getTailoredResume,
  setTailoredResume,
  tailoredResumeOwner,
} from "../db.ts";
import {
  isModelAvailable,
  requestTailorPlan,
  resolveOllamaHost,
  resolveOllamaModel,
} from "./ollama.ts";
import { applyPlan, sanitizePlan } from "./plan.ts";
import { parseResume, toMarkdown } from "./resumeDoc.ts";
import type { ResumeDoc } from "./resumeDoc.ts";
import { renderResumePdf } from "./typst.ts";

// Orchestrates the "tailor this resume to this job" action: find the
// master resume, ask a local model how to reorder/select its bullets for
// this job, apply that (sanitized) plan, and render both a tailored .md and
// .pdf. Shared by the CLI (`igor tailor`) and the TUI's ctrl+T so both get
// the same sanity checks and the same graceful fallbacks.
//
// The tailored .md is recorded against the listing and becomes the
// canonical resume for that job: it's meant to be hand-edited afterwards,
// so once it exists `tailorOrRegenerate` only re-renders the PDF from it
// (`regenerateResume`) instead of re-tailoring from the master.
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
  /** Whether a fresh tailored .md was generated or an existing one re-rendered. */
  action?: "tailored" | "regenerated";
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
    (s) =>
      s.kind === "highlights" || s.kind === "experience" || s.kind === "skills",
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
  const markdownPath = tailoredMarkdownPath(
    db,
    listingId,
    outputDir,
    slugify(`${job.company}-${job.title}`),
  );

  await Bun.write(markdownPath, toMarkdown(tailoredDoc));
  setTailoredResume(db, listingId, markdownPath);

  return renderPdf(tailoredDoc, markdownPath, "tailored", warnings);
}

/**
 * Picks where a listing's tailored .md goes. Two listings can share a
 * company+title slug, and since the .md is hand-edited after generation,
 * tailoring one must never overwrite the other's: fall back to a
 * listing-specific name when the plain one is already claimed.
 */
function tailoredMarkdownPath(
  db: Database,
  listingId: string,
  outputDir: string,
  slug: string,
): string {
  const plain = resolve(outputDir, `${slug}.md`);
  const owner = tailoredResumeOwner(db, plain);
  if (owner === null || owner === listingId) return plain;
  return resolve(outputDir, `${slug}-${slugify(listingId)}.md`);
}

async function renderPdf(
  doc: ResumeDoc,
  markdownPath: string,
  action: "tailored" | "regenerated",
  warnings: string[],
): Promise<TailorResult> {
  const pdfPath = markdownPath.replace(/\.md$/, ".pdf");
  const renderResult = await renderResumePdf(doc, pdfPath);
  if (!renderResult.ok) {
    warnings.push(
      `PDF render failed: ${renderResult.stderr || "unknown typst error"}`,
    );
    return { ok: true, action, markdownPath, warnings };
  }
  return { ok: true, action, markdownPath, pdfPath, warnings };
}

/**
 * Re-renders a listing's PDF from its tracked tailored .md as it currently
 * stands on disk (including any hand edits), without touching the model or
 * the resume master.
 */
export async function regenerateResume(
  db: Database,
  listingId: string,
): Promise<TailorResult> {
  const warnings: string[] = [];
  const record = getTailoredResume(db, listingId);
  if (!record) {
    return {
      ok: false,
      warnings,
      error: `no tailored resume recorded for ${listingId} - tailor it first`,
    };
  }
  const file = Bun.file(record.markdownPath);
  if (!(await file.exists())) {
    return {
      ok: false,
      warnings,
      error: `tailored resume not found: ${record.markdownPath}`,
    };
  }
  const source = await file.text();
  if (source.trim().length === 0) {
    return {
      ok: false,
      warnings,
      error: `tailored resume is empty: ${record.markdownPath}`,
    };
  }
  // The structured parse only keeps what tailoring understands (e.g. bullets
  // under Highlights), so a hand edit outside that shape would silently
  // vanish from the PDF. Generated markdown always round-trips; if the edited
  // file doesn't, render it verbatim instead so every line survives.
  let doc = parseResume(source);
  if (collapse(toMarkdown(doc)) !== collapse(source)) {
    warnings.push(
      "some of the edited markdown doesn't fit the resume structure, so it was rendered verbatim (styling may differ slightly).",
    );
    doc = { header: source, sections: [] };
  }
  return renderPdf(doc, record.markdownPath, "regenerated", warnings);
}

function collapse(markdown: string): string {
  return markdown.replace(/\s+/g, " ").trim();
}

/**
 * The ctrl+T / `igor tailor` action: regenerates the PDF from the job's
 * tailored .md if one exists, otherwise tailors a new one from the master.
 * A tracked .md that has since been deleted counts as not existing.
 */
export async function tailorOrRegenerate(
  db: Database,
  listingId: string,
  options: TailorOptions & { fresh?: boolean } = {},
): Promise<TailorResult> {
  const record = options.fresh ? null : getTailoredResume(db, listingId);
  if (record && (await Bun.file(record.markdownPath).exists())) {
    return regenerateResume(db, listingId);
  }
  return tailorResume(db, listingId, options);
}
