import { createAdzunaSource } from "../src/sources/adzuna.ts";
import { createGreenhouseSource } from "../src/sources/greenhouse.ts";
import { createJobApsSource } from "../src/sources/jobaps.ts";
import { createJSearchSource } from "../src/sources/jsearch.ts";
import { createLeverSource } from "../src/sources/lever.ts";
import { createRemoteOkSource } from "../src/sources/remoteok.ts";
import { createRemotiveSource } from "../src/sources/remotive.ts";
import { createWeWorkRemotelySource } from "../src/sources/weworkremotely.ts";

/**
 * Hits real, live third-party APIs. Not run in CI on every PR (would burn
 * paid quota / hit undocumented rate limits) — run manually or from a
 * separate scheduled job. Skips any source whose credentials aren't set.
 */
async function main() {
  const params = { role: "engineer", location: "Remote" as const };
  let ran = 0;

  for (const source of [
    createGreenhouseSource(),
    createLeverSource(),
    createRemoteOkSource(),
    createRemotiveSource(),
    createWeWorkRemotelySource(),
    createJobApsSource(),
  ]) {
    ran++;
    const jobs = await source.search(params);
    console.log(`[${source.name}] ${jobs.length} jobs`);
  }

  if (process.env.JSEARCH_API_KEY) {
    ran++;
    const jobs = await createJSearchSource(process.env.JSEARCH_API_KEY).search(
      params,
    );
    console.log(`[jsearch] ${jobs.length} jobs`);
  } else {
    console.log("[jsearch] skipped (JSEARCH_API_KEY not set)");
  }

  if (process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) {
    ran++;
    const jobs = await createAdzunaSource(
      process.env.ADZUNA_APP_ID,
      process.env.ADZUNA_APP_KEY,
    ).search(params);
    console.log(`[adzuna] ${jobs.length} jobs`);
  } else {
    console.log("[adzuna] skipped (ADZUNA_APP_ID/ADZUNA_APP_KEY not set)");
  }

  console.log(`\nsmoke-live: ${ran} source(s) queried successfully`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
