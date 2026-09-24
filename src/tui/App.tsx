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
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NO_DELEGATE_ENV } from "../checkout.ts";
import { refreshListings } from "../cli.ts";
import type { ListingState, StoredJob } from "../db.ts";
import {
  allJobs,
  getTailorRun,
  getTailoredResume,
  runningTailorIds,
  setJobState,
  startTailorRun,
  tailoredListingIds,
} from "../db.ts";
import { linkifyPdfPath, openTarget } from "./open.ts";

interface AppProps {
  db: Database;
  /** Path to the sqlite file, passed to the detached `igor tailor` children. */
  dbPath: string;
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

const NEON_GREEN = "#39ff14";
const NEON_BLUE = "#4dd2ff";
const PULSE_TICK_MS = 150;
const POLL_MS = 1000;
const PULSE_PERIOD_TICKS = 16; // ~2.4s per breath

// Slow sine pulse between full neon green and a dim floor.
function pulseColor(tick: number): string {
  const phase = (tick % PULSE_PERIOD_TICKS) / PULSE_PERIOD_TICKS;
  const level = 0.2 + 0.8 * (0.5 + 0.5 * Math.cos(phase * 2 * Math.PI));
  const [r, g, b] = [0x39, 0xff, 0x14].map((c) => Math.round(c * level));
  return `#${[r, g, b].map((c) => (c as number).toString(16).padStart(2, "0")).join("")}`;
}

const SECTION_HEADER_LINES = 1;
// Worst case in the active view: an "Applied" header and an "Active" header.
const MAX_SECTION_HEADERS = 2;

const FOOTER_BEFORE =
  "[↑↓/k/j] navigate [←→/pgup/pgdn] page [↵] expand/collapse [o] open [⌃o] resume PDF [⌃t] ";
const FOOTER_MID = " resume [e] archive [a] ";
const FOOTER_AFTER = " [⌃e] archived view [⌃r] refresh [q] quit";
const FOOTER_TEXT = `${FOOTER_BEFORE}tailor/regen${FOOTER_MID}mark applied${FOOTER_AFTER}`;

const VIEW_TABS = ["active", "archived"] as const;
type ViewTab = (typeof VIEW_TABS)[number];

function tabLabel(tab: ViewTab): string {
  switch (tab) {
    case "active":
      return "Active";
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

export default function JobBrowser({ db, dbPath, version = null }: AppProps) {
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
  // Listings with a tailor/regen in flight. Each is a detached `igor tailor`
  // process (so it survives quitting the TUI); the tailor_runs table is the
  // source of truth and is polled below.
  const [tailoringIds, setTailoringIds] = useState<Set<string>>(() =>
    runningTailorIds(db),
  );
  const [pulseTick, setPulseTick] = useState(0);
  const prevRunning = useRef<Set<string>>(tailoringIds);
  const [tailoredIds, setTailoredIds] = useState<Set<string>>(() =>
    tailoredListingIds(db),
  );

  // The active view pins applied jobs above the still-active ones.
  const visibleJobs = useMemo(() => {
    if (viewTab === "archived")
      return jobs.filter((j) => j.state === "archived");
    return [
      // Applied and tailored first, then the rest of applied (stable sort).
      ...jobs
        .filter((j) => j.state === "applied")
        .sort(
          (x, y) =>
            Number(tailoredIds.has(y.listingId)) -
            Number(tailoredIds.has(x.listingId)),
        ),
      ...jobs.filter((j) => j.state === "active"),
    ];
  }, [jobs, viewTab, tailoredIds]);

  const selectedJob = visibleJobs[selectedIndex] ?? null;

  // Both the detail box and the footer box share the same layout (outer
  // paddingX 2 + border 1 on each side), so their wrappable text sees the
  // same content width.
  const contentWidth = Math.max(20, columns - 6);

  const selectedIsTailored = selectedJob
    ? tailoredIds.has(selectedJob.listingId)
    : null;

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
    bottomSectionLines +
    (viewTab === "active" ? MAX_SECTION_HEADERS * SECTION_HEADER_LINES : 0);

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
      // Pressing [a] on an already-applied job undoes it.
      const next =
        state === "applied" && job.state === "applied" ? "active" : state;
      setJobState(db, job.listingId, next, new Date().toISOString());
      setJobs(allJobs(db));
      showStatus(`${next}: ${job.title} @ ${job.company}`);
    },
    [db, visibleJobs, selectedIndex, showStatus],
  );

  // Poll for runs started/finished by (possibly earlier or other) processes.
  useEffect(() => {
    const timer = setInterval(() => {
      const running = runningTailorIds(db);
      const finished = [...prevRunning.current].filter(
        (id) => !running.has(id),
      );
      prevRunning.current = running;
      setTailoringIds((prev) =>
        prev.size === running.size && [...prev].every((id) => running.has(id))
          ? prev
          : running,
      );
      if (finished.length > 0) {
        setTailoredIds(tailoredListingIds(db));
        // Several can finish in one tick; the last one's outcome is shown.
        const run = getTailorRun(db, finished[finished.length - 1] as string);
        if (run?.message) {
          setStatusMessage(
            run.ok ? run.message : `Tailoring failed: ${run.message}`,
          );
        }
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [db]);

  useEffect(() => {
    if (tailoringIds.size === 0) return;
    const timer = setInterval(() => setPulseTick((t) => t + 1), PULSE_TICK_MS);
    return () => clearInterval(timer);
  }, [tailoringIds.size]);

  const handleTailor = useCallback(() => {
    const job = visibleJobs[selectedIndex];
    if (!job || tailoringIds.has(job.listingId)) return;
    // Detached so it outlives the TUI. IGOR_NO_DELEGATE keeps the recorded
    // pid the real worker rather than a checkout-delegating wrapper.
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        `${import.meta.dir}/../cli.ts`,
        "tailor",
        job.listingId,
        "--db",
        dbPath,
      ],
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, [NO_DELEGATE_ENV]: "1" },
      detached: true,
    });
    proc.unref();
    // Record the child's pid now so the bar pulses immediately, before the
    // child has finished starting up.
    startTailorRun(db, job.listingId, proc.pid);
    const running = runningTailorIds(db);
    prevRunning.current = running;
    setTailoringIds(running);
    setStatusMessage(
      `Tailoring ${job.title} @ ${job.company} in the background (survives quitting)…`,
    );
  }, [db, dbPath, visibleJobs, selectedIndex, tailoringIds]);

  const handleOpenResume = useCallback(async () => {
    const job = visibleJobs[selectedIndex];
    if (!job) return;
    const record = getTailoredResume(db, job.listingId);
    const pdfPath = record?.markdownPath.replace(/\.md$/, ".pdf");
    if (!pdfPath || !(await Bun.file(pdfPath).exists())) {
      showStatus("No generated resume for this job (ctrl+T to tailor one)");
      return;
    }
    openTarget(pdfPath);
    showStatus(`Opened ${pdfPath}`);
  }, [db, visibleJobs, selectedIndex, showStatus]);

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
      if (key.pageUp || key.leftArrow || input === "h") {
        setSelectedIndex((prev) =>
          Math.max(0, prev - Math.max(1, visibleCount)),
        );
        return;
      }
      if (key.pageDown || key.rightArrow || input === "l") {
        setSelectedIndex((prev) =>
          Math.min(visibleJobs.length - 1, prev + Math.max(1, visibleCount)),
        );
        return;
      }
      if (key.ctrl && input === "e") {
        setViewTab((prev) => (prev === "active" ? "archived" : "active"));
        return;
      }
      if (key.return) {
        if (selectedJob?.description) {
          setIsExpanded((prev) => !prev);
        }
        return;
      }
      if (input === "o" && selectedJob) {
        openTarget(selectedJob.url);
        return;
      }
      if (key.ctrl && input === "o" && selectedJob) {
        handleOpenResume();
        return;
      }
      if (key.ctrl && input === "t" && selectedJob) {
        handleTailor();
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
      visibleCount,
      selectedJob,
      selectedJob?.url,
      selectedJob?.description,
      isRefreshing,
      handleRefresh,
      handleStateChange,
      handleTailor,
      handleOpenResume,
    ],
  );

  useInput(handleInput, { isActive: isRawModeSupported });

  const visibleSlice = useMemo(() => {
    return visibleJobs.slice(scrollOffset, scrollOffset + visibleCount);
  }, [visibleJobs, scrollOffset, visibleCount]);

  const appliedCount = useMemo(
    () => jobs.filter((j) => j.state === "applied").length,
    [jobs],
  );

  const tabCounts = useMemo(
    () =>
      Object.fromEntries(
        VIEW_TABS.map((tab) => [
          tab,
          jobs.filter(
            (j) =>
              j.state === tab || (tab === "active" && j.state === "applied"),
          ).length,
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
          {VIEW_TABS.filter((tab) => tab === viewTab).map((tab, i) => (
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
            const section = job.state === "applied" ? "applied" : "active";
            const prev = visibleSlice[i - 1];
            const showHeader =
              viewTab === "active" &&
              (i === 0 ||
                (prev?.state === "applied") !== (section === "applied"));
            return (
              <React.Fragment key={job.listingId}>
                {showHeader && (
                  <Text
                    bold
                    color={section === "applied" ? NEON_BLUE : "green"}
                  >
                    {section === "applied"
                      ? `Applied (${appliedCount})`
                      : `Active (${visibleJobs.length - appliedCount})`}
                  </Text>
                )}
                <JobRow
                  job={job}
                  isSelected={actualIndex === selectedIndex}
                  isTailored={tailoredIds.has(job.listingId)}
                  pulse={
                    tailoringIds.has(job.listingId)
                      ? pulseColor(pulseTick)
                      : null
                  }
                />
              </React.Fragment>
            );
          })
        )}
      </Box>

      {statusMessage && (
        <Box marginTop={1}>
          <Text dimColor>{linkifyPdfPath(statusMessage)}</Text>
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
        <Text dimColor>
          {FOOTER_BEFORE}
          <Text
            dimColor={false}
            bold={selectedIsTailored === false}
            color={selectedIsTailored === false ? NEON_GREEN : undefined}
          >
            tailor
          </Text>
          /
          <Text
            dimColor={false}
            bold={selectedIsTailored === true}
            color={selectedIsTailored === true ? NEON_GREEN : undefined}
          >
            regen
          </Text>
          {FOOTER_MID}
          <Text
            dimColor={false}
            bold={selectedJob?.state === "applied"}
            color={selectedJob?.state === "applied" ? NEON_BLUE : undefined}
          >
            mark applied
          </Text>
          {FOOTER_AFTER}
        </Text>
      </Box>
    </Box>
  );
}

interface JobRowProps {
  job: StoredJob;
  isSelected: boolean;
  isTailored: boolean;
  pulse: string | null;
}

function JobRow({ job, isSelected, isTailored, pulse }: JobRowProps) {
  return (
    <Box marginBottom={1}>
      {/* Two thin status slots. Applied (blue) owns the left slot; tailored
          (green) takes the left slot when not applied, else the right. */}
      {[0, 1].map((slot) => {
        const slots = [
          job.state === "applied" ? NEON_BLUE : null,
          pulse ?? (isTailored ? NEON_GREEN : null),
        ].filter((c): c is string => c !== null);
        const color = slots[slot];
        return (
          <Box key={slot} flexDirection="column" width={1}>
            <Text color={color}>{color ? "▎" : " "}</Text>
            <Text color={color}>{color ? "▎" : " "}</Text>
          </Box>
        );
      })}
      <Box
        paddingX={1}
        flexDirection="column"
        flexGrow={1}
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
    </Box>
  );
}
