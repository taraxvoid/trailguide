import pkg from "../package.json" with { type: "json" };

export const USER_AGENT = `igor/${pkg.version} (+https://github.com/taraxvoid/igor)`;

/** Per request; a hung job board must not stall a whole search. */
const TIMEOUT_MS = 20_000;

export type HttpInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

/**
 * `fetch` for third-party job boards: identifies igor in the User-Agent
 * (callers may override it) and gives up after 20 seconds.
 */
export function httpFetch(
  input: string | URL,
  init: HttpInit = {},
): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** GET (or `init`) a JSON document; any non-2xx status throws. */
export async function getJson<T>(
  input: string | URL,
  init: HttpInit = {},
): Promise<T> {
  const res = await httpFetch(input, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}
