export type RemoteType = "remote" | "hybrid" | "onsite" | "unknown";

export interface NormalizedJob {
  /** Stable id assigned by the source (not globally unique across sources). */
  sourceId: string;
  source: "jsearch" | "adzuna" | "greenhouse" | "lever" | "ashby";
  title: string;
  company: string;
  location: string;
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
  search(params: SearchParams): Promise<NormalizedJob[]>;
}
