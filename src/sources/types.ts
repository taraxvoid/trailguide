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
    | "weworkremotely"
    | "workday"
    | "workable"
    /** A non-board page read through its schema.org JobPosting (`trailguide add`). */
    | "web";
  title: string;
  company: string;
  location: string;
  /** Other places the posting lists (e.g. ashby secondary locations). Matching only; not stored. */
  otherLocations?: string[];
  remoteType: RemoteType;
  url: string;
  postedAt: string | null;
  description: string | null;
  /** Resume trail of the keyword that found it, if that keyword names one. */
  trail?: string;
}

export interface SearchParams {
  role: string | string[];
  location?: string | string[];
  remote?: boolean;
  onsite?: boolean;
  /** Reports a problem that skipped part of the search (one board, say). */
  warn?: (message: string) => void;
}

export interface Source {
  name: NormalizedJob["source"];
  /**
   * True when the source applies `location` inside its API query (jsearch,
   * adzuna). The runner calls scoped sources once per (keyword, location)
   * and unscoped ones once, with every keyword and no location.
   */
  scoped: boolean;
  /**
   * False when the source never labels remote jobs (adzuna), so a remote
   * target would spend quota on results the work-type check drops.
   */
  labelsRemote?: boolean;
  search(params: SearchParams): Promise<NormalizedJob[]>;
}
