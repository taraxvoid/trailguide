import { describe, expect, it } from "bun:test";
import { parseResume } from "../src/tailor/resumeDoc.ts";
import {
  compileTypst,
  inlineToTypst,
  renderResumePdf,
  toTypst,
} from "../src/tailor/typst.ts";

const fixturePath = new URL("./fixtures/resume-sample.md", import.meta.url);
const fixture = await Bun.file(fixturePath).text();

async function typstAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn({
      cmd: ["typst", "--version"],
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

describe("inlineToTypst", () => {
  it("converts markdown bold to Typst strong", () => {
    expect(inlineToTypst("**Cloud**: AWS, GCP")).toBe("*Cloud*: AWS, GCP");
  });

  it("converts markdown single-asterisk italics to Typst emphasis, not strong", () => {
    expect(inlineToTypst("*Senior Widget Engineer*")).toBe(
      "_Senior Widget Engineer_",
    );
  });

  it("converts a markdown link to a Typst #link call", () => {
    expect(inlineToTypst("[tara@example.com](mailto:tara@example.com)")).toBe(
      '#link("mailto:tara@example.com")[tara\\@example.com]',
    );
  });

  it("unescapes markdown backslash-escapes that aren't Typst-significant", () => {
    expect(inlineToTypst("Jan 2023 \\- Present")).toBe("Jan 2023 - Present");
    expect(inlineToTypst("SMS: \\+1 555 123 4567")).toBe(
      "SMS: +1 555 123 4567",
    );
  });

  it("escapes a literal Typst-significant character instead of passing it through raw", () => {
    expect(inlineToTypst("C# and F#")).toBe("C\\# and F\\#");
    expect(inlineToTypst("cost is $5")).toBe("cost is \\$5");
  });

  it("never leaves an unescaped '#' that would make Typst try to parse code", () => {
    const out = inlineToTypst("#YOLO no code here");
    expect(out.startsWith("\\#")).toBe(true);
  });
});

describe("toTypst", () => {
  it("produces Typst headings (=) rather than leaving literal markdown '#'", () => {
    const doc = parseResume(fixture);
    const typ = toTypst(doc);
    expect(typ).toContain("== Highlights");
    expect(typ).toContain("== Career Experience");
    expect(typ).toContain("=== Acme Corp");
    // No stray, un-escaped heading hashes should survive into the body.
    expect(typ).not.toMatch(/^#{1,6}\s/m);
  });

  it("carries every real fact from the resume into the Typst source", () => {
    const doc = parseResume(fixture);
    const typ = toTypst(doc);
    for (const needle of [
      "Owned widget infrastructure end to end",
      "Built the first version of the widget pipeline",
      "Learned the ropes",
      "Some Certification",
    ]) {
      expect(typ).toContain(needle);
    }
  });
});

describe("renderResumePdf", () => {
  it("compiles the sample resume to a real, non-trivial PDF", async () => {
    if (!(await typstAvailable())) {
      console.warn("skipping: `typst` not found on PATH");
      return;
    }
    const doc = parseResume(fixture);
    const outPath = `${import.meta.dir}/../output/test-tmp/resume-sample.pdf`;
    const result = await renderResumePdf(doc, outPath);
    expect(result.ok).toBe(true);
    expect(result.stderr).toBe("");

    const pdf = Bun.file(outPath);
    expect(await pdf.exists()).toBe(true);
    const header = new TextDecoder().decode(
      new Uint8Array(await pdf.slice(0, 5).arrayBuffer()),
    );
    expect(header).toBe("%PDF-");
    expect(pdf.size).toBeGreaterThan(2000);

    await pdf.delete().catch(() => {});
    await Bun.file(result.typstPath)
      .delete()
      .catch(() => {});
  });

  it("never leaves a PDF behind when given genuinely broken Typst source", async () => {
    if (!(await typstAvailable())) {
      console.warn("skipping: `typst` not found on PATH");
      return;
    }
    // This is invalid Typst - a call to an undefined function with
    // unbalanced parens - simulating a bug in the converter rather than a
    // sanitization gap (the converter itself is expected to always
    // produce compilable source; this exercises the failure path).
    const outPath = `${import.meta.dir}/../output/test-tmp/resume-broken.pdf`;
    const result = await compileTypst(
      "#this-is-not-a-real-function(((",
      outPath,
    );
    expect(result.ok).toBe(false);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(await Bun.file(outPath).exists()).toBe(false);
    await Bun.file(result.typstPath)
      .delete()
      .catch(() => {});
  });
});
