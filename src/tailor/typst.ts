import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeHeadingText } from "./resumeDoc.ts";
import type { ResumeDoc } from "./resumeDoc.ts";

// Converts a tailored ResumeDoc into a Typst source document, then shells
// out to the `typst` CLI to render it to PDF.
//
// The resume master is Google-Docs-exported markdown, which is inline
// markup (**bold**, *italic*, [text](url), backslash-escaped punctuation)
// rather than plain text, and Typst's own markup syntax overlaps with but
// differs from Markdown's in ways that matter: `#` introduces Typst code
// (not headings - Typst headings use `=`), single `*text*` is *strong* in
// Typst but *emphasis* in Markdown, etc. Passing resume text through
// untranslated risks either a compile error or, worse, a PDF that silently
// renders the wrong thing (e.g. a job title in bold instead of italic, or a
// literal "#" nobody typed). `inlineToTypst`/`blockToTypst` below do that
// translation; `renderResumePdf`'s job is to never leave a broken or
// half-written PDF behind if anything goes wrong.

// Characters that are syntactically significant in Typst markup and must be
// escaped wherever they appear outside a construct we've deliberately
// generated (a link, bold/italic span, or code span already stashed above).
const TYPST_SPECIAL_CHARS = "\\_#$@<>[]`*~";
const TYPST_SPECIAL_GLOBAL = /[\\_#$@<>[\]`*~]/g;
function isTypstSpecial(ch: string): boolean {
  return TYPST_SPECIAL_CHARS.includes(ch);
}

// Markdown-style backslash escapes this resume format uses (Google Docs'
// export escapes most ASCII punctuation before dashes, pluses, ampersands...).
const MD_ESCAPE = /\\([\\`*_{}[\]()#+.!>~^"'&-])/g;

/** Converts a single line's inline markdown spans to Typst markup. */
export function inlineToTypst(text: string): string {
  const stash: string[] = [];
  // Private-Use-Area markers: printable to regex tooling (unlike control
  // characters) but never present in real resume text, so they're safe
  // stand-ins for already-converted Typst fragments while the rest of the
  // string is still being escaped.
  const stashPlaceholder = (typst: string): string => {
    stash.push(typst);
    return `\uE000${stash.length - 1}\uE001`;
  };

  let s = text;

  // [label](url) -> #link("url")[label]
  s = s.replace(
    /\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_m, label: string, url: string) =>
      stashPlaceholder(
        `#link("${url.replace(/"/g, '\\"')}")[${inlineToTypst(label)}]`,
      ),
  );

  // `code` -> `code` (Typst raw spans use the same backtick syntax).
  s = s.replace(/`([^`]+)`/g, (_m, code: string) =>
    stashPlaceholder(`\`${code}\``),
  );

  // **bold** -> *bold* (Typst strong)
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) =>
    stashPlaceholder(`*${inlineToTypst(inner)}*`),
  );

  // *italic* -> _italic_ (Typst emphasis - single-asterisk markdown italics
  // would otherwise collide with Typst's single-asterisk strong syntax).
  s = s.replace(/\*([^*]+)\*/g, (_m, inner: string) =>
    stashPlaceholder(`_${inlineToTypst(inner)}_`),
  );

  // Undo markdown backslash-escapes, but re-escape (for Typst) any
  // character that's still syntactically significant there.
  s = s.replace(MD_ESCAPE, (_m, ch: string) =>
    isTypstSpecial(ch) ? `\\${ch}` : ch,
  );

  // Escape any remaining literal Typst-special characters (backslash-escaping
  // an otherwise-ordinary character is always valid Typst, so this is safe
  // to apply liberally).
  s = s.replace(TYPST_SPECIAL_GLOBAL, "\\$&");

  s = s.replace(
    /\uE000(\d+)\uE001/g,
    (_m, i: string) => stash[Number(i)] ?? "",
  );

  return s;
}

/**
 * Converts one line of raw markdown to Typst, handling the two line-level
 * constructs `inlineToTypst` can't see on its own: markdown headings
 * (`#`/`##`/`###`, which must become Typst's `=`/`==`/`===` rather than
 * being left as literal `#` - Typst would try to parse a bare `#` as the
 * start of a code expression) and Google Docs' "two trailing spaces = hard
 * line break" convention (a plain `\n` inside a Typst paragraph is treated
 * as a space, so without this, dates/location/title on separate source
 * lines would run together into one line in the rendered PDF).
 */
function convertLine(line: string): string {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    const level = (heading[1] ?? "").length;
    const text = normalizeHeadingText(heading[2] ?? "");
    return `${"=".repeat(level)} ${inlineToTypst(text)}`;
  }

  const hardBreak = / {2,}$/.test(line);
  // A literal leading "+" would otherwise be read as a Typst ordered-list
  // marker; nothing in this resume format intends that.
  const body = line.replace(/^\+/, "\\+").replace(/\s+$/, "");
  const converted = inlineToTypst(body);
  return hardBreak ? `${converted} #linebreak()` : converted;
}

/** Converts a raw multi-line markdown block to Typst markup. */
function blockToTypst(raw: string): string {
  return raw.split("\n").map(convertLine).join("\n");
}

function headingText(headingLine: string): string {
  const heading = /^(#{1,6})\s+(.*)$/.exec(headingLine.trim());
  return normalizeHeadingText(heading ? (heading[2] ?? "") : headingLine);
}

const TYPST_PREAMBLE = `#set page(margin: (x: 1.6cm, y: 1.4cm))
#set text(font: "New Computer Modern", size: 9.5pt)
#set par(justify: false, leading: 0.55em)
#set list(marker: [\u2022], indent: 0.6em, body-indent: 0.4em)
#set heading(numbering: none)
#show heading.where(level: 1): set text(size: 15pt, weight: "bold")
#show heading.where(level: 2): it => block(above: 0.9em, below: 0.45em)[
  #set text(size: 11.5pt, weight: "bold")
  #it.body
  #line(length: 100%, stroke: 0.4pt)
]
#show heading.where(level: 3): set text(size: 10pt, weight: "bold", style: "italic")
`;

/** Converts a tailored {@link ResumeDoc} to a complete Typst source file. */
export function toTypst(doc: ResumeDoc): string {
  const parts: string[] = [TYPST_PREAMBLE, blockToTypst(doc.header)];

  for (const section of doc.sections) {
    if (section.kind === "verbatim") {
      parts.push(blockToTypst(section.raw));
      continue;
    }
    if (section.kind === "highlights") {
      parts.push(`== ${inlineToTypst(headingText(section.heading))}`);
      parts.push(section.bullets.map((b) => blockToTypst(b.text)).join("\n"));
      continue;
    }
    if (section.kind === "skills") {
      parts.push(`== ${inlineToTypst(headingText(section.heading))}`);
      for (const group of section.groups) {
        // Unlike employers, a skills group's heading keeps whatever form it
        // had in the master (a "###" heading stays a heading, a bare bold
        // paragraph stays a bold paragraph) - blockToTypst handles both, so
        // tailoring never restyles the section it reorders.
        if (group.heading.trim().length > 0) {
          parts.push(blockToTypst(group.heading));
        }
        if (group.preamble.trim().length > 0) {
          parts.push(blockToTypst(group.preamble));
        }
        parts.push(group.bullets.map((b) => blockToTypst(b.text)).join("\n"));
      }
      continue;
    }

    parts.push(`== ${inlineToTypst(headingText(section.heading))}`);
    for (const entry of section.entries) {
      parts.push(`=== ${inlineToTypst(headingText(entry.heading))}`);
      if (entry.preamble.trim().length > 0) {
        parts.push(blockToTypst(entry.preamble));
      }
      parts.push(entry.bullets.map((b) => blockToTypst(b.text)).join("\n"));
    }
  }

  return `${parts.filter((p) => p.trim().length > 0).join("\n\n")}\n`;
}

export interface RenderResult {
  ok: boolean;
  typstPath: string;
  pdfPath: string;
  stderr: string;
}

/**
 * Compiles raw Typst source to PDF via the `typst` CLI, validating that the
 * result is actually a usable PDF rather than trusting the exit code alone.
 * Never leaves a partial or corrupt `.pdf` behind: on any failure, whatever
 * `typst` wrote (if anything) is deleted before returning.
 */
export async function compileTypst(
  typstSource: string,
  pdfPath: string,
): Promise<RenderResult> {
  const typstPath = pdfPath.replace(/\.pdf$/, ".typ");
  await mkdir(dirname(pdfPath), { recursive: true });
  await Bun.write(typstPath, typstSource);

  await Bun.file(pdfPath)
    .delete()
    .catch(() => {});

  const proc = Bun.spawn({
    cmd: ["typst", "compile", typstPath, pdfPath],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const pdfFile = Bun.file(pdfPath);
  const exists = await pdfFile.exists();
  if (!exists) return { ok: false, typstPath, pdfPath, stderr };

  const header = new Uint8Array(await pdfFile.slice(0, 5).arrayBuffer());
  const looksLikePdf = new TextDecoder().decode(header) === "%PDF-";
  const size = pdfFile.size;

  if (exitCode !== 0 || !looksLikePdf || size < 500) {
    await pdfFile.delete().catch(() => {});
    return {
      ok: false,
      typstPath,
      pdfPath,
      stderr: stderr || `typst produced no usable PDF (size=${size})`,
    };
  }

  return { ok: true, typstPath, pdfPath, stderr };
}

/** Renders a tailored resume straight to PDF: {@link toTypst} + {@link compileTypst}. */
export async function renderResumePdf(
  doc: ResumeDoc,
  pdfPath: string,
): Promise<RenderResult> {
  return compileTypst(toTypst(doc), pdfPath);
}
