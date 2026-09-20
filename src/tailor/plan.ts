import type { Bullet, GroupedEntry, ResumeDoc } from "./resumeDoc.ts";

// A tailoring plan is *only* allowed to select and reorder bullets that
// already exist in the parsed resume, by id. It can never carry new text -
// that's what makes it safe to apply a plan produced by a small local model
// without a human proofreading every word first.

/** Which bullets of one group (an employer, a skills group) to keep, in order. */
export interface BulletPlanEntry {
  id: string;
  bulletOrder: string[];
}

export type ExperiencePlanEntry = BulletPlanEntry;

export interface TailorPlan {
  highlightOrder: string[];
  experience: ExperiencePlanEntry[];
  /**
   * Skills groups ("Technical", "Cyber Security", ...) in the order they
   * should appear. Always covers every group - groups are reordered, never
   * dropped; it's the lines inside them that get pruned.
   */
  skillGroupOrder: string[];
  skills: BulletPlanEntry[];
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

/** Indexes a model's raw per-group entries by the group id it claimed. */
function planEntriesById(raw: unknown): Map<string, { bulletOrder?: unknown }> {
  const byId = new Map<string, { bulletOrder?: unknown }>();
  if (!Array.isArray(raw)) return byId;
  for (const entry of raw) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).id === "string"
    ) {
      byId.set(
        (entry as { id: string }).id,
        entry as { bulletOrder?: unknown },
      );
    }
  }
  return byId;
}

/**
 * Sanitizes the model's per-group bullet selections against the groups that
 * actually exist. Every group gets an entry whether the model mentioned it
 * or not; a group the model left out (or filled with unknown ids) keeps its
 * original bullets rather than losing them.
 */
function sanitizeGroupBullets(
  groups: GroupedEntry[],
  raw: unknown,
  describe: (group: GroupedEntry) => string,
  warnings: SanitizeWarning[],
): BulletPlanEntry[] {
  const planById = planEntriesById(raw);
  const result: BulletPlanEntry[] = [];
  for (const group of groups) {
    const knownBulletIds = new Set(group.bullets.map((b) => b.id));
    const rawEntry = planById.get(group.id);
    let bulletOrder = rawEntry
      ? dedupeKnownIds(rawEntry.bulletOrder, knownBulletIds)
      : [];
    if (bulletOrder.length === 0 && knownBulletIds.size > 0) {
      warnings.push({
        message: `model returned no usable bullet order for ${describe(group)}; kept original bullets`,
      });
      bulletOrder = [...knownBulletIds];
    }
    result.push({ id: group.id, bulletOrder });
  }
  return result;
}

/** A skills group's heading, stripped to something readable in a warning. */
function skillGroupLabel(group: GroupedEntry): string {
  const name = group.heading
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/, "")
    .trim();
  return name.length > 0 ? `skills group "${name}"` : "the skills section";
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

  const jobs =
    experienceSection?.kind === "experience" ? experienceSection.entries : [];
  const experience = sanitizeGroupBullets(
    jobs,
    rawObj.experience,
    (job) => `"${job.heading}"`,
    warnings,
  );

  // Skills groups, unlike employers, may be reordered - but never dropped,
  // so any group the model left out is appended in its original position
  // relative to the rest.
  const skillsSection = doc.sections.find((s) => s.kind === "skills");
  const skillGroups =
    skillsSection?.kind === "skills" ? skillsSection.groups : [];
  const knownGroupIds = new Set(skillGroups.map((g) => g.id));
  const skillGroupOrder = dedupeKnownIds(rawObj.skillGroupOrder, knownGroupIds);
  if (skillGroupOrder.length === 0 && knownGroupIds.size > 1) {
    warnings.push({
      message:
        "model returned no usable skills group order; kept original order",
    });
  }
  for (const id of knownGroupIds) {
    if (!skillGroupOrder.includes(id)) skillGroupOrder.push(id);
  }

  const skills = sanitizeGroupBullets(
    skillGroups,
    rawObj.skills,
    skillGroupLabel,
    warnings,
  );

  return {
    plan: { highlightOrder, experience, skillGroupOrder, skills },
    warnings,
  };
}

/** Reorders/filters bullets by id, falling back to the originals if that leaves nothing. */
function reorderBullets(
  bullets: Bullet[],
  order: string[] | undefined,
): Bullet[] {
  if (!order || order.length === 0) return bullets;
  const byId = new Map(bullets.map((b) => [b.id, b]));
  const picked = order
    .map((id) => byId.get(id))
    .filter((b): b is Bullet => b !== undefined);
  return picked.length > 0 ? picked : bullets;
}

/**
 * Applies a (already-sanitized) plan to a resume, returning a new document
 * with Highlights, each job's bullets, and the Skills section's groups and
 * lines reordered/filtered accordingly. Every other section - including
 * which employers appear and their dates/titles - is untouched.
 */
export function applyPlan(doc: ResumeDoc, plan: TailorPlan): ResumeDoc {
  const bulletOrderByJob = new Map(
    plan.experience.map((e) => [e.id, e.bulletOrder]),
  );
  const bulletOrderBySkillGroup = new Map(
    plan.skills.map((e) => [e.id, e.bulletOrder]),
  );

  const sections = doc.sections.map((section) => {
    if (section.kind === "highlights") {
      return {
        ...section,
        bullets: reorderBullets(section.bullets, plan.highlightOrder),
      };
    }
    if (section.kind === "experience") {
      const entries = section.entries.map((entry) => ({
        ...entry,
        bullets: reorderBullets(entry.bullets, bulletOrderByJob.get(entry.id)),
      }));
      return { ...section, entries };
    }
    if (section.kind === "skills") {
      const byId = new Map(section.groups.map((g) => [g.id, g]));
      const ordered = plan.skillGroupOrder
        .map((id) => byId.get(id))
        .filter((g): g is GroupedEntry => g !== undefined);
      const groups = (ordered.length > 0 ? ordered : section.groups).map(
        (group) => ({
          ...group,
          bullets: reorderBullets(
            group.bullets,
            bulletOrderBySkillGroup.get(group.id),
          ),
        }),
      );
      return { ...section, groups };
    }
    return section;
  });

  return { ...doc, sections };
}
