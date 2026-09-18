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
import { allJobs, setJobState } from "../db.ts";

interface AppProps {
  db: Database;
}

// Chrome heights below are line counts for the JSX blocks they mirror -
// keep them in sync when the layout changes, since visibleCount depends on
// knowing exactly how many non-list rows are on screen in each state.
const HEADER_LINES = 3; // paddingY 1 (top+bottom) + 1 content line
const GAP_LINE = 1; // blank line between sections
const SEPARATOR_LINES = 1;
const FOOTER_LINES = 6; // marginTop 1 + border 2 + paddingY 2 + content 1
const STATUS_LINES = 2; // marginTop 1 + content 1
const DETAIL_CHROME_LINES = 8; // gap 1 + border 2 + paddingY 2 + title/company/url 3
const DESCRIPTION_PREVIEW_LINES = 2;
const ROW_LINES = 3; // title line + meta line + marginBottom gap, see JobRow

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

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 1))}…`;
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

export default function JobBrowser({ db }: AppProps) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { rows, columns } = useWindowSize();
  const [jobs, setJobs] = useState<StoredJob[]>(() => allJobs(db));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const visibleJobs = useMemo(
    () => jobs.filter((j) => j.state === "active" || j.state === "applied"),
    [jobs],
  );

  const selectedJob = visibleJobs[selectedIndex] ?? null;

  const descriptionCharsPerLine = Math.max(20, columns - 6);
  const descriptionMaxChars =
    descriptionCharsPerLine * DESCRIPTION_PREVIEW_LINES;

  const descriptionLineCount = selectedJob?.description
    ? isExpanded
      ? Math.max(
          1,
          Math.ceil(selectedJob.description.length / descriptionCharsPerLine),
        )
      : DESCRIPTION_PREVIEW_LINES
    : 0;

  // The detail panel and status message are mutually exclusive and occupy
  // very different heights (an ~8-11 line bordered box vs. a single line),
  // so the number of rows available to the scrollable list has to be
  // recomputed for whichever one is actually on screen right now.
  const bottomSectionLines = statusMessage
    ? STATUS_LINES
    : selectedJob
      ? DETAIL_CHROME_LINES +
        (selectedJob.description ? GAP_LINE + descriptionLineCount : 0)
      : 0;

  const chromeLines =
    HEADER_LINES +
    GAP_LINE +
    SEPARATOR_LINES +
    FOOTER_LINES +
    bottomSectionLines;

  const visibleCount = Math.max(
    1,
    Math.floor((rows - chromeLines) / ROW_LINES),
  );

  useEffect(() => {
    setSelectedIndex((prev) =>
      Math.min(prev, Math.max(0, visibleJobs.length - 1)),
    );
  }, [visibleJobs.length]);

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
    const result = await refreshListings(db);
    setJobs(allJobs(db));
    showStatus(
      `Refreshed ${result.checked} (${result.skipped} skipped): ${result.activated} active, ${result.deactivated} inactive`,
    );
  }, [db, showStatus]);

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

  const handleInput = useCallback(
    (input: string, key: Key) => {
      if (key.escape || input === "q") {
        exit();
        return;
      }
      if (key.ctrl && input === "r") {
        handleRefresh();
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
      handleRefresh,
      handleStateChange,
    ],
  );

  useInput(handleInput, { isActive: isRawModeSupported });

  const visibleSlice = useMemo(() => {
    return visibleJobs.slice(scrollOffset, scrollOffset + visibleCount);
  }, [visibleJobs, scrollOffset, visibleCount]);

  const activeCount = visibleJobs.filter((j) => j.state === "active").length;
  const appliedCount = visibleJobs.filter((j) => j.state === "applied").length;

  return (
    <Box flexDirection="column" height="100%" paddingX={2} overflow="hidden">
      <Box paddingY={1} justifyContent="space-between" alignItems="center">
        <Text bold color="green">
          ⚡ igor
        </Text>
        <Text dimColor>
          {activeCount > 0 && `${activeCount} active`}
          {activeCount > 0 && appliedCount > 0 && " · "}
          {appliedCount > 0 && `${appliedCount} applied`}
          {visibleJobs.length === 0 && "no jobs"}
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
            {selectedJob.description && (
              <>
                <Box height={GAP_LINE} />
                <Text dimColor>
                  {isExpanded
                    ? selectedJob.description
                    : truncate(selectedJob.description, descriptionMaxChars)}
                </Text>
              </>
            )}
          </Box>
        </>
      )}

      <Box paddingY={1} marginTop={1} borderStyle="single" borderColor="gray">
        <Text dimColor>
          [↑↓/k/j] navigate [↵] expand/collapse [o] open [e] archive [a] applied
          [⌃r] refresh [q] quit
        </Text>
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
