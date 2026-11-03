export * from './ast.js';
export * from './checks.js';
export * from './constants.js';
export * from './errors.js';
export * from './grammar.js';
export * from './measure.js';
export * from './model.js';
export { parse } from './parser.js';
export { format } from './format.js';
export {
  DEFAULT_FORMAT,
  readFormatSettings,
  SETTINGS,
  SETTINGS_FILE,
  settingsFileText,
  type FormatSettings,
} from './format-settings.js';
export { resolve, type ResolveOptions } from './resolve.js';
export { render, type RenderOptions } from './render.js';
export { DARK_THEME, DEFAULT_THEME, THEMES, THEME_NAMES, type Theme } from './themes.js';

import { fileChecks, findings, type Checks, type Finding } from './checks.js';
import { SourceError } from './errors.js';
import { blame, parse } from './parser.js';
import { render, type RenderOptions } from './render.js';
import { resolve, type ResolveOptions } from './resolve.js';

/**
 * Source text in, SVG out. The whole pipeline in one call. An error in a
 * statement written over several lines names the line at fault, not the one
 * the statement starts on; see `blame`.
 */
export function compile(source: string, options: ResolveOptions & RenderOptions = {}): string {
  return draw(source, { ...options, checks: false }).svg;
}

export interface DrawOptions extends ResolveOptions, RenderOptions {
  /**
   * Which kinds of finding to look for. Absent: what the file's
   * `diagram checks: (…)` says over the defaults. A function: given that, it
   * returns the checks to run, which is how `--checks` lays itself over the
   * file. `false`: none, as `--no-checks`.
   */
  checks?: false | ((fromFile: Checks) => Checks);
}

/**
 * Source text in; the SVG and the findings about it out. A finding never stops
 * the drawing: it says where the picture, drawn as written, may not read as
 * meant.
 */
export function draw(source: string, options: DrawOptions = {}): { svg: string; findings: Finding[] } {
  const run = (text: string) => {
    const layout = resolve(parse(text), options);
    const svg = render(layout, options);
    if (options.checks === false) return { svg, findings: [] };
    const fromFile = fileChecks(layout);
    return { svg, findings: findings(layout, options.checks ? options.checks(fromFile) : fromFile) };
  };
  try {
    return run(source);
  } catch (error) {
    throw error instanceof SourceError ? blame(source, error, run) : error;
  }
}
