import type { ResumeDoc } from "./resumeDoc.ts";

// A tailoring plan is *only* allowed to select and reorder bullets that
// already exist in the parsed resume, by id. It can never carry new text -
// that's what makes it safe to apply a plan produced by a small local model
// without a human proofreading every word first.

export interface ExperiencePlanEntry {
  id: string;
  bulletOrder: string[];
}

export interface TailorPlan {
  highlightOrder: string[];
  experience: ExperiencePlanEntry[];
}

export interface SanitizeWarning {
  message: string;
}

export interface SanitizeResult {
  plan: TailorPlan;
  warnings: SanitizeWarning[];
}

function dedupeKnownIds(ids: unknown, known: Set<string>): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * Validates and clamps a model's raw plan output against the actual resume.
 * Any id the model invented, misspelled, or duplicated is silently dropped;
 * any job or bullet the model omitted falls back to its original order
 * unchanged. The result is always safe to apply - worst case, a section
 * simply isn't reordered, never that unknown content gets rendered.
 */
export function sanitizePlan(doc: ResumeDoc, raw: unknown): SanitizeResult {
  const warnings: SanitizeWarning[] = [];
  const highlightsSection = doc.sections.find((s) => s.kind === "highlights");
  const experienceSection = doc.sections.find((s) => s.kind === "experience");

  const knownHighlightIds = new Set(
    highlightsSection?.kind === "highlights"
      ? highlightsSection.bullets.map((b) => b.id)
      : [],
  );
  const originalHighlightOrder = [...knownHighlightIds];

  const rawObj =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};

  let highlightOrder = dedupeKnownIds(rawObj.highlightOrder, knownHighlightIds);
  if (highlightOrder.length === 0 && knownHighlightIds.size > 0) {
    warnings.push({
      message: "model returned no usable highlight order; kept original order",
    });
    highlightOrder = originalHighlightOrder;
  }

  const jobsById = new Map(
    experienceSection?.kind === "experience"
      ? experienceSection.entries.map((e) => [e.id, e])
      : [],
  );
  const rawExperience = Array.isArray(rawObj.experience)
    ? rawObj.experience
    : [];
  const planByJobId = new Map<string, unknown>();
  for (const entry of rawExperience) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).id === "string"
    ) {
      planByJobId.set((entry as { id: string }).id, entry);
    }
  }

  const experience: ExperiencePlanEntry[] = [];
  for (const [jobId, job] of jobsById) {
    const knownBulletIds = new Set(job.bullets.map((b) => b.id));
    const rawEntry = planByJobId.get(jobId) as
      | { bulletOrder?: unknown }
      | undefined;
    let bulletOrder = rawEntry
      ? dedupeKnownIds(rawEntry.bulletOrder, knownBulletIds)
      : [];
    if (bulletOrder.length === 0 && knownBulletIds.size > 0) {
      warnings.push({
        message: `model returned no usable bullet order for "${job.heading}"; kept original bullets`,
      });
      bulletOrder = [...knownBulletIds];
    }
    experience.push({ id: jobId, bulletOrder });
  }

  return { plan: { highlightOrder, experience }, warnings };
}

/**
 * Applies a (already-sanitized) plan to a resume, returning a new document
 * with Highlights and each job's bullets reordered/filtered accordingly.
 * Every other section - including which employers appear and their
 * dates/titles - is untouched.
 */
export function applyPlan(doc: ResumeDoc, plan: TailorPlan): ResumeDoc {
  const bulletOrderByJob = new Map(
    plan.experience.map((e) => [e.id, e.bulletOrder]),
  );

  const sections = doc.sections.map((section) => {
    if (section.kind === "highlights") {
      const byId = new Map(section.bullets.map((b) => [b.id, b]));
      const bullets = plan.highlightOrder
        .map((id) => byId.get(id))
        .filter((b): b is NonNullable<typeof b> => b !== undefined);
      return {
        ...section,
        bullets: bullets.length > 0 ? bullets : section.bullets,
      };
    }
    if (section.kind === "experience") {
      const entries = section.entries.map((entry) => {
        const order = bulletOrderByJob.get(entry.id);
        if (!order || order.length === 0) return entry;
        const byId = new Map(entry.bullets.map((b) => [b.id, b]));
        const bullets = order
          .map((id) => byId.get(id))
          .filter((b): b is NonNullable<typeof b> => b !== undefined);
        return {
          ...entry,
          bullets: bullets.length > 0 ? bullets : entry.bullets,
        };
      });
      return { ...section, entries };
    }
    return section;
  });

  return { ...doc, sections };
}
