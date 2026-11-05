import { Text } from "ink";
import React from "react";
import type { ViewTab } from "./sections.ts";

const VIEWS: { view: ViewTab; label: string }[] = [
  { view: "active", label: "Active" },
  { view: "applied", label: "Applied" },
  { view: "archived", label: "Archived" },
];

interface HeaderStripProps {
  /** The strip's regions; with fewer than two only the views show. */
  regions: string[];
  current: string | null;
  view: ViewTab;
  counts: Record<ViewTab, number>;
  /** Color for the current region and view. */
  accent: string;
}

/**
 * One header row: the regions (current one highlighted), then the three
 * views with the current region's counts.
 */
export function HeaderStrip({
  regions,
  current,
  view,
  counts,
  accent,
}: HeaderStripProps) {
  const item = (key: string, label: string, on: boolean, gap: boolean) => (
    <React.Fragment key={key}>
      {gap && <Text>{"  "}</Text>}
      <Text bold={on} color={on ? accent : undefined} dimColor={!on}>
        {label}
      </Text>
    </React.Fragment>
  );
  return (
    <Text wrap="truncate-end">
      {regions.length > 1 && (
        <>
          {regions.map((r, i) => item(`r:${r}`, r, r === current, i > 0))}
          <Text dimColor>{"  |  "}</Text>
        </>
      )}
      {VIEWS.map((v, i) =>
        item(
          `v:${v.view}`,
          `${v.label} ${counts[v.view]}`,
          v.view === view,
          i > 0,
        ),
      )}
    </Text>
  );
}
