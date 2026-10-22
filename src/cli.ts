#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { nearMatch, readChecks, type Checks } from './checks.js';
import { SourceError } from './errors.js';
import { draw } from './index.js';
import { THEME_NAMES, THEMES } from './themes.js';

const USAGE = `reladraw — draw a diagram from stated placement

  reladraw render <input.reladraw> [-o <output.svg>] [options]
  reladraw check <input.reladraw> [options]

  render      draw the diagram to an SVG, and print any findings: places
              where the picture, drawn as written, may not read as meant.
  check       lay the diagram out and print only the findings. No SVG is
              written, so a good one is left alone while you iterate.

  -o, --out   where render writes the SVG. Defaults to the input path with
              its extension replaced by .svg. Use - for standard output.
  --theme     render in this theme, whatever the file's \`diagram theme:\`
              says. One of ${THEME_NAMES.join(', ')}.
  --guides    draw the guides: everything written with \`guide\` in front,
              dashed, to see how the picture is built.
  --checks    turn kinds of finding on or off, over what the file says:
              --checks "edge-crossings: on, node-overlap: off"
  --no-checks print no findings. Errors still print.
  -v, --version
              print the version.
  -h, --help  print this.
`;

const COMMANDS = ['render', 'check'] as const;
type Command = (typeof COMMANDS)[number];

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE);
    return argv.length === 0 ? 1 : 0;
  }
  if (argv.includes('-v') || argv.includes('--version')) {
    // package.json ships beside dist/, so the number is the installed one.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  const verb = argv[0]!;
  if (!(COMMANDS as readonly string[]).includes(verb)) {
    // A file where the command goes is the old form, and is told the new one;
    // anything else is a command that does not exist, with the near one.
    if (/\.reladraw$/.test(verb) || existsSync(verb)) {
      process.stderr.write(`reladraw: a command comes first — reladraw render ${argv.join(' ')}\n`);
    } else {
      const near = nearMatch(verb, COMMANDS);
      process.stderr.write(
        `reladraw: there is no command "${verb}"` +
          (near ? ` — did you mean ${near}?\n` : ` — the commands are ${COMMANDS.join(', ')}\n`),
      );
    }
    return 1;
  }
  const command = verb as Command;

  let input: string | undefined;
  let out: string | undefined;
  let theme: string | undefined;
  let checks: string | undefined;
  let noChecks = false;
  let guides = false;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if ((arg === '-o' || arg === '--out') && command === 'render') {
      out = argv[i + 1];
      if (out === undefined) {
        process.stderr.write('reladraw: -o needs a path\n');
        return 1;
      }
      i += 1;
    } else if (arg === '-o' || arg === '--out') {
      process.stderr.write('reladraw: check writes no SVG, so it takes no -o; reladraw render writes one\n');
      return 1;
    } else if (arg === '--theme') {
      theme = argv[i + 1];
      if (theme === undefined) {
        process.stderr.write(`reladraw: --theme needs a name: ${THEME_NAMES.join(', ')}\n`);
        return 1;
      }
      if (THEMES[theme] === undefined) {
        process.stderr.write(
          `reladraw: there is no theme called "${theme}" — the themes are ${THEME_NAMES.join(', ')}\n`,
        );
        return 1;
      }
      i += 1;
    } else if (arg === '--checks') {
      checks = argv[i + 1];
      if (checks === undefined) {
        process.stderr.write('reladraw: --checks needs a list, such as --checks "edge-crossings: on"\n');
        return 1;
      }
      i += 1;
    } else if (arg === '--no-checks') {
      noChecks = true;
    } else if (arg === '--guides') {
      guides = true;
    } else if (arg.startsWith('-') && arg !== '-') {
      process.stderr.write(`reladraw: unknown option ${arg}\n`);
      return 1;
    } else if (input === undefined) {
      input = arg;
    } else {
      process.stderr.write(`reladraw: unexpected argument ${arg}\n`);
      return 1;
    }
  }

  if (input === undefined) {
    process.stderr.write(`reladraw: no input file — reladraw ${command} <input.reladraw>\n`);
    return 1;
  }
  if (noChecks && checks !== undefined) {
    process.stderr.write('reladraw: --no-checks and --checks say opposite things; give one\n');
    return 1;
  }
  if (noChecks && command === 'check') {
    process.stderr.write('reladraw: check with --no-checks would print nothing; reladraw render draws\n');
    return 1;
  }

  // Read once here, so a mistake in --checks is reported before the file is drawn.
  let overChecks: ((fromFile: Checks) => Checks) | undefined;
  if (checks !== undefined) {
    const written = checks;
    try {
      readChecks(written, {} as Checks);
    } catch (error) {
      process.stderr.write(`reladraw: --checks: ${(error as Error).message}\n`);
      return 1;
    }
    overChecks = (fromFile) => readChecks(written, fromFile);
  }

  const source = await readFile(input, 'utf8');

  let drawn: ReturnType<typeof draw>;
  try {
    drawn = draw(source, {
      ...(theme === undefined ? {} : { theme: THEMES[theme]! }),
      ...(guides ? { guides: true } : {}),
      // An icon's file is found from the diagram, not from wherever the tool
      // happens to be run.
      readIconFile: (path) => readFileSync(resolvePath(dirname(input), path), 'utf8'),
      ...(noChecks ? { checks: false as const } : overChecks ? { checks: overChecks } : {}),
    });
  } catch (error) {
    if (error instanceof SourceError) {
      process.stderr.write(`${error.format(input)}\n`);
      return 1;
    }
    throw error;
  }

  for (const finding of drawn.findings) process.stderr.write(`${finding.format(input)}\n`);
  if (command === 'check') return 0;

  if (out === '-') {
    process.stdout.write(drawn.svg);
    return 0;
  }

  const target = resolvePath(out ?? input.replace(/\.[^.]+$/, '') + '.svg');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, drawn.svg, 'utf8');
  process.stderr.write(`${target}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`reladraw: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
