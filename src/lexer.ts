import { SourceError } from './errors.js';

export interface Token {
  text: string;
  /** True when the token came from a quoted string, so `foo:` inside it is literal. */
  quoted: boolean;
  /** True when the string was written between `"""` marks. */
  triple?: boolean;
  /**
   * The whole word as written, on a key split from its value: `gap:tight` lexes
   * as `gap:` and `tight`, and this is `gap:tight` on the first. Kept so an error
   * about the word can quote what the author typed.
   */
  joined?: string;
}

/**
 * A key written against its value. The key part is spelled as the highlighter's
 * attribute pattern spells one, and a value opening with a slash is left whole,
 * so a file name such as `C:/icons/disk.svg` is not torn at the drive letter.
 */
const JOINED_KEY = /^([A-Za-z][A-Za-z0-9_-]*:)([^/\\].*)$/;

/**
 * A `"""` string still open at the end of the text given. `parse` catches this
 * one, adds the next line and tries again, which is how a string runs over
 * several lines without the lexer having to know about lines.
 */
export class OpenString extends SourceError {}

/**
 * Split one line into tokens. Whitespace separates; double quotes group, with
 * `\"` and `\\` as the only escapes. A `//` outside quotes starts a comment and
 * runs to the end of the line, so a comment may trail a statement.
 *
 * A lone `/` is an ordinary character, which keeps a path or a ratio writable
 * unquoted. `#` is ordinary too: it opens a hex color, which is why comments
 * are spelled `//` rather than the `#` an earlier version used.
 *
 * Parentheses group the modifiers on a placement — `left of hub (gap: wide)` —
 * and are tokens in their own right so that `(gap:` does not read as one word
 * ending in a colon. They are deliberately *not* punctuation everywhere: an
 * opening bracket counts only where a token starts, and a closing one only
 * while a group is open, so an unquoted `rgb(20,20,20)` stays a single token.
 *
 * `depth` is how many brackets are still open from the lines before, when a
 * statement continues onto this one.
 *
 * `line` may hold line breaks, but only inside a `"""` string: `parse` joins
 * the lines such a string spans before handing them over.
 *
 * Returns an empty array for a blank or comment-only line.
 */
export function tokenizeLine(line: string, lineNumber: number, depth = 0): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < line.length) {
    const ch = line[i]!;

    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }

    if (ch === '/' && line[i + 1] === '/') break;

    if (ch === '(') {
      depth += 1;
      tokens.push({ text: '(', quoted: false });
      i += 1;
      continue;
    }

    if (ch === ')' && depth > 0) {
      depth -= 1;
      tokens.push({ text: ')', quoted: false });
      i += 1;
      continue;
    }

    // Between `"""` marks everything is taken as written, quotes and line breaks
    // included, with no escapes. That is what makes an SVG pasteable: it is full
    // of double quotes and never has three in a row.
    if (line.startsWith('"""', i)) {
      const end = line.indexOf('"""', i + 3);
      if (end === -1) throw new OpenString('this """ string is never closed — end it with """', lineNumber);
      tokens.push({ text: line.slice(i + 3, end), quoted: true, triple: true });
      i = end + 3;
      continue;
    }

    if (ch === '"') {
      let text = '';
      i += 1;
      let closed = false;
      while (i < line.length) {
        const c = line[i]!;
        if (c === '\\' && i + 1 < line.length) {
          const next = line[i + 1]!;
          // `\/` and `\[` are the two escapes that must survive tokenizing.
          // Neither of the things they escape is resolved here — the line break
          // waits for `splitRuns` and the markup tag for `parseMarkup` — so
          // collapsing either to a bare character now would lose the fact that
          // the author asked for a literal. Every other escape resolves here.
          text += next === '/' || next === '[' ? `\\${next}` : next;
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        text += c;
        i += 1;
      }
      if (!closed) throw new SourceError('unterminated string', lineNumber);
      tokens.push({ text, quoted: true });
      continue;
    }

    const start = i;
    let text = '';
    while (i < line.length) {
      const c = line[i]!;
      if (c === ' ' || c === '\t' || c === '"') break;
      if (c === '/' && line[i + 1] === '/') break;
      if (c === ')' && depth > 0) break;
      text += c;
      i += 1;
    }
    // `gap:tight` is `gap: tight` with no space, since how much whitespace there
    // is never matters. A word straight after a key is its value and is left
    // whole, so `icon: a:b` still names an icon called `a:b`. The rest of the
    // word is read again from just past the colon rather than kept as one
    // token, so `line:(color:red)` opens its bracket as `line: (color: red)` does.
    const previous = tokens[tokens.length - 1];
    const joined = previous && isAttrKey(previous) ? null : JOINED_KEY.exec(text);
    if (joined) {
      tokens.push({ text: joined[1]!, quoted: false, joined: text });
      i = start + joined[1]!.length;
      continue;
    }
    tokens.push({ text, quoted: false });
  }

  return tokens;
}

/**
 * The character in a word that a name may not hold, if any. A colon makes the
 * word a key, written with or without its space, and `;` is kept free so it
 * could one day separate clauses without changing what any file means.
 */
export function nameMark(token: Token): ':' | ';' | undefined {
  const written = token.joined ?? token.text;
  if (token.quoted) return undefined;
  if (written.includes(':')) return ':';
  if (written.includes(';')) return ';';
  return undefined;
}

/** A bare token ending in `:` opens the attribute section of a statement. */
export function isAttrKey(token: Token): boolean {
  return !token.quoted && token.text.length > 1 && token.text.endsWith(':');
}
