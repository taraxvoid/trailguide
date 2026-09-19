import type { ResumeDoc } from "./resumeDoc.ts";

// Talks to a local Ollama daemon to decide how to tailor a resume: which
// Highlights bullets to lead with, and which accomplishment bullets to
// surface (and in what order) under each job. The model only ever chooses
// among existing bullet ids - see plan.ts for why that's what makes this
// safe to apply without a human proofreading every word first.

export const DEFAULT_OLLAMA_MODEL = "qwen3:8b";

/** Mirrors Ollama's own OLLAMA_HOST convention: "host:port" or a full URL. */
export function resolveOllamaHost(raw = process.env.OLLAMA_HOST): string {
  const value = raw?.trim();
  if (!value) return "http://127.0.0.1:11434";
  return /^https?:\/\//.test(value) ? value : `http://${value}`;
}

export function resolveOllamaModel(raw = process.env.OLLAMA_MODEL): string {
  return raw?.trim() || DEFAULT_OLLAMA_MODEL;
}

const PLAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    highlightOrder: { type: "array", items: { type: "string" } },
    experience: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          bulletOrder: { type: "array", items: { type: "string" } },
        },
        required: ["id", "bulletOrder"],
      },
    },
  },
  required: ["highlightOrder", "experience"],
} as const;

interface PlanBullet {
  id: string;
  text: string;
}
interface PlanJob {
  id: string;
  employer: string;
  bullets: PlanBullet[];
}
interface PlanContext {
  highlights: PlanBullet[];
  jobs: PlanJob[];
}

/** Strips a bullet's leading markdown list marker for a cleaner prompt. */
function plainBulletText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*-\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
}

/** Extracts only the tailorable content (ids + bullet text) from a resume. */
export function buildPlanContext(doc: ResumeDoc): PlanContext {
  const highlightsSection = doc.sections.find((s) => s.kind === "highlights");
  const experienceSection = doc.sections.find((s) => s.kind === "experience");

  return {
    highlights:
      highlightsSection?.kind === "highlights"
        ? highlightsSection.bullets.map((b) => ({
            id: b.id,
            text: plainBulletText(b.text),
          }))
        : [],
    jobs:
      experienceSection?.kind === "experience"
        ? experienceSection.entries.map((e) => ({
            id: e.id,
            employer: e.heading
              .replace(/\*\*/g, "")
              .replace(/^#+\s*/, "")
              .trim(),
            bullets: e.bullets.map((b) => ({
              id: b.id,
              text: plainBulletText(b.text),
            })),
          }))
        : [],
  };
}

const SYSTEM_PROMPT = `You help tailor a resume to a specific job posting by choosing which existing bullet points to lead with - you never write new content.

You will be given the target job, then the resume's Highlights bullets and each employer's accomplishment bullets, each with a short id.

Return JSON selecting and ordering those ids, most relevant to this job first:
- "highlightOrder": the Highlights bullet ids, reordered (you may drop clearly irrelevant ones).
- "experience": one entry per employer id given to you, each with that employer's bullet ids reordered (you may drop the least relevant ones from older/less-relevant jobs, but keep at least 2 when that many exist).

Rules:
- Only use ids you were given. Never invent an id or new text.
- Include every employer id you were given in "experience", even if its bulletOrder just repeats the original order unchanged.
- Do not reorder or omit employers themselves - only their bullets.`;

function buildUserPrompt(
  job: { title: string; company: string; description: string | null },
  context: PlanContext,
): string {
  return [
    `Target job: ${job.title} at ${job.company}`,
    job.description
      ? `Job description:\n${job.description}`
      : "(no job description available)",
    `Highlights:\n${JSON.stringify(context.highlights)}`,
    `Employers (in original, unchangeable order):\n${JSON.stringify(context.jobs)}`,
  ].join("\n\n");
}

export interface RequestPlanOptions {
  host?: string;
  model?: string;
  /** Overridable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Asks Ollama for a tailoring plan. Returns the raw parsed JSON response
 * body from the model - callers must run it through {@link sanitizePlan}
 * (see plan.ts) before applying it, since nothing here guarantees the model
 * actually respected the id-only rule.
 */
export async function requestTailorPlan(
  job: { title: string; company: string; description: string | null },
  doc: ResumeDoc,
  options: RequestPlanOptions = {},
): Promise<unknown> {
  const host = resolveOllamaHost(options.host);
  const model = resolveOllamaModel(options.model);
  const doFetch = options.fetchImpl ?? fetch;
  const context = buildPlanContext(doc);

  let response: Response;
  try {
    response = await doFetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(job, context) },
        ],
        think: true,
        stream: false,
        format: PLAN_JSON_SCHEMA,
      }),
    });
  } catch (err) {
    throw new Error(
      `couldn't reach Ollama at ${host} (is \`ollama serve\` running?): ${(err as Error).message}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Ollama returned ${response.status} ${response.statusText}: ${body}`,
    );
  }

  const payload = (await response.json()) as { message?: { content?: string } };
  const content = payload.message?.content;
  if (!content) throw new Error("Ollama response had no message content");

  try {
    return JSON.parse(content);
  } catch {
    throw new Error(
      `Ollama response wasn't valid JSON: ${content.slice(0, 200)}`,
    );
  }
}

/** True if the given model is present in `ollama list`, false if Ollama is unreachable or the model is missing. */
export async function isModelAvailable(
  model: string,
  host = resolveOllamaHost(),
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${host}/api/tags`);
    if (!response.ok) return false;
    const body = (await response.json()) as {
      models?: Array<{ name: string }>;
    };
    return (body.models ?? []).some(
      (m) => m.name === model || m.name === `${model}:latest`,
    );
  } catch {
    return false;
  }
}
