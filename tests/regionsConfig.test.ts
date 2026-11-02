import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  formatConfig,
  type LoadedConfig,
  loadConfig,
  parseConfig,
  resolveResumeDir,
  toSearchOptions,
} from "../src/config.ts";

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a throw");
}

const TWO = `
[region.bay]
work = "in-person"
places = ["East Bay"]

[region.omaha]
places = ["Omaha metro"]
`;

describe("[region.<name>] parsing", () => {
  it("parses regions in file order", () => {
    const config = parseConfig(TWO, "/x/cfg.toml");
    expect(config.regions?.map((r) => r.name)).toEqual(["bay", "omaha"]);
    expect(config.regions?.[0]).toEqual({
      name: "bay",
      work: "in-person",
      places: ["East Bay"],
    });
    expect(config.regions?.[1]?.work).toBe("any");
  });

  it("resolves a relative resumes path against the file", () => {
    const config = parseConfig(
      '[region.bay]\nplaces = ["East Bay"]\nresumes = "r/bay"\n',
      "/x/cfg.toml",
    );
    expect(config.regions?.[0]?.resumes).toBe("/x/r/bay");
  });

  it("rejects [[location]] with the new shape", () => {
    const err = errorOf(() =>
      parseConfig('[[location]]\ncity = "Omaha"\n', "/x/cfg.toml"),
    );
    expect(err.message).toContain(
      "[[location]] was replaced by [region.<name>]",
    );
    expect(err.message).toContain("places = [");
    expect(err.message).toContain("/x/cfg.toml");
  });

  it("rejects a bad region name", () => {
    expect(() =>
      parseConfig('[region.Bay]\nplaces = ["East Bay"]\n', "x.toml"),
    ).toThrow("lowercase");
  });

  it("rejects a region without places", () => {
    expect(() => parseConfig('[region.bay]\nwork = "any"\n', "x.toml")).toThrow(
      'is missing "places"',
    );
  });

  it("rejects unknown region keys", () => {
    expect(() =>
      parseConfig(
        '[region.bay]\nplaces = ["East Bay"]\naliases = ["Milpitas"]\n',
        "x.toml",
      ),
    ).toThrow('unknown key "aliases"');
  });

  it("formatConfig round-trips regions", () => {
    const config = parseConfig(
      `${TWO}\n[region.remote]\nwork = "remote"\nplaces = ["United States"]\nresumes = "/r/remote"\n`,
      "/x/cfg.toml",
    );
    expect(parseConfig(formatConfig(config), "/x/cfg.toml")).toEqual(config);
  });
});

const LOADED: LoadedConfig = {
  files: ["/g/config.toml"],
  config: {
    keywords: [{ role: "swe" }],
    regions: [
      { name: "bay", work: "in-person", places: ["East Bay", "San Francisco"] },
      { name: "remote", work: "remote", places: ["United States"] },
    ],
  },
};

describe("toSearchOptions with regions", () => {
  it("expands each region place into a target", () => {
    expect(toSearchOptions({}, () => LOADED).targets).toEqual([
      { city: "East Bay", flexibility: "in-person", region: "bay" },
      { city: "San Francisco", flexibility: "in-person", region: "bay" },
      { city: "United States", flexibility: "remote", region: "remote" },
    ]);
  });

  it("--region limits targets", () => {
    expect(
      toSearchOptions({ region: ["remote"] }, () => LOADED).targets,
    ).toEqual([
      { city: "United States", flexibility: "remote", region: "remote" },
    ]);
  });

  it("--region rejects unknown names", () => {
    expect(() => toSearchOptions({ region: ["mars"] }, () => LOADED)).toThrow(
      'unknown region "mars" (configured: bay, remote)',
    );
  });

  it("requires a region", () => {
    expect(() =>
      toSearchOptions({}, () => ({
        files: ["/g/config.toml"],
        config: { keywords: [{ role: "swe" }] },
      })),
    ).toThrow("no [region.<name>] configured");
  });

  it("--remote overrides region work", () => {
    const targets = toSearchOptions({ remote: true }, () => LOADED).targets;
    expect(targets.map((t) => t.flexibility)).toEqual([
      "remote",
      "remote",
      "remote",
    ]);
    expect(targets.map((t) => t.region)).toEqual(["bay", "bay", "remote"]);
  });
});

let root: string;
let cwd: string;
let env: Record<string, string>;

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "trailguide-regions-"));
  cwd = join(root, "proj");
  mkdirSync(cwd, { recursive: true });
  env = {
    XDG_CONFIG_HOME: join(root, "cfg"),
    XDG_DATA_HOME: join(root, "data"),
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const globalFile = () => join(root, "cfg", "trailguide", "config.toml");
const localFile = () => join(cwd, "trailguide.toml");

describe("loading regions", () => {
  it("local regions replace global regions", () => {
    write(globalFile(), TWO);
    write(
      localFile(),
      '[region.remote]\nwork = "remote"\nplaces = ["United States"]\n',
    );
    expect(loadConfig({ cwd, env }).config.regions?.map((r) => r.name)).toEqual(
      ["remote"],
    );
  });

  it("local [[location]] error names the local file", () => {
    write(globalFile(), TWO);
    write(localFile(), '[[location]]\ncity = "Austin"\n');
    expect(() => loadConfig({ cwd, env })).toThrow(localFile());
  });

  it("resolveResumeDir uses the region folder", () => {
    write(globalFile(), `[resume]\ndir = "/r"\n${TWO}`);
    expect(resolveResumeDir({ cwd, env }, "bay")).toBe("/r/bay");
    expect(resolveResumeDir({ cwd, env })).toBe("/r");
    write(
      globalFile(),
      '[resume]\ndir = "/r"\n[region.bay]\nplaces = ["East Bay"]\nresumes = "/elsewhere"\n',
    );
    expect(resolveResumeDir({ cwd, env }, "bay")).toBe("/elsewhere");
  });
});
