import { describe, expect, it } from "bun:test";
import {
  ConfigError,
  type LoadedConfig,
  toSearchOptions,
} from "../src/config.ts";

const LOADED: LoadedConfig = {
  files: ["/g/config.toml"],
  config: {
    govmil: false,
    keywords: ["swe", "devops"],
    locations: [
      { city: "Omaha", flexibility: "in-person", region: ["Nebraska"] },
      { city: "United States", flexibility: "remote", region: [] },
    ],
  },
};

const never = (): LoadedConfig => {
  throw new Error("config must not be read");
};

describe("toSearchOptions with --role", () => {
  it("uses the flags alone and never reads the config", () => {
    expect(
      toSearchOptions(
        { role: ["swe"], location: ["Omaha"], remote: true },
        never,
      ),
    ).toEqual({
      keywords: ["swe"],
      targets: [{ city: "Omaha", flexibility: "remote", region: [] }],
      govmil: false,
    });
  });

  it("has one unrestricted target without --location (today's behavior)", () => {
    expect(
      toSearchOptions({ role: ["swe"], onsite: true, clearance: true }, never),
    ).toEqual({
      keywords: ["swe"],
      targets: [{ city: null, flexibility: "in-person", region: [] }],
      govmil: true,
    });
  });
});

describe("toSearchOptions from the config", () => {
  it("crosses keywords with locations, keeping region", () => {
    expect(toSearchOptions({}, () => LOADED)).toEqual({
      keywords: ["swe", "devops"],
      targets: [
        { city: "Omaha", flexibility: "in-person", region: ["Nebraska"] },
        { city: "United States", flexibility: "remote", region: [] },
      ],
      govmil: false,
    });
  });

  it("lets --location, --remote/--onsite and --clearance override pieces", () => {
    const relocated = toSearchOptions(
      { location: ["Reno"], clearance: true },
      () => LOADED,
    );
    expect(relocated.targets).toEqual([
      { city: "Reno", flexibility: "any", region: [] },
    ]);
    expect(relocated.govmil).toBe(true);

    const onsite = toSearchOptions({ onsite: true }, () => LOADED);
    expect(onsite.targets.map((t) => t.flexibility)).toEqual([
      "in-person",
      "in-person",
    ]);
  });

  it("honors govmil from the config", () => {
    const loaded = { ...LOADED, config: { ...LOADED.config, govmil: true } };
    expect(toSearchOptions({}, () => loaded).govmil).toBe(true);
  });
});

describe("toSearchOptions errors", () => {
  it("rejects --remote together with --onsite", () => {
    expect(() =>
      toSearchOptions({ role: ["x"], remote: true, onsite: true }, never),
    ).toThrow("--remote and --onsite are mutually exclusive");
  });

  it("hints at igor init when there is no config and no --role", () => {
    expect(() =>
      toSearchOptions({}, () => ({ config: {}, files: [] })),
    ).toThrow(/igor init/);
  });

  it("never allows an unbounded search: locations are required", () => {
    const noLocations: LoadedConfig = {
      files: ["/g/config.toml"],
      config: { keywords: ["swe"] },
    };
    expect(() => toSearchOptions({}, () => noLocations)).toThrow(ConfigError);
    expect(() => toSearchOptions({}, () => noLocations)).toThrow(
      "no [[location]] configured (/g/config.toml)",
    );
    // --location supplies what the config lacks.
    expect(
      toSearchOptions({ location: ["Omaha"] }, () => noLocations).targets,
    ).toHaveLength(1);
  });

  it("requires keywords", () => {
    const noKeywords: LoadedConfig = {
      files: ["/g/config.toml", "/p/igor.toml"],
      config: { locations: LOADED.config.locations },
    };
    expect(() => toSearchOptions({}, () => noKeywords)).toThrow(
      "no [[keywords]] configured (/g/config.toml, /p/igor.toml)",
    );
  });
});
