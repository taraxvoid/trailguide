import { stripHtml } from "./html.ts";
import { matchesLocation } from "./location.ts";
import { toArray } from "./params.ts";
import type { NormalizedJob, SearchParams, Source } from "./types.ts";

interface RemoteOkJob {
  id: string;
  position: string;
  company: string;
  location: string;
  tags?: string[];
  description: string;
  date: string;
  url: string;
}

function matchesRole(job: RemoteOkJob, role: string | string[]): boolean {
  return toArray(role).some((r) => {
    const needle = r.toLowerCase();
    return (
      job.position.toLowerCase().includes(needle) ||
      (job.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
    );
  });
}

export function createRemoteOkSource(): Source {
  return {
    name: "remoteok",
    scoped: false,
    async search(params: SearchParams): Promise<NormalizedJob[]> {
      const res = await fetch("https://remoteok.com/api", {
        headers: { "User-Agent": "igor-job-search" },
      });
      if (!res.ok) {
        throw new Error(
          `RemoteOK request failed: ${res.status} ${await res.text()}`,
        );
      }

      // The first array element is always a legal notice, not a job.
      const body = (await res.json()) as (Partial<RemoteOkJob> & {
        legal?: string;
      })[];
      return body
        .filter((job): job is RemoteOkJob => Boolean(job.id))
        .filter((job) => matchesRole(job, params.role))
        .filter(
          (job) =>
            !params.location ||
            !job.location ||
            matchesLocation(job.location, params.location),
        )
        .map((job) => ({
          sourceId: job.id,
          source: "remoteok",
          title: job.position,
          company: job.company,
          location: job.location || "Worldwide",
          remoteType: "remote",
          url: job.url,
          postedAt: job.date,
          description: stripHtml(job.description),
        }));
    },
  };
}
