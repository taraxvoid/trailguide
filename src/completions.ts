import type { Command, Option } from "commander";

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

interface OptionSpec {
  long?: string;
  short?: string;
  description: string;
  takesValue: boolean;
  choices?: string[];
}

interface CommandSpec {
  name: string;
  description: string;
  options: OptionSpec[];
}

function optionSpec(o: Option): OptionSpec {
  return {
    long: o.long,
    short: o.short,
    description: o.description,
    takesValue: Boolean(o.required || o.optional),
    choices: o.argChoices,
  };
}

/** Read the command tree from commander so completions never drift from the CLI. */
function specs(program: Command): {
  root: CommandSpec;
  commands: CommandSpec[];
} {
  const help = program.createHelp();
  const spec = (c: Command): CommandSpec => ({
    name: c.name(),
    description: c.description(),
    options: help.visibleOptions(c).map(optionSpec),
  });
  return {
    root: spec(program),
    commands: help.visibleCommands(program).map(spec),
  };
}

const flags = (o: OptionSpec) =>
  [o.short, o.long].filter((f): f is string => Boolean(f));

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function bash(program: Command): string {
  const { root, commands } = specs(program);
  const words = (c: CommandSpec) => c.options.flatMap(flags).join(" ");
  const cases = commands
    .map((c) => `    ${c.name}) opts="${words(c)}" ;;`)
    .join("\n");
  return `# bash completion for trailguide
_trailguide() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" opts=""
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${commands.map((c) => c.name).join(" ")} ${words(root)}" -- "$cur"))
    return
  fi
  case "\${COMP_WORDS[1]}" in
${cases}
  esac
  COMPREPLY=($(compgen -W "$opts" -- "$cur"))
}
complete -o default -F _trailguide trailguide
`;
}

const zshQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const zshDesc = (s: string) => oneLine(s).replace(/([[\]])/g, "\\$1");

function zshOption(o: OptionSpec): string {
  const desc = `[${zshDesc(o.description)}]`;
  const action = !o.takesValue
    ? ""
    : o.choices?.length
      ? `:value:(${o.choices.join(" ")})`
      : ":value:_files";
  return flags(o)
    .map((f) => zshQuote(`${f}${desc}${action}`))
    .join(" ");
}

function zsh(program: Command): string {
  const { root, commands } = specs(program);
  const list = commands
    .map(
      (c) =>
        `      ${zshQuote(`${c.name}:${oneLine(c.description).replace(/:/g, "\\:")}`)}`,
    )
    .join("\n");
  const cases = commands
    .map(
      (c) =>
        `    ${c.name}) _arguments -s ${c.options.map(zshOption).join(" ")} '*:argument:_files' ;;`,
    )
    .join("\n");
  return `#compdef trailguide
# zsh completion for trailguide
_trailguide() {
  if (( CURRENT == 2 )); then
    local -a cmds
    cmds=(
${list}
    )
    _describe -t commands 'trailguide command' cmds
    _arguments -s ${root.options.map(zshOption).join(" ")}
    return
  fi
  case $words[2] in
${cases}
  esac
}
if [[ "\${funcstack[1]}" == "_trailguide" ]]; then
  _trailguide "$@"
else
  compdef _trailguide trailguide
fi
`;
}

const fishQuote = (s: string) => `'${oneLine(s).replace(/(['\\])/g, "\\$1")}'`;

function fishOption(cond: string, o: OptionSpec): string {
  let line = `complete -c trailguide ${cond}`;
  if (o.short) line += ` -s ${o.short.replace(/^-/, "")}`;
  if (o.long) line += ` -l ${o.long.replace(/^--/, "")}`;
  if (o.takesValue) {
    line += o.choices?.length ? ` -x -a '${o.choices.join(" ")}'` : " -r";
  }
  return `${line} -d ${fishQuote(o.description)}`;
}

function fish(program: Command): string {
  const { root, commands } = specs(program);
  const lines = ["# fish completion for trailguide"];
  for (const c of commands) {
    lines.push(
      `complete -c trailguide -n __fish_use_subcommand -f -a ${c.name} -d ${fishQuote(c.description)}`,
    );
  }
  for (const o of root.options)
    lines.push(fishOption("-n __fish_use_subcommand", o));
  for (const c of commands) {
    for (const o of c.options) {
      lines.push(fishOption(`-n '__fish_seen_subcommand_from ${c.name}'`, o));
    }
  }
  return `${lines.join("\n")}\n`;
}

export function generateCompletion(
  program: Command,
  shell: CompletionShell,
): string {
  return { bash, zsh, fish }[shell](program);
}
