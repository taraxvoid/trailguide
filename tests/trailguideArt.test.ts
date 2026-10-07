import { afterEach, describe, expect, it } from "bun:test";
import {
  shouldShowTrailguide,
  TRAILGUIDE_DISABLE_ENV,
  TRAILGUIDE_DISABLE_FLAG,
} from "../src/trailguideArt.ts";

const originalEnvValue = process.env[TRAILGUIDE_DISABLE_ENV];

afterEach(() => {
  if (originalEnvValue === undefined) {
    delete process.env[TRAILGUIDE_DISABLE_ENV];
  } else {
    process.env[TRAILGUIDE_DISABLE_ENV] = originalEnvValue;
  }
});

describe("shouldShowTrailguide", () => {
  it("shows trailguide for init and --version", () => {
    expect(shouldShowTrailguide(["bun", "cli.ts", "init"])).toBe(true);
    expect(
      shouldShowTrailguide(["bun", "cli.ts", "init", "--work", "remote"]),
    ).toBe(true);
    expect(shouldShowTrailguide(["bun", "cli.ts", "--version"])).toBe(true);
    expect(shouldShowTrailguide(["bun", "cli.ts", "-V"])).toBe(true);
  });

  it("stays quiet for everything else", () => {
    for (const sub of ["search", "jobs", "tailor", "config", "refresh"]) {
      expect(shouldShowTrailguide(["bun", "cli.ts", sub])).toBe(false);
    }
    expect(shouldShowTrailguide(["bun", "cli.ts"])).toBe(false);
  });

  it("hides trailguide when the disable flag is passed", () => {
    expect(
      shouldShowTrailguide(["bun", "cli.ts", "init", TRAILGUIDE_DISABLE_FLAG]),
    ).toBe(false);
  });

  it("hides trailguide when the disable env var is set", () => {
    process.env[TRAILGUIDE_DISABLE_ENV] = "1";
    expect(shouldShowTrailguide(["bun", "cli.ts", "init"])).toBe(false);
  });

  it("hides trailguide for -h and --help", () => {
    expect(shouldShowTrailguide(["bun", "cli.ts", "-h"])).toBe(false);
    expect(shouldShowTrailguide(["bun", "cli.ts", "--help"])).toBe(false);
  });

  it("hides trailguide for the tui subcommand", () => {
    expect(shouldShowTrailguide(["bun", "cli.ts", "tui"])).toBe(false);
  });
});
