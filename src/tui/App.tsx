import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
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
import {
  configuredRegions,
  configuredTrails,
  loadConfig,
  type RegionEntry,
  resolveBoards,
} from "../config.ts";
import type { ListingState, StoredJob } from "../db.ts";
import {
  allJobs,
  getRun,
  getSetting,
  getTailoredResume,
  getTailorRun,
  runningRuns,
  runningTailorIds,
  SEARCH_RUN_KEY,
  setJobApplied,
  setJobState,
  setJobTrail,
  setSetting,
  startTailorRun,
  tailoredListingIds,
} from "../db.ts";
import { ImportError, importJob } from "../importUrl.ts";
import { UNASSIGNED } from "../regions.ts";
import { filterJobs, stepFilterPrompt } from "./filter.ts";
import { HeaderStrip } from "./HeaderStrip.tsx";
import { type ImportPrompt, stepImportPrompt } from "./importPrompt.ts";
import { copyToClipboard, linkifyPdfPath, openTarget } from "./open.ts";
import {
  initialRegion,
  nextRegion,
  nextView,
  regionByKey,
  stripRegions,
} from "./regions.ts";
import { describeSearchRun, startBackgroundSearch } from "./search.ts";
import {
  inRegion,
  orderJobs,
  type SectionTone,
  sectionCounts,
  sectionOf,
  type ViewTab,
  viewCounts,
} from "./sections.ts";

/** Settings key for the region the TUI reopens on. */
const REGION_SETTING = "tui.region";

interface AppProps {
  db: Database;
  /** Absolute path to the sqlite file, passed to the detached trailguide children. */
  dbPath: string;
  /** Explicit config file (--config or TRAILGUIDE_CONFIG), forwarded to `trailguide search`. */
  configPath?: string;
  /** The running checkout's last commit, e.g. "main@abc1234*". */
  version?: string | null;
}

// Chrome heights below are line counts for the JSX blocks they mirror -
// keep them in sync when the layout changes, since visibleCount depends on
// knowing exactly how many non-list rows are on screen in each state.
const HEADER_LINES = 1; // one row: search status left, version right (the cairn overlays the top-right)
const GAP_LINE = 1; // blank line between sections
const SEPARATOR_LINES = 1;
const FOOTER_FIXED_LINES = 5; // marginTop 1 + border 2 + paddingY 2 (content wraps, measured below)
const STATUS_LINES = 2; // marginTop 1 + content 1
const DETAIL_FIXED_LINES = 5; // gap 1 + border 2 + paddingY 2 (title/company/url/id wrap, measured below)
const DESCRIPTION_PREVIEW_LINES = 2;
const ROW_LINES = 3; // title line + meta line + marginBottom gap, see JobRow

// Muted mid-tones that stay legible on both dark and light terminals: cool
// sage/sky for "good" states, warm sand/terracotta for keys and archived.
const SAGE = "#8fbf9f";
const SKY = "#7aa7d9";
const SAND = "#ffd479";
const TERRACOTTA = "#c98f6b";

// A small cairn of offset stones, drawn over the top-right corner (absolutely
// positioned, so it takes no layout rows and the content below starts at the
// real top). Each stone is a row of lower-3/4 blocks so a sliver of gap
// separates them.
const CAIRN = [
  { stone: "   ▆▆ ", color: SAND },
  { stone: "   ▆▆▆", color: TERRACOTTA },
  { stone: "  ▆▆▆▆▆ ", color: SAGE },
];
const CAIRN_WIDTH = 8;
const PULSE_TICK_MS = 150;
const POLL_MS = 1000;
const PULSE_PERIOD_TICKS = 16; // ~2.4s per breath

// Slow sine pulse between full sage and a dim floor.
function pulseColor(tick: number): string {
  const phase = (tick % PULSE_PERIOD_TICKS) / PULSE_PERIOD_TICKS;
  const level = 0.2 + 0.8 * (0.5 + 0.5 * Math.cos(phase * 2 * Math.PI));
  const [r, g, b] = [0x8f, 0xbf, 0x9f].map((c) => Math.round(c * level));
  return `#${[r, g, b].map((c) => (c as number).toString(16).padStart(2, "0")).join("")}`;
}

const SECTION_HEADER_LINES = 1;

// The footer is a list of items whose shortcut letter is capitalized inside
// the label and highlighted. footerPlainText() flattens the same items for
// the wrap-height measurement (using the longest tailor label), so the render
// and the measurement can't drift apart.
interface FooterItem {
  before?: string;
  key: string;
  after?: string;
  /** Label color when the selected job is in the state this item names. */
  accent?: string;
  active?: boolean;
}

const FOOTER_NAV = "Nav: ↑↓/k/j | ←→/h/l/pgup/pgdn | ↵ expand";
const FOOTER_QUIT = "quit (q/Ctrl+C)";

interface FooterRegions {
  /** Regions in the header strip; the region keys show only with two or more. */
  count: number;
  /** The current region, named on the search item. */
  current: string | null;
}

function footerItems(
  tailored: boolean | null,
  archived: boolean,
  applied: boolean,
  regions: FooterRegions,
): FooterItem[] {
  const regionKeys: FooterItem[] =
    regions.count > 1
      ? [{ key: "G", after: `/1-${Math.min(9, regions.count)} region` }]
      : [];
  return [
    ...regionKeys,
    { before: "", key: "O", after: "pen link" },
    { key: "Y", after: "ank id" },
    {
      before: tailored ? "(re)" : "",
      key: "T",
      after: "ailor",
      accent: SAGE,
      active: tailored !== null,
    },
    { key: "V", after: "iew tailored resume" },
    { before: "archiv", key: "E", accent: TERRACOTTA, active: archived },
    { key: "A", after: "pplied", accent: SKY, active: applied },
    { before: "cycle trai", key: "L" },
    { key: "Tab", after: " Active/Applied" },
    { key: "Ctrl+E", after: " archived" },
    {
      key: "S",
      after:
        regions.current && regions.current !== UNASSIGNED
          ? `earch ${regions.current}`
          : "earch",
    },
    { key: "I", after: "mport link" },
    { key: "/", after: " filter" },
    { key: "R", after: "efresh (auto-archives)" },
  ];
}

/** The footer flattened, for the wrap-height measurement. */
function footerPlainText(regions: FooterRegions): string {
  // The longest tailor label, so the height doesn't jump with the selection.
  const items = footerItems(true, false, false, regions).map(
    (i) => `${i.before ?? ""}${i.key}${i.after ?? ""}`,
  );
  return [FOOTER_NAV, ...items, FOOTER_QUIT].join(" | ");
}

const TONE_COLORS: Record<SectionTone, string | undefined> = {
  applied: SKY,
  archived: TERRACOTTA,
  trail: SAGE,
  none: undefined,
};

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

interface StatusTag {
  label: string;
  color: string | undefined;
}

function statusTags(job: StoredJob, tailored: boolean): StatusTag[] {
  const { state } = job;
  const tags: StatusTag[] = [];
  if (job.appliedAt) tags.push({ label: "[applied]", color: SKY });
  if (tailored) tags.push({ label: "[tailored]", color: SAGE });
  if (job.trail) tags.push({ label: `[${job.trail}]`, color: undefined });
  if (state === "archived")
    tags.push({ label: "[archived]", color: TERRACOTTA });
  if (state === "inactive")
    tags.push({ label: "[inactive]", color: undefined });
  return tags;
}

function StatusTags({ tags }: { tags: StatusTag[] }) {
  return (
    <>
      {tags.map((t) => (
        <Text key={t.label} color={t.color} dimColor={!t.color}>
          {" "}
          {t.label}
        </Text>
      ))}
    </>
  );
}

export default function JobBrowser({
  db,
  dbPath,
  configPath,
  version = null,
}: AppProps) {
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
  // Listings with a tailor/regen in flight. Each is a detached `trailguide tailor`
  // process (so it survives quitting the TUI); the runs table is the
  // source of truth and is polled below.
  const [tailoringIds, setTailoringIds] = useState<Set<string>>(() =>
    runningTailorIds(db),
  );
  const [pulseTick, setPulseTick] = useState(0);
  const prevRunning = useRef<Set<string>>(tailoringIds);
  // A detached `trailguide search`; the runs table is the source of truth, so the
  // indicator survives restarting the TUI.
  const [isSearching, setIsSearching] = useState(
    () => runningRuns(db, "search").length > 0,
  );
  const prevSearching = useRef(isSearching);
  const [tailoredIds, setTailoredIds] = useState<Set<string>>(() =>
    tailoredListingIds(db),
  );

  // Trails from the config's [[keywords]], for cycling with L. A broken
  // config just means no trails to cycle through.
  const trails = useMemo(() => {
    try {
      return configuredTrails(loadConfig({ config: configPath }).config);
    } catch {
      return [];
    }
  }, [configPath]);
  // Boards for naming imported jobs (I); a broken config means built-ins only.
  const boards = useMemo(() => {
    try {
      return resolveBoards(loadConfig({ config: configPath }).config);
    } catch {
      return resolveBoards({});
    }
  }, [configPath]);
  // Regions from the config; a broken config means one unnamed list.
  const regionEntries = useMemo((): RegionEntry[] => {
    try {
      return configuredRegions(loadConfig({ config: configPath }).config);
    } catch {
      return [];
    }
  }, [configPath]);
  const regionNames = useMemo(
    () => regionEntries.map((r) => r.name),
    [regionEntries],
  );
  // The header strip's regions, and the one being shown (null: no regions).
  const strip = useMemo(
    () => stripRegions(regionNames, jobs),
    [regionNames, jobs],
  );
  const [region, setRegion] = useState<string | null>(() =>
    initialRegion(
      stripRegions(regionNames, jobs),
      getSetting(db, REGION_SETTING),
    ),
  );
  // The view Ctrl+E returns to when leaving Archived.
  const viewBeforeArchive = useRef<ViewTab>("active");
  // A region can leave the strip (unassigned emptied, config changed).
  useEffect(() => {
    if (region === null ? strip.length > 0 : !strip.includes(region)) {
      setRegion(strip[0] ?? null);
    }
  }, [strip, region]);
  useEffect(() => {
    if (region !== null) setSetting(db, REGION_SETTING, region);
  }, [db, region]);

  // The I prompt (link, then trail) while it's open, and the job to select
  // once an import lands in the list.
  const [importPrompt, setImportPrompt] = useState<ImportPrompt | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const pendingSelect = useRef<string | null>(null);

  // The / filter. It applies live while typing, and stays applied after
  // Enter until Esc clears it.
  const [filterQuery, setFilterQuery] = useState("");
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const regionJobs = useMemo(
    () => jobs.filter((job) => inRegion(job, region)),
    [jobs, region],
  );
  const visibleJobs = useMemo(
    () =>
      orderJobs(
        filterJobs(regionJobs, filterQuery),
        viewTab,
        trails,
        tailoredIds,
      ),
    [regionJobs, filterQuery, viewTab, trails, tailoredIds],
  );
  const counts = useMemo(
    () => sectionCounts(visibleJobs, viewTab, trails),
    [visibleJobs, viewTab, trails],
  );

  const selectedJob = visibleJobs[selectedIndex] ?? null;

  // Both the detail box and the footer box share the same layout (outer
  // paddingX 2 + border 1 on each side), so their wrappable text sees the
  // same content width.
  const contentWidth = Math.max(20, columns - 6);

  // The I prompt takes the status line's place. Kept to one line (a long
  // link shows its end) so the list height math below still holds.
  const promptLine = (() => {
    if (isFilterOpen) {
      const hint = "   ↵ keep, Esc clear";
      const room = Math.max(1, contentWidth - hint.length - 2);
      return `/${filterQuery.slice(-room)}▏${hint}`;
    }
    if (!importPrompt) return null;
    if (importPrompt.step === "url") {
      const label = "Import link: ";
      const room = Math.max(1, contentWidth - label.length - 1);
      return `${label}${importPrompt.text.slice(-room)}▏`;
    }
    const choices = [...trails, "none"].map((t, i) =>
      i === importPrompt.index ? `[${t}]` : t,
    );
    return `Trail: ${choices.join(" ")}   ←/→ choose, ↵ import, Esc cancel`;
  })();
  const bottomLine = promptLine ?? statusMessage;

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

  const selectedTags = selectedJob
    ? statusTags(selectedJob, selectedIsTailored === true)
    : [];
  const titleLine = selectedJob
    ? [selectedJob.title, ...selectedTags.map((t) => t.label)].join(" ")
    : "";
  const companyLine = selectedJob
    ? `${selectedJob.company}${
        formatRemote(selectedJob.remoteType)
          ? ` - ${formatRemote(selectedJob.remoteType)}`
          : ""
      } - ${selectedJob.location}`
    : "";

  // Which region's master the tailored resume came from, next to the id.
  const resumeRegion = useMemo(
    () =>
      selectedJob && tailoredIds.has(selectedJob.listingId)
        ? (getTailoredResume(db, selectedJob.listingId)?.region ?? null)
        : null,
    [db, selectedJob, tailoredIds],
  );
  const idLine = selectedJob
    ? `${selectedJob.listingId}${resumeRegion ? `   resume: ${resumeRegion}` : ""}`
    : "";

  const detailContentLines = selectedJob
    ? wrapText(titleLine, contentWidth).length +
      wrapText(companyLine, contentWidth).length +
      wrapText(selectedJob.url, contentWidth).length +
      wrapText(idLine, contentWidth).length
    : 0;

  const footerRegions: FooterRegions = { count: strip.length, current: region };
  const footerLines = wrapText(
    footerPlainText(footerRegions),
    contentWidth,
  ).length;

  // The detail panel and status message are mutually exclusive and occupy
  // very different heights (an ~8-11 line bordered box vs. a single line),
  // so the number of rows available to the scrollable list has to be
  // recomputed for whichever one is actually on screen right now.
  const bottomSectionLines = bottomLine
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
    counts.size * SECTION_HEADER_LINES;

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset only when the region, tab or filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [region, viewTab, filterQuery]);

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

  const handleTrailCycle = useCallback(() => {
    const job = visibleJobs[selectedIndex];
    if (!job) return;
    // No trail, then each configured trail in turn. A trail no longer in the
    // config is left by moving to the first configured one.
    const options: (string | null)[] = [null, ...trails];
    const next =
      options[(options.indexOf(job.trail ?? null) + 1) % options.length] ??
      null;
    setJobTrail(db, job.listingId, next);
    setJobs(allJobs(db));
    showStatus(
      next
        ? `trail ${next}: ${job.title} @ ${job.company}`
        : trails.length > 0
          ? `no trail: ${job.title} @ ${job.company}`
          : 'no trails configured (add trail = "..." to a [[keywords]] entry)',
    );
  }, [db, trails, visibleJobs, selectedIndex, showStatus]);

  const handleImport = useCallback(
    async (url: string, trail: string | null) => {
      setIsImporting(true);
      setStatusMessage("Importing…");
      try {
        const { job, added } = await importJob(
          db,
          url,
          trail,
          boards,
          regionEntries,
          region && region !== UNASSIGNED ? region : undefined,
        );
        pendingSelect.current = job.listingId;
        // A filter could hide the job we're about to select.
        setFilterQuery("");
        setJobs(allJobs(db));
        setViewTab(
          job.state === "archived" || job.state === "applied"
            ? job.state
            : "active",
        );
        // Show it in a region it belongs to.
        if (region !== null && !inRegion(job, region)) {
          setRegion(job.regions[0] ?? UNASSIGNED);
        }
        showStatus(
          `${added ? "Added" : "Already tracked"} ${job.title} @ ${job.company}`,
        );
      } catch (err) {
        showStatus(err instanceof ImportError ? err.message : String(err));
      } finally {
        setIsImporting(false);
      }
    },
    [db, boards, regionEntries, region, showStatus],
  );

  // Select an imported job once it shows up in the (re-sorted) list.
  useEffect(() => {
    const id = pendingSelect.current;
    if (!id) return;
    const index = visibleJobs.findIndex((j) => j.listingId === id);
    if (index === -1) return;
    pendingSelect.current = null;
    setSelectedIndex(index);
  }, [visibleJobs]);

  const handleStateChange = useCallback(
    (state: ListingState) => {
      const job = visibleJobs[selectedIndex];
      if (!job) return;
      // On an archived job A toggles the applied mark without unarchiving.
      if (state === "applied" && job.state === "archived") {
        const now = new Date().toISOString();
        setJobApplied(db, job.listingId, !job.appliedAt, now);
        setJobs(allJobs(db));
        showStatus(
          `${job.appliedAt ? "unmarked applied" : "applied"}: ${job.title} @ ${job.company}`,
        );
        return;
      }
      // Pressing A on an already-applied job undoes it.
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
      const searching = runningRuns(db, "search").length > 0;
      if (prevSearching.current && !searching) {
        setJobs(allJobs(db));
        const run = getRun(db, "search", SEARCH_RUN_KEY);
        // Stays until the next status, so a failure can be read.
        if (run) setStatusMessage(describeSearchRun(run, dbPath));
      }
      prevSearching.current = searching;
      setIsSearching(searching);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [db, dbPath]);

  useEffect(() => {
    if (tailoringIds.size === 0 && !isSearching) return;
    const timer = setInterval(() => setPulseTick((t) => t + 1), PULSE_TICK_MS);
    return () => clearInterval(timer);
  }, [tailoringIds.size, isSearching]);

  const handleTailor = useCallback(() => {
    const job = visibleJobs[selectedIndex];
    if (!job || tailoringIds.has(job.listingId)) return;
    // Detached so it outlives the TUI. TRAILGUIDE_NO_DELEGATE keeps the recorded
    // pid the real worker rather than a checkout-delegating wrapper.
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        `${import.meta.dir}/../cli.ts`,
        "tailor",
        job.listingId,
        "--db",
        dbPath,
        ...(configPath ? ["--config", resolve(configPath)] : []),
        // Tailor with the resume of the region being looked at.
        ...(region && region !== UNASSIGNED ? ["--region", region] : []),
      ],
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, [NO_DELEGATE_ENV]: "1" },
      detached: true,
    });
    proc.unref();
    // Record the child's pid now so the bar pulses immediately, before the
    // child has finished starting up.
    // forChild: a fast child may already have finished its own row.
    startTailorRun(db, job.listingId, proc.pid, undefined, { forChild: true });
    const running = runningTailorIds(db);
    prevRunning.current = running;
    setTailoringIds(running);
    setStatusMessage(
      `Tailoring ${job.title} @ ${job.company} in the background (survives quitting)…`,
    );
  }, [
    db,
    dbPath,
    configPath,
    region,
    visibleJobs,
    selectedIndex,
    tailoringIds,
  ]);

  const handleSearch = useCallback(() => {
    if (region === UNASSIGNED) {
      showStatus("Unassigned is not a region to search: press G to pick one");
      return;
    }
    const result = startBackgroundSearch({
      db,
      dbPath,
      configPath,
      ...(region !== null && { region }),
    });
    if (!result.started) {
      showStatus(result.message);
      return;
    }
    prevSearching.current = true;
    setIsSearching(true);
    setStatusMessage(result.message);
  }, [db, dbPath, configPath, region, showStatus]);

  const handleOpenResume = useCallback(async () => {
    const job = visibleJobs[selectedIndex];
    if (!job) return;
    const record = getTailoredResume(db, job.listingId);
    const pdfPath = record?.markdownPath.replace(/\.md$/, ".pdf");
    if (!pdfPath || !(await Bun.file(pdfPath).exists())) {
      showStatus("No generated resume for this job (press T to tailor one)");
      return;
    }
    openTarget(pdfPath);
    showStatus(`Opened ${pdfPath}`);
  }, [db, visibleJobs, selectedIndex, showStatus]);

  const handleCopyId = useCallback(async () => {
    const job = visibleJobs[selectedIndex];
    if (!job) return;
    showStatus(
      (await copyToClipboard(job.listingId))
        ? `Copied ${job.listingId}`
        : `No clipboard tool found (id: ${job.listingId})`,
    );
  }, [visibleJobs, selectedIndex, showStatus]);

  const handleInput = useCallback(
    (input: string, key: Key) => {
      // While the I prompt is open it gets every key (so q and Esc don't quit).
      if (importPrompt) {
        const result = stepImportPrompt(importPrompt, input, key, trails);
        if ("prompt" in result) {
          setImportPrompt(result.prompt);
          return;
        }
        setImportPrompt(null);
        if ("done" in result) handleImport(result.done.url, result.done.trail);
        return;
      }
      // Likewise for the / filter, except ↑↓ still move through the matches.
      if (isFilterOpen) {
        if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((prev) =>
            Math.min(visibleJobs.length - 1, prev + 1),
          );
          return;
        }
        const result = stepFilterPrompt({ text: filterQuery }, input, key);
        if ("prompt" in result) {
          setFilterQuery(result.prompt.text);
          return;
        }
        setIsFilterOpen(false);
        setFilterQuery("cancelled" in result ? "" : result.done);
        return;
      }
      if (input === "/") {
        setIsFilterOpen(true);
        return;
      }
      // With a filter applied, Esc clears it rather than quitting.
      if (key.escape && filterQuery) {
        setFilterQuery("");
        return;
      }
      if (input === "I") {
        if (!isImporting) setImportPrompt({ step: "url", text: "" });
        return;
      }
      if (key.escape || input === "q") {
        exit();
        return;
      }
      if (input === "R") {
        if (!isRefreshing) handleRefresh();
        return;
      }
      if (input === "S") {
        handleSearch();
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
      if (
        region !== null &&
        strip.length > 1 &&
        (key.leftArrow || key.rightArrow)
      ) {
        setRegion(nextRegion(strip, region, key.rightArrow ? 1 : -1));
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
      if (key.tab) {
        setViewTab((prev) => nextView(prev, "tab", viewBeforeArchive.current));
        return;
      }
      if (key.ctrl && input === "e") {
        setViewTab((prev) => {
          if (prev !== "archived") viewBeforeArchive.current = prev;
          return nextView(prev, "ctrl-e", viewBeforeArchive.current);
        });
        return;
      }
      if (input === "G" && region !== null) {
        setRegion(nextRegion(strip, region));
        return;
      }
      const jump = regionByKey(strip, input);
      if (jump !== null) {
        setRegion(jump);
        return;
      }
      if (key.return) {
        if (selectedJob?.description) {
          setIsExpanded((prev) => !prev);
        }
        return;
      }
      if (input === "O" && selectedJob) {
        openTarget(selectedJob.url);
        return;
      }
      if (input === "Y" && selectedJob) {
        handleCopyId();
        return;
      }
      if (input === "V" && selectedJob) {
        handleOpenResume();
        return;
      }
      if (input === "T" && selectedJob) {
        handleTailor();
        return;
      }
      if (input === "E") {
        handleStateChange("archived");
        return;
      }
      if (input === "A") {
        handleStateChange("applied");
        return;
      }
      if (input === "L") {
        handleTrailCycle();
        return;
      }
    },
    [
      importPrompt,
      isImporting,
      isFilterOpen,
      filterQuery,
      trails,
      handleImport,
      exit,
      visibleJobs.length,
      visibleCount,
      selectedJob,
      selectedJob?.url,
      selectedJob?.description,
      isRefreshing,
      handleRefresh,
      handleStateChange,
      handleTrailCycle,
      handleTailor,
      handleSearch,
      handleOpenResume,
      handleCopyId,
      region,
      strip,
    ],
  );

  useInput(handleInput, { isActive: isRawModeSupported });

  const visibleSlice = useMemo(() => {
    return visibleJobs.slice(scrollOffset, scrollOffset + visibleCount);
  }, [visibleJobs, scrollOffset, visibleCount]);

  const stripCounts = useMemo(() => viewCounts(jobs, region), [jobs, region]);

  return (
    <Box flexDirection="column" height="100%" paddingX={2} overflow="hidden">
      <Box height={HEADER_LINES} justifyContent="space-between">
        <Box flexShrink={1} marginRight={2}>
          <HeaderStrip
            regions={strip}
            current={region}
            view={viewTab}
            counts={stripCounts}
            accent={SAND}
          />
          {isSearching && (
            <Text color={pulseColor(pulseTick)} wrap="truncate-end">
              {"   Searching..."}
            </Text>
          )}
        </Box>
        <Box flexShrink={1} marginRight={CAIRN_WIDTH + 1}>
          {version && (
            <Text dimColor wrap="truncate-start">
              {version}
            </Text>
          )}
        </Box>
      </Box>

      <Box position="absolute" width="100%" justifyContent="flex-end">
        <Box flexDirection="column" width={CAIRN_WIDTH} marginRight={2}>
          {CAIRN.map(({ stone, color }) => (
            <Text key={color} color={color}>
              {stone}
            </Text>
          ))}
        </Box>
      </Box>

      <Box height={GAP_LINE} />

      {/* An applied filter shows on the separator line, so it costs no rows. */}
      {filterQuery && !isFilterOpen ? (
        <Text wrap="truncate-end">
          <Text dimColor>{"── "}</Text>
          <Text color={SAND}>{`/${filterQuery}`}</Text>
          <Text dimColor>
            {` (${visibleJobs.length} ${visibleJobs.length === 1 ? "match" : "matches"}, / edit, Esc clear) ──`}
          </Text>
        </Text>
      ) : (
        <Text dimColor>{"─".repeat(40)}</Text>
      )}

      <Box flexDirection="column" flexGrow={1}>
        {visibleJobs.length === 0 && filterQuery ? (
          <Box flexDirection="column" alignItems="center" marginTop={2}>
            <Text dimColor>No jobs here match "{filterQuery}".</Text>
          </Box>
        ) : visibleJobs.length === 0 ? (
          <Box flexDirection="column" alignItems="center" marginTop={2}>
            <Text dimColor>No jobs found.</Text>
            <Text dimColor>
              Press S to search (run trailguide init first if you have no
              config)
            </Text>
          </Box>
        ) : (
          visibleSlice.map((job, i) => {
            const actualIndex = scrollOffset + i;
            const section = sectionOf(job, viewTab, trails);
            const prev = visibleSlice[i - 1];
            const showHeader =
              i === 0 ||
              (prev && sectionOf(prev, viewTab, trails).id !== section.id);
            return (
              <React.Fragment key={job.listingId}>
                {showHeader && (
                  <Text
                    bold
                    color={TONE_COLORS[section.tone]}
                    dimColor={section.tone === "none"}
                  >
                    {`${section.label} (${counts.get(section.id) ?? 0})`}
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

      {promptLine && (
        <Box marginTop={1}>
          <Text wrap="truncate-end">{promptLine}</Text>
        </Box>
      )}

      {!promptLine && statusMessage && (
        <Box marginTop={1}>
          <Text dimColor>{linkifyPdfPath(statusMessage)}</Text>
        </Box>
      )}

      {selectedJob && !bottomLine && (
        <>
          <Box height={GAP_LINE} />
          <Box
            paddingY={1}
            borderStyle="single"
            borderColor="gray"
            flexDirection="column"
          >
            <Text bold color={SAGE}>
              {selectedJob.title}
              <StatusTags tags={selectedTags} />
            </Text>
            <Text>
              {selectedJob.company}
              {formatRemote(selectedJob.remoteType)
                ? ` - ${formatRemote(selectedJob.remoteType)}`
                : ""}{" "}
              - {selectedJob.location}
            </Text>
            <Text dimColor>{selectedJob.url}</Text>
            <Text dimColor>{idLine}</Text>
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
          {FOOTER_NAV}
          {footerItems(
            selectedIsTailored,
            selectedJob?.state === "archived",
            !!selectedJob?.appliedAt,
            footerRegions,
          ).map((item) => (
            <Text key={item.key}>
              {" | "}
              <Text
                dimColor={false}
                bold={item.active}
                color={item.active ? item.accent : undefined}
              >
                {item.before}
                <Text bold underline dimColor={false} color={SAND}>
                  {item.key}
                </Text>
                {item.after}
              </Text>
            </Text>
          ))}
          {" | "}
          {FOOTER_QUIT}
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
      {/* Thin status slots, packed left in order: applied (blue), tailored
          (green), archived (muted yellow). */}
      {[0, 1, 2].map((slot) => {
        const slots = [
          job.appliedAt ? SKY : null,
          pulse ?? (isTailored ? SAGE : null),
          job.state === "archived" ? TERRACOTTA : null,
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
            <Text bold color={SAGE}>
              ▸{" "}
            </Text>
          )}
          <Text bold={isSelected} color={isSelected ? "white" : undefined}>
            {job.title}
          </Text>
          <Text dimColor> @ {job.company}</Text>
          <StatusTags tags={statusTags(job, isTailored)} />
        </Box>
        <Box marginLeft={isSelected ? 3 : 0}>
          <Text dimColor>
            {formatRemote(job.remoteType)
              ? `${formatRemote(job.remoteType)} - `
              : ""}
            {job.location}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
