import { describe, expect, it } from "bun:test";
import {
  globalConfigPath,
  globalDbPath,
  localConfigPath,
} from "../src/paths.ts";

describe("paths", () => {
  it("honors absolute XDG overrides", () => {
    const env = { XDG_CONFIG_HOME: "/x/cfg", XDG_DATA_HOME: "/x/data" };
    expect(globalConfigPath(env)).toBe("/x/cfg/igor/config.toml");
    expect(globalDbPath(env)).toBe("/x/data/igor/igor.db");
  });

  it("falls back to ~/.config and ~/.local/share", () => {
    const env = { HOME: "/home/t" };
    expect(globalConfigPath(env)).toBe("/home/t/.config/igor/config.toml");
    expect(globalDbPath(env)).toBe("/home/t/.local/share/igor/igor.db");
  });

  it("ignores relative XDG values, as the XDG spec requires", () => {
    const env = { HOME: "/home/t", XDG_CONFIG_HOME: "relative/dir" };
    expect(globalConfigPath(env)).toBe("/home/t/.config/igor/config.toml");
  });

  it("puts the local override in the cwd", () => {
    expect(localConfigPath("/work/proj")).toBe("/work/proj/igor.toml");
  });
});
