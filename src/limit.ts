/**
 * Runs `fn` over `items` with at most `limit` calls in flight, so checking
 * hundreds of listing URLs doesn't open hundreds of connections at once.
 * Results keep the order of `items`.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Returns a wrapper that lets at most `limit` of the calls passed to it run
 * at once; the rest wait their turn in call order.
 */
export function createLimiter(
  limit: number,
): <R>(fn: () => Promise<R>) => Promise<R> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active++;
    }
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
