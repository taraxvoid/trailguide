import { describe, expect, it } from "bun:test";
import type { Key } from "ink";
import {
  type ImportPrompt,
  stepImportPrompt,
} from "../src/tui/importPrompt.ts";

const NO_KEY = {} as Key;
const key = (k: Partial<Key>) => k as Key;
const TRAILS = ["secplat", "platform"];
const URL = "https://job-boards.greenhouse.io/codeorg/jobs/4727981005";

function typed(text: string): ImportPrompt {
  return { step: "url", text };
}

describe("stepImportPrompt", () => {
  it("appends typed and pasted text, dropping line breaks", () => {
    expect(stepImportPrompt(typed(""), "h", NO_KEY, TRAILS)).toEqual({
      prompt: typed("h"),
    });
    expect(stepImportPrompt(typed("h"), `${URL}\r\n`, NO_KEY, TRAILS)).toEqual({
      prompt: typed(`h${URL}`),
    });
  });

  it("removes the last character on backspace or delete", () => {
    expect(
      stepImportPrompt(typed("ab"), "", key({ backspace: true }), TRAILS),
    ).toEqual({ prompt: typed("a") });
    expect(
      stepImportPrompt(typed("ab"), "", key({ delete: true }), TRAILS),
    ).toEqual({ prompt: typed("a") });
  });

  it("needs a link before moving on to the trail", () => {
    expect(
      stepImportPrompt(typed("  "), "", key({ return: true }), TRAILS),
    ).toEqual({ prompt: typed("  ") });
    expect(
      stepImportPrompt(typed(` ${URL} `), "", key({ return: true }), TRAILS),
    ).toEqual({ prompt: { step: "trail", url: URL, index: 0 } });
  });

  it("cycles trails then none, wrapping both ways", () => {
    const at = (index: number): ImportPrompt => ({
      step: "trail",
      url: URL,
      index,
    });
    expect(
      stepImportPrompt(at(0), "", key({ rightArrow: true }), TRAILS),
    ).toEqual({ prompt: at(1) });
    expect(stepImportPrompt(at(2), "l", NO_KEY, TRAILS)).toEqual({
      prompt: at(0),
    });
    expect(
      stepImportPrompt(at(0), "", key({ leftArrow: true }), TRAILS),
    ).toEqual({ prompt: at(2) });
    expect(stepImportPrompt(at(1), "h", NO_KEY, TRAILS)).toEqual({
      prompt: at(0),
    });
  });

  it("finishes with the chosen trail, or null for none", () => {
    const at = (index: number): ImportPrompt => ({
      step: "trail",
      url: URL,
      index,
    });
    expect(stepImportPrompt(at(1), "", key({ return: true }), TRAILS)).toEqual({
      done: { url: URL, trail: "platform" },
    });
    expect(stepImportPrompt(at(2), "", key({ return: true }), TRAILS)).toEqual({
      done: { url: URL, trail: null },
    });
  });

  it("cancels on escape in either step", () => {
    expect(
      stepImportPrompt(typed("x"), "", key({ escape: true }), TRAILS),
    ).toEqual({ cancelled: true });
    expect(
      stepImportPrompt(
        { step: "trail", url: URL, index: 0 },
        "",
        key({ escape: true }),
        TRAILS,
      ),
    ).toEqual({ cancelled: true });
  });

  it("skips the trail step when no trails are configured", () => {
    expect(stepImportPrompt(typed(URL), "", key({ return: true }), [])).toEqual(
      { done: { url: URL, trail: null } },
    );
  });
});
