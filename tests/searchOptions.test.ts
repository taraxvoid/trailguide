import { describe, expect, it } from "bun:test";
import {
  ConfigError,
  type LoadedConfig,
  toSearchOptions,
} from "../src/config.ts";

const NO_FILTER = { excludeClearance: false, excludeTerms: [] };

const LOADED: LoadedConfig = {
  files: ["/g/config.toml"],
  config: {
    clearance: "include",
    keywords: [{ role: "swe" }, { role: "devops" }],
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
      trails: {},
      targets: [{ city: "Omaha", flexibility: "remote", region: [] }],
      filter: NO_FILTER,
    });
  });

  it("has one unrestricted target without --location (today's behavior)", () => {
    expect(
      toSearchOptions(
        { role: ["swe"], onsite: true, excludeClearance: true },
        never,
      ),
    ).toEqual({
      keywords: ["swe"],
      trails: {},
      targets: [{ city: null, flexibility: "in-person", region: [] }],
      filter: { excludeClearance: true, excludeTerms: [] },
    });
  });
});

describe("toSearchOptions from the config", () => {
  it("maps keywords to their trails", () => {
    const plan = toSearchOptions({}, () => ({
      ...LOADED,
      config: {
        ...LOADED.config,
        keywords: [{ role: "swe", trail: "platform" }, { role: "devops" }],
      },
    }));
    expect(plan.keywords).toEqual(["swe", "devops"]);
    expect(plan.trails).toEqual({ swe: "platform" });
  });

  it("crosses keywords with locations, keeping region", () => {
    expect(toSearchOptions({}, () => LOADED)).toEqual({
      keywords: ["swe", "devops"],
      trails: {},
      targets: [
        { city: "Omaha", flexibility: "in-person", region: ["Nebraska"] },
        { city: "United States", flexibility: "remote", region: [] },
      ],
      filter: NO_FILTER,
    });
  });

  it("lets --location, --remote/--onsite and the clearance flags override pieces", () => {
    const relocated = toSearchOptions(
      { location: ["Reno"], excludeClearance: true },
      () => LOADED,
    );
    expect(relocated.targets).toEqual([
      { city: "Reno", flexibility: "any", region: [] },
    ]);
    expect(relocated.filter.excludeClearance).toBe(true);

    const onsite = toSearchOptions({ onsite: true }, () => LOADED);
    expect(onsite.targets.map((t) => t.flexibility)).toEqual([
      "in-person",
      "in-person",
    ]);
  });

  it("takes the clearance setting and extra terms from the config", () => {
    const loaded = {
      ...LOADED,
      config: {
        ...LOADED.config,
        clearance: "exclude" as const,
        excludeTerms: ["Offutt"],
      },
    };
    expect(toSearchOptions({}, () => loaded).filter).toEqual({
      excludeClearance: true,
      excludeTerms: ["Offutt"],
    });
    expect(
      toSearchOptions({ includeClearance: true }, () => loaded).filter
        .excludeClearance,
    ).toBe(false);
    expect(
      toSearchOptions({ excludeClearance: true }, () => LOADED).filter
        .excludeClearance,
    ).toBe(true);
  });

  it("rejects --exclude-clearance with --include-clearance", () => {
    expect(() =>
      toSearchOptions(
        { excludeClearance: true, includeClearance: true },
        () => LOADED,
      ),
    ).toThrow("--exclude-clearance and --include-clearance are mutually");
  });
});

describe("toSearchOptions errors", () => {
  it("rejects --remote together with --onsite", () => {
    expect(() =>
      toSearchOptions({ role: ["x"], remote: true, onsite: true }, never),
    ).toThrow("--remote and --onsite are mutually exclusive");
  });

  it("hints at trailguide init when there is no config and no --role", () => {
    expect(() =>
      toSearchOptions({}, () => ({ config: {}, files: [] })),
    ).toThrow(/trailguide init/);
  });

  it("never allows an unbounded search: locations are required", () => {
    const noLocations: LoadedConfig = {
      files: ["/g/config.toml"],
      config: { keywords: [{ role: "swe" }] },
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
      files: ["/g/config.toml", "/p/trailguide.toml"],
      config: { locations: LOADED.config.locations },
    };
    expect(() => toSearchOptions({}, () => noKeywords)).toThrow(
      "no [[keywords]] configured (/g/config.toml, /p/trailguide.toml)",
    );
  });
});
