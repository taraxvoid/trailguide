export const TRAILGUIDE_ART = [
  "          .-.",
  "         (___)",
  "       .-------.",
  "      (_________)",
  "     .-----------.",
  "    (_____________)",
  "  ~~~~~~~~~~~~~~~~~~~",
].join("\n");

export const TRAILGUIDE_TAGLINE =
  " trailguide: finds the jobs, rearranges the resume.";

export const TRAILGUIDE_DISABLE_FLAG = "--no-banner";
export const TRAILGUIDE_DISABLE_ENV = "TRAILGUIDE_NO_BANNER";

/** The banner is a greeting: `trailguide init` and `trailguide --version`, nowhere else. */
export function shouldShowTrailguide(argv: string[]): boolean {
  if (argv.includes(TRAILGUIDE_DISABLE_FLAG)) return false;
  if (process.env[TRAILGUIDE_DISABLE_ENV]) return false;
  if (argv.includes("-h") || argv.includes("--help")) return false;
  if (argv.includes("--version") || argv.includes("-V")) return true;
  return argv.slice(2).find((arg) => !arg.startsWith("-")) === "init";
}

export function displayTrailguide(): void {
  console.log(TRAILGUIDE_ART);
  console.log(TRAILGUIDE_TAGLINE);
  console.log("-----------------------------------------");
  console.log(
    `\nHide with ${TRAILGUIDE_DISABLE_FLAG} (or set ${TRAILGUIDE_DISABLE_ENV})`,
  );
}
