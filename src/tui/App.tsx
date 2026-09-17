import {
  Box,
  Spacer,
  Text,
  useApp,
  useInput,
  useStdin,
  useWindowSize,
} from "ink";
import React, { useState, useCallback, useEffect, useMemo } from "react";
import type { StoredJob } from "../db.ts";

interface AppProps {
  jobs: StoredJob[];
}

const FIXED_LINES = 9;
const JOB_ROW_LINES = 2;

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

export default function JobBrowser({ jobs }: AppProps) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { rows } = useWindowSize();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  const visibleCount = Math.max(
    1,
    Math.floor((rows - FIXED_LINES) / JOB_ROW_LINES),
  );

  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(0, jobs.length - 1)));
  }, [jobs.length]);

  useEffect(() => {
    setScrollOffset((prev) => {
      if (selectedIndex < prev) return selectedIndex;
      if (selectedIndex >= prev + visibleCount)
        return selectedIndex - visibleCount + 1;
      return prev;
    });
  }, [selectedIndex, visibleCount]);

  const selectedJob = jobs[selectedIndex] ?? null;

  const handleInput = useCallback(
    (
      input: string,
      key: {
        upArrow: boolean;
        downArrow: boolean;
        return: boolean;
        escape: boolean;
      },
    ) => {
      if (key.escape || input === "q") {
        exit();
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(jobs.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        exit();
        return;
      }
    },
    [exit, jobs.length],
  );

  useInput(handleInput, { isActive: isRawModeSupported });

  const visibleJobs = useMemo(() => {
    return jobs.slice(scrollOffset, scrollOffset + visibleCount);
  }, [jobs, scrollOffset, visibleCount]);

  return (
    <Box flexDirection="column" height="100%" paddingX={2}>
      <Box paddingY={1} justifyContent="space-between" alignItems="center">
        <Text bold color="green">
          ⚡ igor
        </Text>
        <Text dimColor>
          {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
        </Text>
      </Box>

      <Spacer />

      <Box flexDirection="column" flexGrow={1}>
        {jobs.length === 0 ? (
          <Box flexDirection="column" alignItems="center" marginTop={2}>
            <Text dimColor>No jobs found.</Text>
            <Text dimColor>Run a search first:</Text>
            <Text dimColor> igor search --role "software engineer"</Text>
          </Box>
        ) : (
          visibleJobs.map((job, i) => {
            const actualIndex = scrollOffset + i;
            return (
              <JobRow
                key={job.dedupeKey}
                job={job}
                isSelected={actualIndex === selectedIndex}
              />
            );
          })
        )}
      </Box>

      {selectedJob && (
        <>
          <Spacer />
          <Box
            paddingY={1}
            borderStyle="single"
            borderColor="gray"
            flexDirection="column"
          >
            <Text bold color="green">
              {selectedJob.title}
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
        <Text dimColor>↑↓ navigate ↵/q quit</Text>
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
