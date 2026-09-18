export const IGOR_ART = [
  "             .---.",
  "            / O  o \\",
  "            | <  / |",
  "             \\-- /",
  "           .'     '.",
].join("\n");

export const IGOR_QUOTE = ' "Yethhhh... Mithstrethhh..."';

export const IGOR_DISABLE_FLAG = "--no-igor";
export const IGOR_DISABLE_ENV = "IGOR_BANISH";

export function shouldShowIgor(argv: string[]): boolean {
  if (argv.includes(IGOR_DISABLE_FLAG)) return false;
  if (process.env[IGOR_DISABLE_ENV]) return false;
  if (argv.includes("-h") || argv.includes("--help")) return false;
  const subcommand = argv.slice(2).find((arg) => !arg.startsWith("-"));
  if (subcommand === "tui") return false;
  return true;
}

export function displayIgor(): void {
  console.log(IGOR_ART);
  console.log(IGOR_QUOTE);
  console.log("-----------------------------------------");
  console.log(
    `\nBanish with ${IGOR_DISABLE_FLAG} \(or set ${IGOR_DISABLE_ENV}\)`,
  );
}
