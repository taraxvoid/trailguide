import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { cleanGitEnv, formatGitVersion, gitVersion } from "../src/version.ts";

const repo = `${tmpdir()}/trailguide-version-test-${Date.now()}`;

function git(...args: string[]) {
  Bun.spawnSync({
    env: cleanGitEnv(),
    cmd: [
      "git",
      "-C",
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
  });
}

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("gitVersion", () => {
  it("returns null outside a git checkout", () => {
    mkdirSync(repo, { recursive: true });
    expect(gitVersion(repo)).toBeNull();
  });

  it("reads the last commit, branch, and dirty state", async () => {
    git("init", "-q", "-b", "feat/x");
    await Bun.write(`${repo}/a.txt`, "a");
    git("add", "a.txt");
    git("commit", "-q", "-m", "add a thing");

    const clean = gitVersion(repo);
    expect(clean?.subject).toBe("add a thing");
    expect(clean?.branch).toBe("feat/x");
    expect(clean?.dirty).toBe(false);
    expect(clean?.hash).toMatch(/^[0-9a-f]{7,}$/);

    await Bun.write(`${repo}/a.txt`, "b");
    expect(gitVersion(repo)?.dirty).toBe(true);
  });
});

describe("formatGitVersion", () => {
  it("shows branch, hash, dirty marker, and subject", () => {
    expect(
      formatGitVersion({
        hash: "abc1234",
        subject: "fix things",
        branch: "main",
        dirty: true,
      }),
    ).toBe("main@abc1234* fix things");
  });

  it("omits the branch when HEAD is detached", () => {
    expect(
      formatGitVersion({
        hash: "abc1234",
        subject: "fix things",
        branch: null,
        dirty: false,
      }),
    ).toBe("abc1234 fix things");
  });
});
