import { describe, expect, it } from "bun:test";
import { footerGroups } from "../src/tui/footer.ts";

const ctx = {
  tailored: false,
  archived: false,
  applied: false,
  regionCount: 3,
  region: "omaha",
};

const labels = (c = ctx) =>
  footerGroups(c).flatMap((g) => g.items.map((i) => `${i.key} ${i.label}`));

describe("footerGroups", () => {
  it("lists the two main actions first", () => {
    const [main] = footerGroups(ctx);
    expect(main?.name).toBe("Main");
    expect(main?.items.map((i) => i.key)).toEqual(["Ctrl+T", "Ctrl+A"]);
  });

  it("uses Ctrl for operations and plain keys for navigation", () => {
    const keys = footerGroups(ctx).flatMap((g) => g.items.map((i) => i.key));
    for (const k of ["Ctrl+S", "Ctrl+N", "Ctrl+R", "Ctrl+X", "Ctrl+L"])
      expect(keys).toContain(k);
    expect(keys).not.toContain("G");
    expect(keys).not.toContain("S");
  });

  it("names the region actions", () => {
    expect(labels()).toContain("h/l switch region (or 1-3)");
    expect(labels()).toContain("Ctrl+E view archive");
    expect(labels()).toContain("Ctrl+S search omaha");
  });

  it("hides region keys with a single region", () => {
    expect(labels({ ...ctx, regionCount: 1 }).join()).not.toContain("region");
  });

  it("flags re-tailoring and the selected job's state", () => {
    expect(labels({ ...ctx, tailored: true })).toContain("Ctrl+T re-tailor");
    const main = footerGroups({ ...ctx, applied: true })[0];
    expect(main?.items[1]?.active).toBe(true);
  });
});
