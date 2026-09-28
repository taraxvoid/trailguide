import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  formatConfig,
  mergeConfigs,
  parseConfig,
  writeConfig,
} from "../src/config.ts";

const FULL = `
[job]
govmil = true

[db]
path = "sandbox.db"

[[location]]
city = "Omaha"
flexibility = "in-person"
region = ["Nebraska"]

[[location]]
city = "United States"
flexibility = "remote"

[[keywords]]
role = "Software Engineer"

[[keywords]]
role = "DevOps Engineer"
`;

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a throw");
}

describe("parseConfig", () => {
  it("parses every section", () => {
    expect(parseConfig(FULL, "/etc/igor/igor.toml")).toEqual({
      govmil: true,
      db: "/etc/igor/sandbox.db",
      locations: [
        { city: "Omaha", flexibility: "in-person", region: ["Nebraska"] },
        { city: "United States", flexibility: "remote", region: [] },
      ],
      keywords: ["Software Engineer", "DevOps Engineer"],
    });
  });

  it("defaults flexibility to any and accepts region as a single string", () => {
    const config = parseConfig(
      '[[location]]\ncity = "Austin"\nregion = "Texas"\n',
      "igor.toml",
    );
    expect(config.locations).toEqual([
      { city: "Austin", flexibility: "any", region: ["Texas"] },
    ]);
  });

  it("keeps a city with a comma as one location", () => {
    const config = parseConfig('[[location]]\ncity = "Omaha, NE"\n', "x.toml");
    expect(config.locations?.[0]?.city).toBe("Omaha, NE");
  });

  it("keeps absolute db paths as they are", () => {
    expect(parseConfig('[db]\npath = "/data/x.db"\n', "igor.toml").db).toBe(
      "/data/x.db",
    );
  });

  it("rejects typo'd table names at the top level", () => {
    expect(() => parseConfig('[[keyword]]\nrole = "x"\n', "igor.toml")).toThrow(
      'igor.toml: top level has unknown key "keyword" (expected job, db, location, keywords)',
    );
    expect(() =>
      parseConfig('[[locations]]\ncity = "x"\n', "igor.toml"),
    ).toThrow('unknown key "locations"');
  });

  it("rejects unknown keys inside known tables", () => {
    expect(() => parseConfig("[job]\nclearance = true\n", "igor.toml")).toThrow(
      'igor.toml: [job] has unknown key "clearance" (expected govmil)',
    );
    expect(() =>
      parseConfig(
        '[[keywords]]\nrole = "A"\n[[keywords]]\nname = "B"\n',
        "igor.toml",
      ),
    ).toThrow('igor.toml: [[keywords]] entry 2 has unknown key "name"');
  });

  it("names the entry that is missing a field", () => {
    expect(() =>
      parseConfig(
        '[[keywords]]\nrole = "A"\n[[keywords]]\nrole = ""\n',
        "igor.toml",
      ),
    ).toThrow('igor.toml: [[keywords]] entry 2 is missing "role"');
    expect(() =>
      parseConfig(
        '[[location]]\ncity = "A"\n[[location]]\nflexibility = "any"\n',
        "igor.toml",
      ),
    ).toThrow('igor.toml: [[location]] entry 2 is missing "city"');
  });

  it("rejects wrong types", () => {
    expect(() => parseConfig('[job]\ngovmil = "yes"\n', "igor.toml")).toThrow(
      'igor.toml: [job] "govmil" must be true or false',
    );
    expect(() =>
      parseConfig('[[location]]\ncity = "A"\nregion = [1]\n', "igor.toml"),
    ).toThrow(
      'igor.toml: [[location]] entry 1 "region" must be a string or a list of strings',
    );
    expect(() => parseConfig("[[keywords]]\nrole = 3\n", "igor.toml")).toThrow(
      'igor.toml: [[keywords]] entry 1 "role" must be a string',
    );
    expect(() => parseConfig('keywords = "swe"\n', "igor.toml")).toThrow(
      'igor.toml: "keywords" must be written as [[keywords]] tables',
    );
  });

  it("rejects an invalid flexibility and lists the valid ones", () => {
    expect(() =>
      parseConfig(
        '[[location]]\ncity = "A"\nflexibility = "onsite"\n',
        "igor.toml",
      ),
    ).toThrow(
      'igor.toml: [[location]] entry 1 has invalid flexibility "onsite" (use remote, in-person, or any)',
    );
  });

  it("reports TOML syntax errors as file:line:col: message", () => {
    const first = errorOf(() => parseConfig("[[location\n", "bad.toml"));
    expect(first).toBeInstanceOf(ConfigError);
    expect(first.message).toMatch(/^bad\.toml:1:\d+: \S/);
    expect(first.message).not.toContain("\n");
    expect(first.message).not.toContain("Invalid TOML document");

    const second = errorOf(() =>
      parseConfig('[job]\ngovmil = "unterminated\n', "bad.toml"),
    );
    expect(second.message).toMatch(/^bad\.toml:2:\d+: \S/);
  });
});

describe("mergeConfigs", () => {
  const base = parseConfig(FULL, "/g/config.toml");

  it("replaces lists wholesale and overrides scalars per key", () => {
    const local = parseConfig(
      '[job]\ngovmil = false\n[[location]]\ncity = "Austin"\n',
      "/l/igor.toml",
    );
    const merged = mergeConfigs(base, local);
    expect(merged.govmil).toBe(false);
    expect(merged.locations).toEqual([
      { city: "Austin", flexibility: "any", region: [] },
    ]);
    expect(merged.keywords).toEqual(["Software Engineer", "DevOps Engineer"]);
    expect(merged.db).toBe("/g/sandbox.db");
  });

  it("leaves the base untouched when the override is empty", () => {
    expect(mergeConfigs(base, {})).toEqual(base);
  });
});

describe("formatConfig / writeConfig", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("round-trips through parseConfig", () => {
    const config = parseConfig(FULL, "/etc/igor/igor.toml");
    expect(parseConfig(formatConfig(config), "/etc/igor/igor.toml")).toEqual(
      config,
    );
  });

  it("escapes quotes and omits empty regions", () => {
    const text = formatConfig({
      locations: [{ city: "Omaha, NE", flexibility: "any", region: [] }],
      keywords: ['C "sharp" dev'],
    });
    expect(text).not.toContain("region");
    expect(parseConfig(text, "x.toml").keywords).toEqual(['C "sharp" dev']);
  });

  it("writes the file, creating missing directories", () => {
    dir = mkdtempSync(join(tmpdir(), "igor-config-"));
    const path = join(dir, "a", "b", "config.toml");
    writeConfig(path, { govmil: false, keywords: ["swe"] });
    expect(parseConfig(readFileSync(path, "utf8"), path)).toEqual({
      govmil: false,
      keywords: ["swe"],
    });
  });
});
