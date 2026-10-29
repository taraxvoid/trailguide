import { describe, expect, it } from "bun:test";
import { createLimiter, mapLimit } from "../src/limit.ts";

describe("mapLimit", () => {
  it("keeps at most `limit` calls in flight and preserves order", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(n);
      inFlight--;
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(results).toEqual([50, 10, 40, 20, 30, 0]);
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});

describe("createLimiter", () => {
  it("keeps at most `limit` calls in flight across separate callers", async () => {
    const limit = createLimiter(2);
    let inFlight = 0;
    let peak = 0;
    const results = await Promise.all(
      [3, 1, 2, 0, 1].map((n) =>
        limit(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await Bun.sleep(n);
          inFlight--;
          return n;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(results).toEqual([3, 1, 2, 0, 1]);
  });

  it("frees the slot when a call throws", async () => {
    const limit = createLimiter(1);
    await expect(
      limit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await limit(async () => "ok")).toBe("ok");
  });
});
