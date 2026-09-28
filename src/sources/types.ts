export type RemoteType = "remote" | "hybrid" | "onsite" | "unknown";

export interface NormalizedJob {
  /** Stable id assigned by the source (not globally unique across sources). */
  sourceId: string;
  source:
    | "jsearch"
    | "adzuna"
    | "greenhouse"
    | "lever"
    | "ashby"
    | "remoteok"
    | "remotive"
    | "jobaps"
    | "weworkremotely";
  title: string;
  company: string;
  location: string;
  /** Other places the posting lists (e.g. ashby secondary locations). Matching only; not stored. */
  otherLocations?: string[];
  remoteType: RemoteType;
  url: string;
  postedAt: string | null;
  description: string | null;
}

export interface SearchParams {
  role: string | string[];
  location?: string | string[];
  remote?: boolean;
  onsite?: boolean;
}

export interface Source {
  name: NormalizedJob["source"];
  /**
   * True when the source applies `location` inside its API query (jsearch,
   * adzuna). The runner calls scoped sources once per (keyword, location)
   * and unscoped ones once per keyword with no location.
   */
  scoped: boolean;
  search(params: SearchParams): Promise<NormalizedJob[]>;
}
