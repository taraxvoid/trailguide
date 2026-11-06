import { describe, expect, it } from "bun:test";
import { createProgram } from "../src/cli.ts";
import { COMPLETION_SHELLS, generateCompletion } from "../src/completions.ts";

describe("completions", () => {
  const program = createProgram();

  for (const shell of COMPLETION_SHELLS) {
    it(`${shell} script lists every command and a per-command option`, () => {
      const out = generateCompletion(program, shell);
      for (const c of program.commands) expect(out).toContain(c.name());
      expect(out).toContain("completion");
      expect(out).toContain(shell === "fish" ? "-l db" : "--db");
    });
  }

  it("zsh and fish attach --region and its description to the search command", () => {
    const zsh = generateCompletion(program, "zsh");
    expect(zsh).toMatch(/search\) _arguments[^\n]*'--region\[/);
    const fish = generateCompletion(program, "fish");
    expect(fish).toMatch(
      /__fish_seen_subcommand_from search[^\n]*-l region[^\n]* -d '/,
    );
  });

  it("bash completes --region per command from the commander tree", () => {
    expect(generateCompletion(program, "bash")).toMatch(
      /search\) opts="[^"]*--region/,
    );
  });
});
