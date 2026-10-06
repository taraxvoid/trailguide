import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { ConfigError, parseConfig } from "../src/config.ts";
import { allJobs, openDb, upsertJobs } from "../src/db.ts";
import { type InitIO, parseWork, runInit, terminalIO } from "../src/init.ts";

let root: string;
let env: Record<string, string>;
let logs: string[];

const configPath = () => join(root, "cfg", "igor", "config.toml");
const dbPath = () => join(root, "data", "igor", "igor.db");
const readConfig = () =>
  parseConfig(readFileSync(configPath(), "utf8"), configPath());

function scripted(answers: string[]): InitIO & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    env,
    cwd: root,
    log: (m) => logs.push(m),
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? "";
    },
  };
}

function existingConfig(text = "# mine\n") {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "igor-init-"));
  env = {
    XDG_CONFIG_HOME: join(root, "cfg"),
    XDG_DATA_HOME: join(root, "data"),
  };
  logs = [];
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("parseWork", () => {
  it("maps answers to a flexibility", () => {
    expect(parseWork("r")).toBe("remote");
    expect(parseWork(" Remote ")).toBe("remote");
    expect(parseWork("i")).toBe("in-person");
    expect(parseWork("onsite")).toBe("in-person");
    expect(parseWork("hybrid")).toBe("in-person");
    expect(parseWork("either")).toBe("any");
    expect(parseWork("any")).toBe("any");
    expect(parseWork("")).toBeNull();
    expect(parseWork("banana")).toBeNull();
  });
});

describe("runInit prompts", () => {
  it("reads one location per line, keeping 'Omaha, NE' whole, and asks per location", async () => {
    const io = scripted([
      "Omaha, NE",
      "United States",
      "",
      "software engineer",
      "devops engineer",
      "",
      "p",
      "i",
      "r",
    ]);
    expect(await runInit({}, io)).toBe(true);
    expect(readConfig()).toEqual({
      govmil: false,
      locations: [
        { city: "Omaha, NE", flexibility: "in-person", region: [] },
        { city: "United States", flexibility: "remote", region: [] },
      ],
      keywords: [{ role: "software engineer" }, { role: "devops engineer" }],
    });
    expect(existsSync(dbPath())).toBe(true);
  });

  it("offers 'same for all' first, so one answer covers every location", async () => {
    const io = scripted(["Omaha, NE", "Lincoln, NE", "", "swe", "", "i"]);
    await runInit({}, io);
    expect(readConfig().locations?.map((l) => l.flexibility)).toEqual([
      "in-person",
      "in-person",
    ]);
    expect(io.asked.some((q) => q.includes("same for all"))).toBe(true);
  });

  it("asks once for a single location and defaults to either", async () => {
    const io = scripted(["Omaha, NE", "", "swe", "", ""]);
    await runInit({}, io);
    expect(readConfig().locations?.[0]?.flexibility).toBe("any");
    expect(io.asked.some((q) => q.includes("same for all"))).toBe(false);
  });

  it("gives up with a ConfigError after three empty location lists", async () => {
    await expect(runInit({}, scripted([]))).rejects.toThrow(ConfigError);
  });

  it("prints the resolved paths and next steps", async () => {
    await runInit(
      { location: ["Omaha"], keywords: ["swe"], work: ["any"] },
      scripted([]),
    );
    const text = logs.join("\n");
    expect(text).toContain(configPath());
    expect(text).toContain(dbPath());
    expect(text).toContain("igor tui");
    expect(text).toContain("Ctrl+S");
  });
});

describe("runInit flags", () => {
  it("skips every prompt when all values are given", async () => {
    const io = scripted([]);
    await runInit(
      {
        location: ["Omaha, NE"],
        keywords: ["swe", "sre"],
        work: ["in-person"],
      },
      io,
    );
    expect(io.asked).toEqual([]);
    expect(readConfig().keywords).toEqual([{ role: "swe" }, { role: "sre" }]);
  });

  it("accepts --work per location, split at the last colon", async () => {
    await runInit(
      {
        location: ["Omaha, NE", "United States"],
        keywords: ["swe"],
        work: ["Omaha, NE:in-person", "United States:remote"],
      },
      scripted([]),
    );
    expect(readConfig().locations?.map((l) => l.flexibility)).toEqual([
      "in-person",
      "remote",
    ]);
  });

  it("uses a plain --work as the default next to per-location entries", async () => {
    await runInit(
      {
        location: ["Omaha, NE", "United States"],
        keywords: ["swe"],
        work: ["United States:remote", "in-person"],
      },
      scripted([]),
    );
    expect(readConfig().locations?.map((l) => l.flexibility)).toEqual([
      "in-person",
      "remote",
    ]);
  });

  it("rejects --work that leaves a location uncovered or names an unknown one", async () => {
    await expect(
      runInit(
        {
          location: ["Omaha", "United States"],
          keywords: ["swe"],
          work: ["Omaha:remote"],
        },
        scripted([]),
      ),
    ).rejects.toThrow('no --work entry for "United States"');
    await expect(
      runInit(
        { location: ["Omaha"], keywords: ["swe"], work: ["Reno:remote"] },
        scripted([]),
      ),
    ).rejects.toThrow(/"Reno", which is not one of the locations/);
  });

  it("rejects an invalid --work value", async () => {
    await expect(
      runInit(
        { location: ["Omaha"], keywords: ["swe"], work: ["banana"] },
        scripted([]),
      ),
    ).rejects.toThrow(/invalid work type "banana"/);
  });
});

describe("runInit never destroys anything", () => {
  const flags = { location: ["Omaha"], keywords: ["swe"], work: ["any"] };

  it("asks before overwriting and does nothing if declined", async () => {
    existingConfig();
    const io = scripted([""]); // default answer: no
    expect(await runInit(flags, io)).toBe(false);
    expect(io.asked).toHaveLength(1);
    expect(readFileSync(configPath(), "utf8")).toBe("# mine\n");
    expect(existsSync(dbPath())).toBe(false);
  });

  it("overwrites without asking when --yes is given", async () => {
    existingConfig();
    const io = scripted([]);
    await runInit({ ...flags, yes: true }, io);
    expect(io.asked).toEqual([]);
    expect(readConfig().locations?.[0]?.city).toBe("Omaha");
  });

  it("ignores a local igor.toml when choosing the database", async () => {
    writeFileSync(join(root, "igor.toml"), '[db]\npath = "sandbox.db"\n');
    await runInit(flags, scripted([]));
    expect(existsSync(dbPath())).toBe(true);
    expect(existsSync(join(root, "sandbox.db"))).toBe(false);
  });

  it("keeps an existing database and its jobs", async () => {
    const db = openDb(dbPath());
    upsertJobs(db, [
      {
        sourceId: "1",
        source: "greenhouse",
        title: "SWE",
        company: "Acme",
        location: "Omaha",
        remoteType: "onsite",
        url: "https://e.com/1",
        postedAt: null,
        description: null,
      },
    ]);
    db.close();
    await runInit(flags, scripted([]));
    const again = openDb(dbPath());
    expect(allJobs(again)).toHaveLength(1);
    again.close();
    expect(logs.join("\n")).toContain("Using existing database");
  });
});

describe("terminalIO", () => {
  it("rejects a pending question when input ends before init finishes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = terminalIO(input, output);
    const pending = io.ask("> ");
    input.end();
    await expect(pending).rejects.toThrow("input ended before init finished");
    await expect(io.ask("> ")).rejects.toThrow(ConfigError);
    io.close();
  });

  it("returns typed answers", async () => {
    const input = new PassThrough();
    const io = terminalIO(input, new PassThrough());
    const pending = io.ask("> ");
    input.write("hello\n");
    expect(await pending).toBe("hello");
    io.close();
  });
});
