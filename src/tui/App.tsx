import type { Database } from "bun:sqlite";
import {
  Box,
  type Key,
  Spacer,
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

const FIXED_LINES = 8;

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
  const { rows } = useWindowSize();
  const [jobs, setJobs] = useState<StoredJob[]>(() => allJobs(db));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const visibleJobs = useMemo(
    () => jobs.filter((j) => j.state === "active" || j.state === "applied"),
    [jobs],
  );

  const visibleCount = Math.max(1, rows - FIXED_LINES);

  useEffect(() => {
    setSelectedIndex((prev) =>
      Math.min(prev, Math.max(0, visibleJobs.length - 1)),
    );
  }, [visibleJobs.length]);

  useEffect(() => {
    setScrollOffset((prev) => {
      if (selectedIndex < prev) return selectedIndex;
      if (selectedIndex >= prev + visibleCount)
        return selectedIndex - visibleCount + 1;
      return prev;
    });
  }, [selectedIndex, visibleCount]);

  const selectedJob = visibleJobs[selectedIndex] ?? null;

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
        exit();
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

      <Spacer />

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
          <Spacer />
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
                <Spacer />
                <Text dimColor>{truncate(selectedJob.description, 300)}</Text>
              </>
            )}
          </Box>
        </>
      )}

      <Box paddingY={1} marginTop={1} borderStyle="single" borderColor="gray">
        <Text dimColor>
          [↑↓/k/j] navigate [↵] select [o] open [e] archive [a] applied [⌃r]
          refresh [q] quit
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
      paddingY={0.5}
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
