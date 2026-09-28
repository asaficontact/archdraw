export * from './ast.js';
export * from './constants.js';
export * from './errors.js';
export * from './grammar.js';
export * from './measure.js';
export * from './model.js';
export { parse } from './parser.js';
export { resolve, type ResolveOptions } from './resolve.js';
export { render, type RenderOptions } from './render.js';
export { DARK_THEME, DEFAULT_THEME, THEMES, THEME_NAMES, type Theme } from './themes.js';

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
  const run = (text: string) => render(resolve(parse(text), options), options);
  try {
    return run(source);
  } catch (error) {
    throw error instanceof SourceError ? blame(source, error, run) : error;
  }
}
