#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { SourceError } from './errors.js';
import { compile } from './index.js';
import { THEME_NAMES, THEMES } from './themes.js';

const USAGE = `reladraw — render a diagram from stated placement

  reladraw <input.reladraw> [-o <output.svg>] [--theme <name>]

  -o, --out   where to write the SVG. Defaults to the input path with
              its extension replaced by .svg. Use - for standard output.
  --theme     render in this theme, whatever the file's \`diagram theme:\`
              says. One of ${THEME_NAMES.join(', ')}.
  -h, --help  print this.
`;

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE);
    return argv.length === 0 ? 1 : 0;
  }

  let input: string | undefined;
  let out: string | undefined;
  let theme: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '-o' || arg === '--out') {
      out = argv[i + 1];
      if (out === undefined) {
        process.stderr.write('reladraw: -o needs a path\n');
        return 1;
      }
      i += 1;
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
    process.stderr.write('reladraw: no input file\n');
    return 1;
  }

  const source = await readFile(input, 'utf8');

  let svg: string;
  try {
    svg = compile(source, {
      ...(theme === undefined ? {} : { theme: THEMES[theme]! }),
      // An icon's file is found from the diagram, not from wherever the tool
      // happens to be run.
      readIconFile: (path) => readFileSync(resolvePath(dirname(input), path), 'utf8'),
    });
  } catch (error) {
    if (error instanceof SourceError) {
      process.stderr.write(`${error.format(input)}\n`);
      return 1;
    }
    throw error;
  }

  if (out === '-') {
    process.stdout.write(svg);
    return 0;
  }

  const target = resolvePath(out ?? input.replace(/\.[^.]+$/, '') + '.svg');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, svg, 'utf8');
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
