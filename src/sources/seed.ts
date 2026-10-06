import seedData from "../../seed/ats-companies.json" with { type: "json" };

export interface SeedCompany {
  company: string;
  ats: "greenhouse" | "lever" | "ashby" | "workday";
  /** Board id; for workday, the tenant (<tenant>.<host>.myworkdayjobs.com). */
  slug: string;
  /** Workday only: the wdN host and the career site name from the board URL. */
  host?: string;
  site?: string;
}

const companies = seedData as SeedCompany[];

export function companiesForAts(ats: SeedCompany["ats"]): SeedCompany[] {
  return companies.filter((c) => c.ats === ats);
}
