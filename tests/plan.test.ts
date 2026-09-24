import { describe, expect, it } from "bun:test";
import { applyPlan, sanitizePlan } from "../src/tailor/plan.ts";
import { parseResume, toMarkdown } from "../src/tailor/resumeDoc.ts";

const fixturePath = new URL("./fixtures/resume-sample.md", import.meta.url);
const fixture = await Bun.file(fixturePath).text();

function ids(doc: ReturnType<typeof parseResume>) {
  const highlights = doc.sections.find((s) => s.kind === "highlights");
  const experience = doc.sections.find((s) => s.kind === "experience");
  const skills = doc.sections.find((s) => s.kind === "skills");
  return {
    skillGroups:
      skills?.kind === "skills"
        ? skills.groups.map((g) => ({
            id: g.id,
            bulletIds: g.bullets.map((b) => b.id),
          }))
        : [],
    highlightIds:
      highlights?.kind === "highlights"
        ? highlights.bullets.map((b) => b.id)
        : [],
    jobs:
      experience?.kind === "experience"
        ? experience.entries.map((e) => ({
            id: e.id,
            bulletIds: e.bullets.map((b) => b.id),
          }))
        : [],
  };
}

describe("sanitizePlan", () => {
  it("accepts a well-formed plan as-is", () => {
    const doc = parseResume(fixture);
    const { highlightIds, jobs } = ids(doc);
    const acme = jobs[0];
    if (!acme) throw new Error("expected acme job");
    const { skillGroups } = ids(doc);
    const raw = {
      highlightOrder: [...highlightIds].reverse(),
      experience: jobs.map((j) => ({
        id: j.id,
        bulletOrder:
          j.id === acme.id ? [...j.bulletIds].reverse() : j.bulletIds,
      })),
      skillGroupOrder: skillGroups.map((g) => g.id),
      skills: skillGroups.map((g) => ({ id: g.id, bulletOrder: g.bulletIds })),
    };
    const { plan, warnings } = sanitizePlan(doc, raw);
    expect(plan.highlightOrder).toEqual([...highlightIds].reverse());
    expect(plan.experience.find((e) => e.id === acme.id)?.bulletOrder).toEqual(
      [...acme.bulletIds].reverse(),
    );
    expect(warnings).toEqual([]);
  });

  it("drops ids the model invented and warns, falling back to original order for that job", () => {
    const doc = parseResume(fixture);
    const { jobs } = ids(doc);
    const acme = jobs[0];
    if (!acme) throw new Error("expected acme job");
    const raw = {
      highlightOrder: ["totally-made-up"],
      experience: [{ id: acme.id, bulletOrder: ["nonexistent-bullet"] }],
    };
    const { plan, warnings } = sanitizePlan(doc, raw);
    expect(plan.highlightOrder).not.toContain("totally-made-up");
    expect(plan.experience.find((e) => e.id === acme.id)?.bulletOrder).toEqual(
      acme.bulletIds,
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("falls back to the original resume, unchanged, for garbage/non-JSON model output", () => {
    const doc = parseResume(fixture);
    const { highlightIds, jobs } = ids(doc);
    const { plan, warnings } = sanitizePlan(doc, "not even an object");
    expect(plan.highlightOrder).toEqual(highlightIds);
    for (const job of jobs) {
      expect(plan.experience.find((e) => e.id === job.id)?.bulletOrder).toEqual(
        job.bulletIds,
      );
    }
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("always covers every job present in the resume, even if the model omitted one", () => {
    const doc = parseResume(fixture);
    const { jobs } = ids(doc);
    const { plan } = sanitizePlan(doc, { highlightOrder: [], experience: [] });
    expect(plan.experience.map((e) => e.id).sort()).toEqual(
      jobs.map((j) => j.id).sort(),
    );
  });

  it("keeps every skills group even when the model's order only mentions one", () => {
    const doc = parseResume(fixture);
    const { skillGroups } = ids(doc);
    const security = skillGroups[1];
    if (!security) throw new Error("expected a second skills group");
    const { plan } = sanitizePlan(doc, { skillGroupOrder: [security.id] });
    expect(plan.skillGroupOrder[0]).toBe(security.id);
    expect([...plan.skillGroupOrder].sort()).toEqual(
      skillGroups.map((g) => g.id).sort(),
    );
  });

  it("drops invented skills line ids, keeping that group's original lines", () => {
    const doc = parseResume(fixture);
    const { skillGroups } = ids(doc);
    const technical = skillGroups[0];
    if (!technical) throw new Error("expected a technical skills group");
    const { plan, warnings } = sanitizePlan(doc, {
      skills: [{ id: technical.id, bulletOrder: ["skill9_9"] }],
    });
    expect(plan.skills.find((s) => s.id === technical.id)?.bulletOrder).toEqual(
      technical.bulletIds,
    );
    expect(warnings.some((w) => /skills group/.test(w.message))).toBe(true);
  });
});

describe("applyPlan", () => {
  it("reorders and filters bullets without introducing any new text", () => {
    const doc = parseResume(fixture);
    const { highlightIds, jobs } = ids(doc);
    const acme = jobs[0];
    if (!acme) throw new Error("expected acme job");
    const { plan } = sanitizePlan(doc, {
      highlightOrder: [highlightIds[2], highlightIds[0]],
      experience: [{ id: acme.id, bulletOrder: [acme.bulletIds[1]] }],
    });
    const tailored = applyPlan(doc, plan);
    const md = toMarkdown(tailored);
    expect(md).toContain("Cut deploy time from an hour to five minutes");
    expect(md).not.toContain("Owned widget infrastructure end to end");
    expect(md).not.toContain("Mentored two junior engineers");
  });

  // The two cases issue #36 names: for a job that doesn't care about cloud
  // hosting, pull that line; for a security role, lead with security.
  it("prunes an irrelevant skills line and lifts the relevant group to the top", () => {
    const doc = parseResume(fixture);
    const { skillGroups } = ids(doc);
    const technical = skillGroups[0];
    const security = skillGroups[1];
    if (!technical || !security) throw new Error("expected two skills groups");
    const { plan } = sanitizePlan(doc, {
      skillGroupOrder: [security.id, technical.id],
      skills: [
        {
          id: technical.id,
          // Languages and CI/CD, no Cloud/Hosting.
          bulletOrder: [technical.bulletIds[0], technical.bulletIds[2]],
        },
      ],
    });
    const md = toMarkdown(applyPlan(doc, plan));
    expect(md).not.toContain("Cloud/Hosting");
    expect(md).toContain("Python (expert)");
    expect(md).toContain("Docker, Terraform, GitHub Actions");
    expect(md.indexOf("Threat modeling")).toBeLessThan(
      md.indexOf("Python (expert)"),
    );
  });

  it("never drops a skills group outright, even one the model ignored", () => {
    const doc = parseResume(fixture);
    const { skillGroups } = ids(doc);
    const security = skillGroups[1];
    if (!security) throw new Error("expected a second skills group");
    const { plan } = sanitizePlan(doc, { skillGroupOrder: [security.id] });
    const md = toMarkdown(applyPlan(doc, plan));
    expect(md).toContain("**Technical**");
    expect(md).toContain("### **Security**");
    expect(md).toContain("Python (expert)");
  });

  it("never drops an employer or alters dates/titles", () => {
    const doc = parseResume(fixture);
    const { highlightIds, jobs } = ids(doc);
    const { plan } = sanitizePlan(doc, {
      highlightOrder: highlightIds,
      experience: [],
    });
    const tailored = applyPlan(doc, plan);
    const md = toMarkdown(tailored);
    for (const heading of ["Acme Corp", "Beta Industries", "Gamma LLC"]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain("Senior Widget Engineer");
    expect(jobs).toHaveLength(3);
  });
});
