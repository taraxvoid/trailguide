export const IGOR_ART = [
  "             .---.",
  "            / O  o \\",
  "            | <  / |",
  "             \\-- /",
  "           .'     '.",
].join("\n");

export const IGOR_TAGLINE = " igor: finds the jobs, rearranges the resume.";

export const IGOR_DISABLE_FLAG = "--no-igor";
export const IGOR_DISABLE_ENV = "IGOR_BANISH";

/** The banner is a greeting: `igor init` and `igor --version`, nowhere else. */
export function shouldShowIgor(argv: string[]): boolean {
  if (argv.includes(IGOR_DISABLE_FLAG)) return false;
  if (process.env[IGOR_DISABLE_ENV]) return false;
  if (argv.includes("-h") || argv.includes("--help")) return false;
  if (argv.includes("--version") || argv.includes("-V")) return true;
  return argv.slice(2).find((arg) => !arg.startsWith("-")) === "init";
}

export function displayIgor(): void {
  console.log(IGOR_ART);
  console.log(IGOR_TAGLINE);
  console.log("-----------------------------------------");
  console.log(
    `\nBanish with ${IGOR_DISABLE_FLAG} (or set ${IGOR_DISABLE_ENV})`,
  );
}
