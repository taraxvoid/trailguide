import seedData from "../../seed/ats-companies.json" with { type: "json" };

export interface SeedCompany {
  company: string;
  ats: "greenhouse" | "lever";
  slug: string;
}

const companies = seedData as SeedCompany[];

export function companiesForAts(ats: SeedCompany["ats"]): SeedCompany[] {
  return companies.filter((c) => c.ats === ats);
}
