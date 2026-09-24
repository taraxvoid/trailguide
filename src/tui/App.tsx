import type { Database } from "bun:sqlite";
import {
  Box,
  type Key,
  Text,
  useApp,
  useInput,
  useStdin,
  useWindowSize,
} from "ink";
import React, { useState, useCallback, useEffect, useMemo } from "react";
import { refreshListings } from "../cli.ts";
import type { ListingState, StoredJob } from "../db.ts";
import { allJobs, getTailoredResume, setJobState } from "../db.ts";
import { tailorOrRegenerate } from "../tailor/index.ts";

interface AppProps {
  db: Database;
  /** The running checkout's last commit, e.g. "main@abc1234 fix things". */
  version?: string | null;
}

// Chrome heights below are line counts for the JSX blocks they mirror -
// keep them in sync when the layout changes, since visibleCount depends on
// knowing exactly how many non-list rows are on screen in each state.
const HEADER_LINES = 3; // paddingY 1 (top+bottom) + 1 content line
const GAP_LINE = 1; // blank line between sections
const SEPARATOR_LINES = 1;
const FOOTER_FIXED_LINES = 5; // marginTop 1 + border 2 + paddingY 2 (content wraps, measured below)
const STATUS_LINES = 2; // marginTop 1 + content 1
const DETAIL_FIXED_LINES = 5; // gap 1 + border 2 + paddingY 2 (title/company/url wrap, measured below)
const DESCRIPTION_PREVIEW_LINES = 2;
const ROW_LINES = 3; // title line + meta line + marginBottom gap, see JobRow

const FOOTER_TEXT =
  "[↑↓/k/j] navigate [←→/h/l] switch view [↵] expand/collapse [o] open [⌃t] tailor/regenerate resume [e] archive [a] applied [⌃r] refresh [q] quit";

const VIEW_TABS = ["active", "applied", "archived"] as const;
type ViewTab = (typeof VIEW_TABS)[number];

function tabLabel(tab: ViewTab): string {
  switch (tab) {
    case "active":
      return "Active";
    case "applied":
      return "Applied";
    case "archived":
      return "Archived";
  }
}

function formatRemote(type: string): string | null {
  switch (type) {
    case "remote":
      return "Remote";
    case "hybrid":
      return "Hybrid";
    case "onsite":
      return "On-site";
    default:
      return null;
  }
}

// Some sources (e.g. Adzuna) hand back descriptions with embedded hard line
// breaks, which Ink renders as forced line breaks the chrome math below
// doesn't budget for. Collapsing to single-line text first means the only
// line breaks left are the ones wrapText introduces itself, so the line
// count it reports always matches what actually gets rendered.
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// Greedy word-wrap, matching how Ink wraps <Text>. Chrome height budgeting
// needs the *actual* wrapped line count (title/company/url/footer text can
// all wrap depending on job content and terminal width) rather than an
// assumed "1 line" - an underestimate here overflows the terminal height
// and permanently scrolls the header out of view, since Ink repaints with
// relative cursor moves and never recovers a scroll caused that way.
function wrapText(text: string, width: number): string[] {
  const words = text.split(" ").filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    // A single word longer than the width (a URL, typically) can't be
    // wrapped at a space, so hard-break it into width-sized chunks.
    let rest = word;
    while (rest.length > width) {
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    current = rest;
  }
  if (current) lines.push(current);
  return lines;
}

// Slices pre-wrapped lines down to maxLines, ellipsizing the last shown
// line when content was cut off.
function previewLines(
  lines: string[],
  maxLines: number,
  width: number,
): string[] {
  if (lines.length <= maxLines) return lines;
  const shown = lines.slice(0, maxLines);
  const last = shown[maxLines - 1] ?? "";
  shown[maxLines - 1] =
    last.length >= width ? `${last.slice(0, width - 1)}…` : `${last}…`;
  return shown;
}

function formatState(state: ListingState): string {
  switch (state) {
    case "active":
      return "";
    case "applied":
      return "[applied]";
    case "archived":
      return "[archived]";
    case "inactive":
      return "[inactive]";
  }
}

export default function JobBrowser({ db, version = null }: AppProps) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { rows, columns } = useWindowSize();
  const [jobs, setJobs] = useState<StoredJob[]>(() => allJobs(db));
  const [viewTab, setViewTab] = useState<ViewTab>("active");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isTailoring, setIsTailoring] = useState(false);

  const visibleJobs = useMemo(
    () => jobs.filter((j) => j.state === viewTab),
    [jobs, viewTab],
  );

  const selectedJob = visibleJobs[selectedIndex] ?? null;

  // Both the detail box and the footer box share the same layout (outer
  // paddingX 2 + border 1 on each side), so their wrappable text sees the
  // same content width.
  const contentWidth = Math.max(20, columns - 6);

  const description = selectedJob?.description
    ? collapseWhitespace(selectedJob.description)
    : null;

  const descriptionAllLines = description
    ? wrapText(description, contentWidth)
    : [];
  const descriptionShownLines = isExpanded
    ? descriptionAllLines
    : previewLines(
        descriptionAllLines,
        DESCRIPTION_PREVIEW_LINES,
        contentWidth,
      );
  const descriptionLineCount = descriptionShownLines.length;

  const titleLine = selectedJob
    ? `${selectedJob.title} ${formatState(selectedJob.state)}`.trim()
    : "";
  const companyLine = selectedJob
    ? `${selectedJob.company}${
        formatRemote(selectedJob.remoteType)
          ? ` · ${formatRemote(selectedJob.remoteType)}`
          : ""
      } · ${selectedJob.location}`
    : "";

  const detailContentLines = selectedJob
    ? wrapText(titleLine, contentWidth).length +
      wrapText(companyLine, contentWidth).length +
      wrapText(selectedJob.url, contentWidth).length
    : 0;

  const footerLines = wrapText(FOOTER_TEXT, contentWidth).length;

  // The detail panel and status message are mutually exclusive and occupy
  // very different heights (an ~8-11 line bordered box vs. a single line),
  // so the number of rows available to the scrollable list has to be
  // recomputed for whichever one is actually on screen right now.
  const bottomSectionLines = statusMessage
    ? STATUS_LINES
    : selectedJob
      ? DETAIL_FIXED_LINES +
        detailContentLines +
        (description ? GAP_LINE + descriptionLineCount : 0)
      : 0;

  const chromeLines =
    HEADER_LINES +
    GAP_LINE +
    SEPARATOR_LINES +
    FOOTER_FIXED_LINES +
    footerLines +
    bottomSectionLines;

  // No floor of 1 here: when the chrome (header/detail/footer) alone
  // already fills the terminal, forcing a row anyway would overflow the
  // terminal height and permanently scroll the header out of view (Ink
  // repaints via relative cursor moves and can't recover from that). An
  // empty list area is the correct degraded state, not an overflowed one.
  const visibleCount = Math.max(
    0,
    Math.floor((rows - chromeLines) / ROW_LINES),
  );

  useEffect(() => {
    setSelectedIndex((prev) =>
      Math.min(prev, Math.max(0, visibleJobs.length - 1)),
    );
  }, [visibleJobs.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset only when the tab changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [viewTab]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset only when the selection changes
  useEffect(() => {
    setIsExpanded(false);
  }, [selectedIndex]);

  useEffect(() => {
    setScrollOffset((prev) => {
      if (selectedIndex < prev) return selectedIndex;
      if (selectedIndex >= prev + visibleCount)
        return selectedIndex - visibleCount + 1;
      return prev;
    });
  }, [selectedIndex, visibleCount]);

  const showStatus = useCallback((msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage(null), 3000);
  }, []);

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    setStatusMessage("Refreshing…");
    try {
      const result = await refreshListings(db);
      setJobs(allJobs(db));
      showStatus(
        `Refreshed ${result.checked} (${result.skipped} skipped): ${result.activated} active, ${result.archived} archived`,
      );
    } finally {
      setIsRefreshing(false);
    }
  }, [db, isRefreshing, showStatus]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount only
  useEffect(() => {
    handleRefresh();
  }, []);

  const handleStateChange = useCallback(
    (state: ListingState) => {
      const job = visibleJobs[selectedIndex];
      if (!job) return;
      setJobState(db, job.listingId, state, new Date().toISOString());
      setJobs(allJobs(db));
      showStatus(`${state}: ${job.title} @ ${job.company}`);
    },
    [db, visibleJobs, selectedIndex, showStatus],
  );

  const handleTailor = useCallback(async () => {
    const job = visibleJobs[selectedIndex];
    if (!job || isTailoring) return;
    setIsTailoring(true);
    // No auto-hiding timeout here (unlike showStatus elsewhere) - tailoring
    // takes tens of seconds on a local model, and the result (including any
    // warnings about a fallback) is worth leaving on screen until the next
    // action rather than losing it after 3s.
    // Only a guess for the progress message - tailorOrRegenerate makes the
    // real call (e.g. a tracked .md deleted since means a fresh tailor).
    const regenerating = getTailoredResume(db, job.listingId) !== null;
    setStatusMessage(
      regenerating
        ? "Regenerating PDF from the tailored markdown…"
        : "Tailoring resume (this can take a minute on a local model)…",
    );
    try {
      const result = await tailorOrRegenerate(db, job.listingId);
      if (!result.ok) {
        setStatusMessage(`Tailoring failed: ${result.error}`);
        return;
      }
      const warningSuffix =
        result.warnings.length > 0 ? ` (${result.warnings.join("; ")})` : "";
      const verb = result.action === "regenerated" ? "Regenerated" : "Wrote";
      setStatusMessage(
        `${verb} ${result.pdfPath ?? result.markdownPath}${warningSuffix}`,
      );
    } finally {
      setIsTailoring(false);
    }
  }, [db, visibleJobs, selectedIndex, isTailoring]);

  const handleInput = useCallback(
    (input: string, key: Key) => {
      if (key.escape || input === "q") {
        exit();
        return;
      }
      if (key.ctrl && input === "r") {
        if (!isRefreshing) handleRefresh();
        return;
      }
      if (key.upArrow || input === "k") {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setSelectedIndex((prev) => Math.min(visibleJobs.length - 1, prev + 1));
        return;
      }
      if (key.leftArrow || input === "h") {
        setViewTab(
          (prev) =>
            VIEW_TABS[
              (VIEW_TABS.indexOf(prev) - 1 + VIEW_TABS.length) %
                VIEW_TABS.length
            ] as ViewTab,
        );
        return;
      }
      if (key.rightArrow || input === "l") {
        setViewTab(
          (prev) =>
            VIEW_TABS[
              (VIEW_TABS.indexOf(prev) + 1) % VIEW_TABS.length
            ] as ViewTab,
        );
        return;
      }
      if (key.return) {
        if (selectedJob?.description) {
          setIsExpanded((prev) => !prev);
        }
        return;
      }
      if (input === "o" && selectedJob) {
        const platform = process.platform;
        const cmd =
          platform === "win32"
            ? ["cmd", "/c", "start", "", selectedJob.url]
            : ["open", selectedJob.url];
        Bun.spawn({ cmd });
        return;
      }
      if (key.ctrl && input === "t" && selectedJob) {
        if (!isTailoring) handleTailor();
        return;
      }
      if (input === "e") {
        handleStateChange("archived");
        return;
      }
      if (input === "a") {
        handleStateChange("applied");
        return;
      }
    },
    [
      exit,
      visibleJobs.length,
      selectedJob,
      selectedJob?.url,
      selectedJob?.description,
      isRefreshing,
      isTailoring,
      handleRefresh,
      handleStateChange,
      handleTailor,
    ],
  );

  useInput(handleInput, { isActive: isRawModeSupported });

  const visibleSlice = useMemo(() => {
    return visibleJobs.slice(scrollOffset, scrollOffset + visibleCount);
  }, [visibleJobs, scrollOffset, visibleCount]);

  const tabCounts = useMemo(
    () =>
      Object.fromEntries(
        VIEW_TABS.map((tab) => [
          tab,
          jobs.filter((j) => j.state === tab).length,
        ]),
      ) as Record<ViewTab, number>,
    [jobs],
  );

  return (
    <Box flexDirection="column" height="100%" paddingX={2} overflow="hidden">
      <Box paddingY={1} justifyContent="space-between" alignItems="center">
        <Box flexShrink={1} marginRight={2}>
          <Text bold color="green">
            ⚡ Igor at your sshhservishss ⚡ 
          </Text>
          {version && (
            <Text dimColor wrap="truncate-end">
              {"  "}
              {version}
            </Text>
          )}
        </Box>
        <Text>
          {VIEW_TABS.map((tab, i) => (
            <React.Fragment key={tab}>
              {i > 0 && <Text dimColor> </Text>}
              <Text
                bold={tab === viewTab}
                color={tab === viewTab ? "green" : undefined}
                dimColor={tab !== viewTab}
              >
                {tabLabel(tab)} ({tabCounts[tab]})
              </Text>
            </React.Fragment>
          ))}
        </Text>
      </Box>

      <Box height={GAP_LINE} />

      <Text dimColor>{"─".repeat(40)}</Text>

      <Box flexDirection="column" flexGrow={1}>
        {visibleJobs.length === 0 ? (
          <Box flexDirection="column" alignItems="center" marginTop={2}>
            <Text dimColor>No jobs found.</Text>
            <Text dimColor>Run a search first:</Text>
            <Text dimColor> igor search --role "software engineer"</Text>
          </Box>
        ) : (
          visibleSlice.map((job, i) => {
            const actualIndex = scrollOffset + i;
            return (
              <JobRow
                key={job.listingId}
                job={job}
                isSelected={actualIndex === selectedIndex}
              />
            );
          })
        )}
      </Box>

      {statusMessage && (
        <Box marginTop={1}>
          <Text dimColor>{statusMessage}</Text>
        </Box>
      )}

      {selectedJob && !statusMessage && (
        <>
          <Box height={GAP_LINE} />
          <Box
            paddingY={1}
            borderStyle="single"
            borderColor="gray"
            flexDirection="column"
          >
            <Text bold color="green">
              {selectedJob.title} {formatState(selectedJob.state)}
            </Text>
            <Text>
              {selectedJob.company}
              {formatRemote(selectedJob.remoteType)
                ? ` · ${formatRemote(selectedJob.remoteType)}`
                : ""}{" "}
              · {selectedJob.location}
            </Text>
            <Text dimColor>{selectedJob.url}</Text>
            {description && (
              <>
                <Box height={GAP_LINE} />
                <Text dimColor>{descriptionShownLines.join("\n")}</Text>
              </>
            )}
          </Box>
        </>
      )}

      <Box paddingY={1} marginTop={1} borderStyle="single" borderColor="gray">
        <Text dimColor>{FOOTER_TEXT}</Text>
      </Box>
    </Box>
  );
}

interface JobRowProps {
  job: StoredJob;
  isSelected: boolean;
}

function JobRow({ job, isSelected }: JobRowProps) {
  return (
    <Box
      paddingX={1}
      marginBottom={1}
      flexDirection="column"
      backgroundColor={isSelected ? "black" : undefined}
    >
      <Box>
        {isSelected && (
          <Text bold color="green">
            ▸{" "}
          </Text>
        )}
        <Text bold={isSelected} color={isSelected ? "white" : undefined}>
          {job.title}
        </Text>
        <Text dimColor> @ {job.company}</Text>
        {formatState(job.state) && (
          <Text dimColor> {formatState(job.state)}</Text>
        )}
      </Box>
      <Box marginLeft={isSelected ? 3 : 0}>
        <Text dimColor>
          {formatRemote(job.remoteType)
            ? `${formatRemote(job.remoteType)} · `
            : ""}
          {job.location}
        </Text>
      </Box>
    </Box>
  );
}
