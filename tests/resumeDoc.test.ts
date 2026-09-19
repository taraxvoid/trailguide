import { describe, expect, it } from "bun:test";
import { parseResume, toMarkdown } from "../src/tailor/resumeDoc.ts";

const fixturePath = new URL("./fixtures/resume-sample.md", import.meta.url);
const fixture = await Bun.file(fixturePath).text();

describe("parseResume", () => {
  it("captures the title verbatim, keeping the legal-name/contact block as its own verbatim section", () => {
    const doc = parseResume(fixture);
    expect(doc.header).toContain("Sam \\\\Example/ Doe");
    const contactSection = doc.sections.find(
      (s) => s.kind === "verbatim" && s.raw.includes("Legal name"),
    );
    expect(contactSection).toBeDefined();
    if (contactSection?.kind === "verbatim") {
      expect(contactSection.raw).toContain("sam@example.com");
    }
  });

  it("parses Highlights as top-level bullets, folding nested sub-bullets into their parent", () => {
    const doc = parseResume(fixture);
    const highlights = doc.sections.find((s) => s.kind === "highlights");
    if (highlights?.kind !== "highlights")
      throw new Error("expected highlights section");
    expect(highlights.bullets).toHaveLength(3);
    expect(highlights.bullets[0]?.text).toContain("Developer Experience");
    expect(highlights.bullets[2]?.text).toContain("CI/CD Pipelines");
    // The nested Infrastructure/Programming lines stay glued to their parent.
    expect(highlights.bullets[2]?.text).toContain("Infrastructure");
    expect(highlights.bullets[2]?.text).toContain("Programming");
  });

  it("recovers the first employer's name when it's fused onto the section heading", () => {
    const doc = parseResume(fixture);
    const experience = doc.sections.find((s) => s.kind === "experience");
    if (experience?.kind !== "experience")
      throw new Error("expected experience section");
    expect(experience.entries).toHaveLength(3);
    expect(experience.entries[0]?.heading).toBe("**Acme Corp**");
    expect(experience.entries[0]?.preamble).toContain("Senior Widget Engineer");
  });

  it("treats a bold paragraph with no markdown heading as its own employer entry", () => {
    const doc = parseResume(fixture);
    const experience = doc.sections.find((s) => s.kind === "experience");
    if (experience?.kind !== "experience")
      throw new Error("expected experience section");
    const gamma = experience.entries[2];
    expect(gamma?.heading).toBe("**Gamma LLC**");
    expect(gamma?.bullets.map((b) => b.text)).toEqual([
      "- Learned the ropes",
      "- Shipped a small internal tool",
    ]);
  });

  it("drops an empty bullet line instead of producing a blank bullet", () => {
    const doc = parseResume(fixture);
    const experience = doc.sections.find((s) => s.kind === "experience");
    if (experience?.kind !== "experience")
      throw new Error("expected experience section");
    const beta = experience.entries[1];
    expect(beta?.bullets.map((b) => b.text)).toEqual([
      "- Built the first version of the widget pipeline",
      "- On-call rotation lead",
    ]);
  });

  it("assigns stable, unique ids to every bullet", () => {
    const doc = parseResume(fixture);
    const ids: string[] = [];
    for (const section of doc.sections) {
      if (section.kind === "highlights")
        ids.push(...section.bullets.map((b) => b.id));
      if (section.kind === "experience") {
        for (const entry of section.entries)
          ids.push(...entry.bullets.map((b) => b.id));
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("keeps non-tailorable sections (Education, Certifications, Skills) verbatim", () => {
    const doc = parseResume(fixture);
    const verbatim = doc.sections.filter((s) => s.kind === "verbatim");
    expect(verbatim).toHaveLength(4);
    const raws = verbatim
      .map((s) => (s.kind === "verbatim" ? s.raw : ""))
      .join("\n");
    expect(raws).toContain("Some Certification");
    expect(raws).toContain("Python (expert)");
  });

  it("returns an empty section list (never throws) for a document with no Highlights heading", () => {
    const doc = parseResume("# Just a title\n\nSome text, no sections here.\n");
    expect(doc.sections).toEqual([]);
    expect(doc.header).toContain("Just a title");
  });
});

describe("toMarkdown", () => {
  it("round-trips every fact from the source: no bullet text is lost or altered by default", () => {
    const doc = parseResume(fixture);
    const out = toMarkdown(doc);
    for (const needle of [
      "Samuel Example Doe",
      "Owned widget infrastructure end to end",
      "Cut deploy time from an hour to five minutes",
      "Mentored two junior engineers",
      "Built the first version of the widget pipeline",
      "Learned the ropes",
      "Shipped a small internal tool",
      "Some Certification",
      "Python (expert)",
    ]) {
      expect(out).toContain(needle);
    }
  });

  it("applies a bullet subset/reorder without introducing any new text", () => {
    const doc = parseResume(fixture);
    const experience = doc.sections.find((s) => s.kind === "experience");
    if (experience?.kind !== "experience")
      throw new Error("expected experience section");
    const acme = experience.entries[0];
    if (!acme) throw new Error("expected acme entry");
    // Reverse and drop one bullet - simulating a tailoring selection.
    acme.bullets = [...acme.bullets].reverse().slice(0, 2);

    const out = toMarkdown(doc);
    expect(out).toContain("Mentored two junior engineers");
    expect(out).toContain("Cut deploy time from an hour to five minutes");
    expect(out).not.toContain("Owned widget infrastructure end to end");
    expect(out.indexOf("Mentored two junior engineers")).toBeLessThan(
      out.indexOf("Cut deploy time from an hour to five minutes"),
    );
  });
});
