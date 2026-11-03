import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  delegateTarget,
  findCheckout,
  NO_DELEGATE_ENV,
} from "../src/checkout.ts";

const root = `${tmpdir()}/trailguide-checkout-test-${Date.now()}`;
const main = `${root}/trailguide`;
const worktree = `${main}/.claude/worktrees/feature`;
const other = `${root}/not-trailguide`;

async function fakeCheckout(dir: string, name = "trailguide") {
  await Bun.write(`${dir}/package.json`, JSON.stringify({ name }));
  await Bun.write(`${dir}/src/cli.ts`, "");
}

await fakeCheckout(main);
await fakeCheckout(worktree);
await fakeCheckout(other, "something-else");
mkdirSync(`${worktree}/output/resumes`, { recursive: true });

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("findCheckout", () => {
  it("finds the nearest checkout, so a nested worktree wins over main", () => {
    expect(findCheckout(`${worktree}/output/resumes`)).toBe(worktree);
    expect(findCheckout(`${main}/src`)).toBe(main);
  });

  it("ignores other projects and returns null outside any checkout", () => {
    expect(findCheckout(other)).toBeNull();
    expect(findCheckout(root)).toBeNull();
  });
});

describe("delegateTarget", () => {
  it("hands off to the checkout the current directory is in", () => {
    expect(delegateTarget(worktree, main, {})).toBe(`${worktree}/src/cli.ts`);
  });

  it("keeps running itself inside its own checkout or outside any", () => {
    expect(delegateTarget(`${main}/src`, main, {})).toBeNull();
    expect(delegateTarget(root, main, {})).toBeNull();
  });

  it("can be switched off", () => {
    expect(
      delegateTarget(worktree, main, { [NO_DELEGATE_ENV]: "1" }),
    ).toBeNull();
  });
});
