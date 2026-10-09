import { afterEach, describe, expect, it } from "bun:test";
import {
  IGOR_DISABLE_ENV,
  IGOR_DISABLE_FLAG,
  shouldShowIgor,
} from "../src/igorArt.ts";

const originalEnvValue = process.env[IGOR_DISABLE_ENV];

afterEach(() => {
  if (originalEnvValue === undefined) {
    delete process.env[IGOR_DISABLE_ENV];
  } else {
    process.env[IGOR_DISABLE_ENV] = originalEnvValue;
  }
});

describe("shouldShowIgor", () => {
  it("shows igor for init and --version", () => {
    expect(shouldShowIgor(["bun", "cli.ts", "init"])).toBe(true);
    expect(shouldShowIgor(["bun", "cli.ts", "init", "--work", "remote"])).toBe(
      true,
    );
    expect(shouldShowIgor(["bun", "cli.ts", "--version"])).toBe(true);
    expect(shouldShowIgor(["bun", "cli.ts", "-V"])).toBe(true);
  });

  it("stays quiet for everything else", () => {
    for (const sub of ["search", "jobs", "tailor", "config", "refresh"]) {
      expect(shouldShowIgor(["bun", "cli.ts", sub])).toBe(false);
    }
    expect(shouldShowIgor(["bun", "cli.ts"])).toBe(false);
  });

  it("hides igor when the disable flag is passed", () => {
    expect(shouldShowIgor(["bun", "cli.ts", "init", IGOR_DISABLE_FLAG])).toBe(
      false,
    );
  });

  it("hides igor when the disable env var is set", () => {
    process.env[IGOR_DISABLE_ENV] = "1";
    expect(shouldShowIgor(["bun", "cli.ts", "init"])).toBe(false);
  });

  it("hides igor for -h and --help", () => {
    expect(shouldShowIgor(["bun", "cli.ts", "-h"])).toBe(false);
    expect(shouldShowIgor(["bun", "cli.ts", "--help"])).toBe(false);
  });

  it("hides igor for the tui subcommand", () => {
    expect(shouldShowIgor(["bun", "cli.ts", "tui"])).toBe(false);
  });
});
