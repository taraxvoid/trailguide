// A resume master file (input/<name>.md, gitignored/personal) is parsed into
// this structure so tailoring can select and reorder existing content
// without ever inventing or rewriting it.
//
// Everything the model is allowed to touch - which Highlights bullets lead,
// and which accomplishment bullets appear (and in what order) under each
// job - is represented as small, independently addressable `Bullet` chunks.
// Everything else (contact header, company names/dates/titles, Education,
// Certifications, Publications, Volunteering, Skills, ...) is captured as
// opaque `verbatim` text and reproduced byte-for-byte. A tailoring plan can
// only refer to bullets by the ids assigned here, so the renderer can never
// emit text that didn't already exist in the master file.

export interface Bullet {
  id: string;
  /** Raw markdown for this bullet, including any nested sub-bullets. */
  text: string;
}

export interface ExperienceEntry {
  id: string;
  /** Raw heading text for this employer, e.g. "**DataDog, Inc**". */
  heading: string;
  /** Raw lines between the heading and the first bullet (dates, location, title). */
  preamble: string;
  bullets: Bullet[];
}

export type Section =
  | { kind: "verbatim"; raw: string }
  | { kind: "highlights"; heading: string; bullets: Bullet[] }
  | { kind: "experience"; heading: string; entries: ExperienceEntry[] };

export interface ResumeDoc {
  /** Raw text before the first top-level section heading (name, contact info). */
  header: string;
  sections: Section[];
}

export function normalizeHeadingText(raw: string): string {
  return raw
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/\\([\\`*_{}[\]()#+.!>-])/g, "$1")
    .trim();
}

/** True for a line that is *only* a bold span, e.g. "**iSIGHT Partners**". */
function isBoldOnlyLine(line: string): boolean {
  return /^#*\s*\*\*[^*]+\*\*\s*$/.test(line);
}

function isHeadingLine(line: string): { level: number; text: string } | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!match) return null;
  const hashes = match[1] ?? "";
  const text = match[2] ?? "";
  return { level: hashes.length, text };
}

/**
 * Splits a block of lines into a leading preamble (dates/location/title,
 * kept verbatim) and the top-level bullets that follow. A bullet line is
 * one starting with "-" at 0-1 leading spaces; more-indented "-" lines are
 * nested continuations folded into the preceding top-level bullet's text
 * (Google Docs export style: sub-bullets are supporting detail, not
 * independently rankable facts).
 */
function splitPreambleAndBullets(
  lines: string[],
  idPrefix: string,
): { preamble: string; bullets: Bullet[] } {
  const preambleLines: string[] = [];
  const bullets: Bullet[] = [];
  let current: string[] | null = null;

  const flush = () => {
    if (current) {
      const withoutMarker = current
        .map((l, i) => (i === 0 ? l.replace(/^-\s*/, "") : l))
        .join("\n")
        .trim();
      if (withoutMarker.length > 0) {
        bullets.push({
          id: `${idPrefix}${bullets.length}`,
          text: current.join("\n").replace(/\s+$/, ""),
        });
      }
    }
    current = null;
  };

  for (const line of lines) {
    if (/^-\s?\S/.test(line) || /^-\s*$/.test(line)) {
      flush();
      current = [line];
      continue;
    }
    if (current) {
      current.push(line);
      continue;
    }
    preambleLines.push(line);
  }
  flush();

  // Trim leading/trailing blank lines from the preamble without disturbing
  // any meaningful blank lines in between.
  while (preambleLines.length && preambleLines[0]?.trim() === "") {
    preambleLines.shift();
  }
  while (
    preambleLines.length &&
    preambleLines[preambleLines.length - 1]?.trim() === ""
  ) {
    preambleLines.pop();
  }

  return { preamble: preambleLines.join("\n"), bullets };
}

/**
 * Splits an experience section's body into per-employer entries. Entries are
 * delimited by a bold-only line ("### **Company**" or a bare "**Company**"
 * paragraph both qualify once heading hashes are stripped) - the same rule
 * regardless of whether the source used a markdown heading for that
 * employer, since real-world exports are inconsistent about it.
 */
function splitExperienceEntries(
  bodyLines: string[],
  firstHeading: string | null,
): ExperienceEntry[] {
  const entries: ExperienceEntry[] = [];
  let currentHeading = firstHeading;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentHeading === null && currentLines.every((l) => l.trim() === "")) {
      currentLines = [];
      return;
    }
    const index = entries.length;
    const { preamble, bullets } = splitPreambleAndBullets(
      currentLines,
      `experience${index}_`,
    );
    entries.push({
      id: `experience${index}`,
      heading: currentHeading ?? "",
      preamble,
      bullets,
    });
    currentLines = [];
  };

  for (const line of bodyLines) {
    if (isBoldOnlyLine(line)) {
      flush();
      // Keep the heading's original prefix ("### " vs. a bare bold
      // paragraph) so a company that had a markdown heading in the source
      // still has one in tailored output.
      currentHeading = line.trim();
      continue;
    }
    currentLines.push(line);
  }
  flush();

  return entries;
}

/**
 * Parses a resume master file into a {@link ResumeDoc}. Section detection is
 * driven entirely by locating the "Highlights" heading and reading its
 * level - every other heading at that same level is a top-level section
 * boundary, so the parser doesn't need to assume the document uses any
 * particular heading depth. Sections that aren't "Highlights" or "Career
 * Experience" (by prefix match) are preserved verbatim.
 */
export function parseResume(source: string): ResumeDoc {
  const lines = source.split(/\r\n|\r|\n/);

  const headings: Array<{ level: number; text: string; lineIndex: number }> =
    [];
  lines.forEach((line, lineIndex) => {
    const heading = isHeadingLine(line);
    if (heading) {
      headings.push({
        level: heading.level,
        text: normalizeHeadingText(heading.text),
        lineIndex,
      });
    }
  });

  const highlightsHeading = headings.find(
    (h) => h.text.toLowerCase() === "highlights",
  );

  if (!highlightsHeading) {
    // No recognizable Highlights section: the whole document is preserved
    // verbatim and there is nothing to tailor. Callers should treat this as
    // "tailoring unavailable", not an error.
    return { header: source, sections: [] };
  }

  const topLevel = headings.filter((h) => h.level === highlightsHeading.level);
  const header = lines.slice(0, topLevel[0]?.lineIndex ?? 0).join("\n");

  const sections: Section[] = [];
  for (let i = 0; i < topLevel.length; i++) {
    const start = topLevel[i];
    if (!start) continue;
    const end = topLevel[i + 1]?.lineIndex ?? lines.length;
    const headingLine = lines[start.lineIndex] ?? "";
    const bodyLines = lines.slice(start.lineIndex + 1, end);
    const rawSection = lines.slice(start.lineIndex, end).join("\n");

    if (start.text.toLowerCase() === "highlights") {
      const { bullets } = splitPreambleAndBullets(bodyLines, "highlight");
      sections.push({ kind: "highlights", heading: headingLine, bullets });
      continue;
    }

    if (/^career experience/i.test(start.text)) {
      // The source document sometimes fuses the first employer's name onto
      // this same heading line, e.g. "## Career Experience **Lindsay
      // Corporation**" - anything after the "Career Experience" prefix is
      // that first entry's heading instead of section chrome.
      const suffix = start.text.replace(/^career experience/i, "").trim();
      let fusedFirstHeading: string | null = null;
      if (suffix.length > 0) {
        const boldSpans = [...headingLine.matchAll(/\*\*[^*]+\*\*/g)];
        const lastBold = boldSpans[boldSpans.length - 1]?.[0] ?? null;
        if (lastBold && normalizeHeadingText(lastBold) === suffix) {
          fusedFirstHeading = lastBold;
        } else {
          // No bold span matches the fused name (unbolded employer name) -
          // fall back to everything after the "career experience" prefix,
          // matched case-insensitively against the raw heading line.
          const rawMatch = /career experience/i.exec(headingLine);
          fusedFirstHeading = rawMatch
            ? headingLine.slice(rawMatch.index + rawMatch[0].length).trim()
            : null;
        }
      }
      const entries = splitExperienceEntries(bodyLines, fusedFirstHeading);
      sections.push({
        kind: "experience",
        heading: fusedFirstHeading
          ? headingLine
              .slice(0, headingLine.indexOf(fusedFirstHeading))
              .trimEnd()
          : headingLine,
        entries,
      });
      continue;
    }

    sections.push({ kind: "verbatim", raw: rawSection });
  }

  return { header, sections };
}

/** Reserializes a {@link ResumeDoc} back to markdown. */
export function toMarkdown(doc: ResumeDoc): string {
  const parts: string[] = [];
  if (doc.header.trim().length > 0) parts.push(doc.header.replace(/\s+$/, ""));

  for (const section of doc.sections) {
    if (section.kind === "verbatim") {
      parts.push(section.raw.replace(/\s+$/, ""));
      continue;
    }
    if (section.kind === "highlights") {
      const body = section.bullets.map((b) => b.text).join("\n");
      parts.push([section.heading, body].filter(Boolean).join("\n\n"));
      continue;
    }
    // experience
    const entryBlocks = section.entries.map((entry) => {
      const bulletText = entry.bullets.map((b) => b.text).join("\n");
      return [entry.heading, entry.preamble, bulletText]
        .filter((s) => s.length > 0)
        .join("\n\n");
    });
    parts.push([section.heading, ...entryBlocks].filter(Boolean).join("\n\n"));
  }

  return `${parts.join("\n\n")}\n`;
}
