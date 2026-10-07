import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describeConfig, loadConfig, resolveDbPath } from "../src/config.ts";

let root: string;
let cwd: string;
let env: Record<string, string>;

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const globalFile = () => join(root, "cfg", "trailguide", "config.toml");
const localFile = () => join(cwd, "trailguide.toml");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "trailguide-load-"));
  cwd = join(root, "proj");
  mkdirSync(cwd, { recursive: true });
  env = {
    XDG_CONFIG_HOME: join(root, "cfg"),
    XDG_DATA_HOME: join(root, "data"),
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadConfig", () => {
  it("returns an empty config when no file exists", () => {
    expect(loadConfig({ cwd, env })).toEqual({ config: {}, files: [] });
  });

  it("layers the local file over the global one", () => {
    write(
      globalFile(),
      '[filter]\nclearance = "exclude"\n[[location]]\ncity = "Omaha"\n[[keywords]]\nrole = "swe"\n',
    );
    write(localFile(), '[[location]]\ncity = "Austin"\n');
    const { config, files } = loadConfig({ cwd, env });
    expect(files).toEqual([globalFile(), localFile()]);
    expect(config.clearance).toBe("exclude");
    expect(config.locations).toEqual([
      { city: "Austin", flexibility: "any", region: [] },
    ]);
    expect(config.keywords).toEqual([{ role: "swe" }]);
  });

  it("uses only the explicit --config file, ignoring the chain", () => {
    write(localFile(), '[[location]]\ncity = "Austin"\n');
    write(join(root, "other.toml"), '[[location]]\ncity = "Reno"\n');
    const { config, files } = loadConfig({
      cwd,
      env,
      config: join(root, "other.toml"),
    });
    expect(files).toEqual([join(root, "other.toml")]);
    expect(config.locations?.[0]?.city).toBe("Reno");
  });

  it("honors TRAILGUIDE_CONFIG the same way, with the flag winning", () => {
    write(join(root, "env.toml"), '[[location]]\ncity = "Env"\n');
    write(join(root, "flag.toml"), '[[location]]\ncity = "Flag"\n');
    const envConfig = { ...env, TRAILGUIDE_CONFIG: join(root, "env.toml") };
    expect(
      loadConfig({ cwd, env: envConfig }).config.locations?.[0]?.city,
    ).toBe("Env");
    expect(
      loadConfig({ cwd, env: envConfig, config: join(root, "flag.toml") })
        .config.locations?.[0]?.city,
    ).toBe("Flag");
  });

  it("errors when an explicit config file is missing", () => {
    expect(() =>
      loadConfig({ cwd, env, config: join(root, "nope.toml") }),
    ).toThrow(`config file not found: ${join(root, "nope.toml")}`);
  });

  it("names the offending file for a malformed config", () => {
    write(localFile(), "[[keyword]]\nrole = 'x'\n");
    expect(() => loadConfig({ cwd, env })).toThrow(
      `${localFile()}: top level has unknown key "keyword"`,
    );
  });

  it("re-reads the files on every call", () => {
    write(localFile(), '[[keywords]]\nrole = "a"\n');
    expect(loadConfig({ cwd, env }).config.keywords).toEqual([{ role: "a" }]);
    write(localFile(), '[[keywords]]\nrole = "b"\n');
    expect(loadConfig({ cwd, env }).config.keywords).toEqual([{ role: "b" }]);
  });
});

describe("resolveDbPath", () => {
  it("defaults to the global data dir", () => {
    expect(resolveDbPath({ cwd, env })).toBe(
      join(root, "data", "trailguide", "trailguide.db"),
    );
  });

  it("prefers flag, then TRAILGUIDE_DB, then config, then default", () => {
    write(localFile(), '[db]\npath = "/from/config.db"\n');
    expect(resolveDbPath({ cwd, env })).toBe("/from/config.db");
    const withEnv = { ...env, TRAILGUIDE_DB: "/from/env.db" };
    expect(resolveDbPath({ cwd, env: withEnv })).toBe("/from/env.db");
    expect(resolveDbPath({ cwd, env: withEnv, db: "/from/flag.db" })).toBe(
      "/from/flag.db",
    );
  });

  it("makes relative flag and env values absolute against the cwd", () => {
    expect(resolveDbPath({ cwd, env, db: "x.db" })).toBe(join(cwd, "x.db"));
    expect(resolveDbPath({ cwd, env: { ...env, TRAILGUIDE_DB: "y.db" } })).toBe(
      join(cwd, "y.db"),
    );
  });

  it("does not read the config when --db decides", () => {
    write(localFile(), "not toml at all [[[");
    expect(resolveDbPath({ cwd, env, db: "/abs.db" })).toBe("/abs.db");
  });

  it("resolves a relative [db] path against the config file's directory", () => {
    write(localFile(), '[db]\npath = "sandbox.db"\n');
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    expect(resolveDbPath({ cwd: elsewhere, env, config: localFile() })).toBe(
      join(cwd, "sandbox.db"),
    );
    expect(resolveDbPath({ cwd, env })).toBe(join(cwd, "sandbox.db"));
  });
});

describe("describeConfig", () => {
  it("lists files, the db path, and the merged config", () => {
    write(
      localFile(),
      '[[location]]\ncity = "Omaha"\nflexibility = "remote"\n',
    );
    const text = describeConfig({ cwd, env });
    expect(text).toContain(localFile());
    expect(text).toContain(
      `database: ${join(root, "data", "trailguide", "trailguide.db")}`,
    );
    expect(text).toContain('city = "Omaha"');
  });

  it("points at trailguide init when there is no config", () => {
    expect(describeConfig({ cwd, env })).toContain('run "trailguide init"');
  });
});
