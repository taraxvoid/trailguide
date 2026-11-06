import { UNASSIGNED } from "../regions.ts";

// The footer is a few labeled rows, most-used first. Operations and state
// changes are Ctrl chords; plain lowercase keys and arrows only move around
// or open things. Colors are names here (App.tsx owns the palette) so this
// stays pure and testable.

export type FooterAccent = "sage" | "sky" | "terracotta";

export interface FooterItem {
  /** The shortcut as shown, e.g. "Ctrl+T" or "j/k". */
  key: string;
  label: string;
  /** Label color while the selected job is in the state this item names. */
  accent?: FooterAccent;
  active?: boolean;
}

export interface FooterGroup {
  name: string;
  items: FooterItem[];
}

export interface FooterContext {
  /** Whether the selected job has a tailored resume; null: no job selected. */
  tailored: boolean | null;
  archived: boolean;
  applied: boolean;
  /** Regions in the header strip; region keys show only with two or more. */
  regionCount: number;
  /** The current region, named on the search item. */
  region: string | null;
}

export const FOOTER_NAME_WIDTH = 6;

export function footerGroups(ctx: FooterContext): FooterGroup[] {
  const searchLabel =
    ctx.region && ctx.region !== UNASSIGNED ? `search ${ctx.region}` : "search";
  const view: FooterItem[] = [
    { key: "Tab", label: "active/applied" },
    { key: "Ctrl+E", label: "view archive" },
  ];
  if (ctx.regionCount > 1) {
    view.push({
      key: "h/l",
      label: `switch region (or 1-${Math.min(9, ctx.regionCount)})`,
    });
  }
  return [
    {
      name: "Main",
      items: [
        {
          key: "Ctrl+T",
          label: ctx.tailored ? "re-tailor" : "tailor",
          accent: "sage",
          active: ctx.tailored !== null,
        },
        {
          key: "Ctrl+A",
          label: "mark applied",
          accent: "sky",
          active: ctx.applied,
        },
      ],
    },
    {
      name: "Job",
      items: [
        { key: "o", label: "open link" },
        { key: "y", label: "copy id" },
        { key: "v", label: "view resume" },
        {
          key: "Ctrl+X",
          label: "archive",
          accent: "terracotta",
          active: ctx.archived,
        },
        { key: "Ctrl+L", label: "cycle trail" },
      ],
    },
    {
      name: "Find",
      items: [
        { key: "/", label: "filter" },
        { key: "Ctrl+S", label: searchLabel },
        { key: "Ctrl+N", label: "import link" },
        { key: "Ctrl+R", label: "refresh" },
      ],
    },
    { name: "View", items: view },
    {
      name: "Move",
      items: [
        { key: "j/k", label: "up/down" },
        { key: "PgUp/PgDn", label: "page" },
        { key: "Enter", label: "expand" },
        { key: "q", label: "quit" },
      ],
    },
  ];
}

/** One group's items flattened, for the wrap-height measurement. */
export function groupPlainText(group: FooterGroup): string {
  return group.items.map((i) => `${i.key} ${i.label}`).join(" | ");
}
