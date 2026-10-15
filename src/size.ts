/**
 * A stated size: `height: 0.5 group height`, `width: a + b + 2`,
 * `height: a top to c bottom`, `width: larger of a and b`, `height: 3 lines`.
 *
 * Read here once, by the parser, which checks it and stores it back as text
 * with every word spaced out; the placing pass reads that text again and works
 * the number out. A size ends at the first word that cannot continue it, so a
 * placement can follow it on the same line: `height: a right of b`.
 */
import type { Token } from './lexer.js';
import { isAttrKey } from './lexer.js';
import { SourceError } from './errors.js';

export type Dimension = 'width' | 'height';
export type SpanSide = 'top' | 'bottom' | 'left' | 'right' | 'center';

export type SizeExpr =
  | { kind: 'number'; value: number; unit: 'unit' | 'px' | 'lines' | 'chars' }
  /** Another box's measurement; no dimension means the one being stated. */
  | { kind: 'measure'; name: string; dimension?: Dimension }
  /** The box's own other measurement: `height: 0.75 width`. */
  | { kind: 'own'; dimension: Dimension }
  | { kind: 'span'; from: { name: string; side: SpanSide }; to: { name: string; side: SpanSide } }
  | { kind: 'scale'; by: number; of: SizeExpr }
  | { kind: 'sum'; terms: SizeExpr[] }
  | { kind: 'pick'; which: 'larger' | 'smaller'; first: SizeExpr; second: SizeExpr };

/** The keys that state a size, and the dimension each measures. */
export const SIZE_KEYS: Record<string, Dimension> = {
  width: 'width',
  height: 'height',
  'min-width': 'width',
  'max-width': 'width',
  'min-height': 'height',
  'max-height': 'height',
};

const SPAN_SIDES: readonly string[] = ['top', 'bottom', 'left', 'right', 'center'];
const RESERVED = new Set(['and', 'of', 'to', '+', '(', ')', 'larger', 'smaller']);
const NUMBER = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?(px)?$/;

interface Reading {
  tokens: Token[];
  at: number;
  key: string;
  subject: string;
  line: number;
  /** Whether a word starts something after the size, such as a placement. */
  stops: (token: Token) => boolean;
}

/**
 * Read a size starting at `at`. Returns it and the index of the first token
 * after it.
 */
export function readSize(
  tokens: Token[],
  at: number,
  key: string,
  subject: string,
  line: number,
  stops: (token: Token) => boolean,
): { size: SizeExpr; next: number } {
  // `a+b` is `a + b`: how much whitespace there is never matters.
  const spaced: Token[] = [];
  for (const [index, token] of tokens.entries()) {
    if (index < at || token.quoted || token.text === '+' || !token.text.includes('+')) {
      spaced.push(token);
      continue;
    }
    token.text.split(/(\+)/).filter((part) => part.length > 0).forEach((part) => spaced.push({ text: part, quoted: false }));
  }
  const reading: Reading = { tokens: spaced, at, key, subject, line, stops };
  if (!startsOperand(reading)) {
    throw new SourceError(
      `${subject}: ${key}: takes a size, such as ${key}: 4, ${key}: 120px or ${key}: group ${SIZE_KEYS[key]}`,
      line,
    );
  }
  const size = sum(reading);
  refuseBracket(reading);
  // Count back to the caller's tokens, which had `a+b` as one.
  let next = at;
  let consumed = 0;
  for (let index = at; index < tokens.length && consumed < reading.at - at; index += 1) {
    const token = tokens[index]!;
    consumed += token.quoted || token.text === '+' || !token.text.includes('+')
      ? 1
      : token.text.split(/(\+)/).filter((part) => part.length > 0).length;
    next = index + 1;
  }
  return { size, next };
}

/** A size as text, every word spaced, which `readSize` reads back the same. */
export function writeSize(size: SizeExpr): string {
  switch (size.kind) {
    case 'number':
      return size.unit === 'px' ? `${size.value}px` : size.unit === 'unit' ? `${size.value}` : `${size.value} ${size.unit}`;
    case 'measure':
      return size.dimension ? `${size.name} ${size.dimension}` : size.name;
    case 'own':
      return size.dimension;
    case 'span':
      return `${size.from.name} ${size.from.side} to ${size.to.name} ${size.to.side}`;
    case 'scale': {
      const inner = writeSize(size.of);
      return `${size.by} ${size.of.kind === 'sum' ? `( ${inner} )` : inner}`;
    }
    case 'sum':
      return size.terms.map(writeSize).join(' + ');
    case 'pick':
      return `${size.which} of ( ${writeSize(size.first)} ) and ( ${writeSize(size.second)} )`;
  }
}

/** Read a stored size back. */
export function storedSize(text: string, key: string, subject: string, line: number): SizeExpr {
  const tokens = text.split(' ').map((word) => ({ text: word, quoted: false }));
  return readSize(tokens, 0, key, subject, line, () => false).size;
}

function peek(reading: Reading, ahead = 0): Token | undefined {
  return reading.tokens[reading.at + ahead];
}

function isWord(reading: Reading, word: string, ahead = 0): boolean {
  const token = peek(reading, ahead);
  return token !== undefined && !token.quoted && token.text === word;
}

/** A word that could be a box's name here. */
function isName(reading: Reading, token: Token | undefined): boolean {
  if (!token || token.quoted || isAttrKey(token)) return false;
  if (RESERVED.has(token.text) || reading.stops(token)) return false;
  return /^[A-Za-z_][\w.-]*$/.test(token.text);
}

function startsOperand(reading: Reading): boolean {
  const token = peek(reading);
  if (!token || token.quoted || isAttrKey(token)) return false;
  return (
    NUMBER.test(token.text) ||
    token.text === '(' ||
    token.text === 'larger' ||
    token.text === 'smaller' ||
    token.text === 'width' ||
    token.text === 'height' ||
    isName(reading, token) ||
    token.text.startsWith('-')
  );
}

function sum(reading: Reading): SizeExpr {
  const terms = [scaled(reading)];
  while (isWord(reading, '+')) {
    reading.at += 1;
    if (!startsOperand(reading)) {
      throw new SourceError(`${reading.subject}: ${reading.key}: ends with a +, which has nothing to add`, reading.line);
    }
    terms.push(scaled(reading));
  }
  refuseStar(reading);
  return terms.length === 1 ? terms[0]! : { kind: 'sum', terms };
}

function refuseStar(reading: Reading): void {
  const token = peek(reading);
  if (token && !token.quoted && token.text.includes('*')) {
    throw new SourceError(
      `${reading.subject}: ${reading.key}: scales by writing the number in front — ${reading.key}: 0.5 group, not 0.5 * group`,
      reading.line,
    );
  }
}

/** `height: group (at most: 30)`: a bracket of settings, which a size never takes. */
function refuseBracket(reading: Reading): void {
  if (!isWord(reading, '(')) return;
  let settings = false;
  for (let ahead = 1; peek(reading, ahead) && !isWord(reading, ')', ahead); ahead += 1) {
    if (isAttrKey(peek(reading, ahead)!)) settings = true;
  }
  if (!settings) return;
  const dimension = SIZE_KEYS[reading.key]!;
  throw new SourceError(
    `${reading.subject}: ${reading.key}: takes no bracket — a limit is its own key, min-${dimension}: or max-${dimension}:, ` +
      'since a bracket reads as belonging to whatever it sits beside',
    reading.line,
  );
}

function scaled(reading: Reading): SizeExpr {
  const token = peek(reading)!;
  if (token.text.startsWith('-')) {
    throw new SourceError(`${reading.subject}: ${reading.key}: a size is never negative, so ${token.text} is not one`, reading.line);
  }
  const number = NUMBER.exec(token.text);
  if (!number) return atom(reading);
  reading.at += 1;
  const value = number[2] === undefined ? Number(number[1]) : Number(number[1]) / Number(number[2]);
  if (number[3]) return { kind: 'number', value, unit: 'px' };
  if (isWord(reading, 'lines') || isWord(reading, 'chars')) {
    const unit = peek(reading)!.text as 'lines' | 'chars';
    reading.at += 1;
    return { kind: 'number', value, unit };
  }
  refuseStar(reading);
  const next = peek(reading);
  const scales =
    next !== undefined &&
    !next.quoted &&
    (next.text === '(' || next.text === 'larger' || next.text === 'smaller' || next.text === 'width' ||
      next.text === 'height' || isName(reading, next));
  if (!scales) return { kind: 'number', value, unit: 'unit' };
  return { kind: 'scale', by: value, of: atom(reading) };
}

function atom(reading: Reading): SizeExpr {
  const token = peek(reading)!;
  const { subject, key, line } = reading;
  if (token.text === '(') {
    refuseBracket(reading);
    reading.at += 1;
    const inner = sum(reading);
    if (!isWord(reading, ')')) throw new SourceError(`${subject}: ${key}: opens a bracket it never closes`, line);
    reading.at += 1;
    return inner;
  }
  if (token.text === 'larger' || token.text === 'smaller') {
    const which = token.text;
    if (!isWord(reading, 'of', 1)) {
      throw new SourceError(`${subject}: ${key}: ${which} chooses between two — ${which} of a and b`, line);
    }
    reading.at += 2;
    const first = sum(reading);
    if (!isWord(reading, 'and')) {
      throw new SourceError(`${subject}: ${key}: ${which} of names two sizes, joined by and — ${which} of a and b`, line);
    }
    reading.at += 1;
    if (!startsOperand(reading)) {
      throw new SourceError(`${subject}: ${key}: ${which} of a and … names nothing after and`, line);
    }
    const second = sum(reading);
    return { kind: 'pick', which, first, second };
  }
  if (token.text === 'width' || token.text === 'height') {
    reading.at += 1;
    return { kind: 'own', dimension: token.text };
  }
  if (!isName(reading, token)) {
    throw new SourceError(`${subject}: ${key}: "${token.text}" is not a size or the name of a box`, line);
  }
  reading.at += 1;
  const name = token.text;
  const after = peek(reading);
  if (after && !after.quoted && SPAN_SIDES.includes(after.text) && isWord(reading, 'to', 1)) {
    reading.at += 2;
    const far = peek(reading);
    const side = peek(reading, 1);
    // `a top to c right of b`: the far side is missing, and a placement follows.
    const placed = isWord(reading, 'of', 2);
    if (!isName(reading, far) || !side || side.quoted || !SPAN_SIDES.includes(side.text) || placed) {
      throw new SourceError(
        `${subject}: ${key}: a span names a side at each end — ${name} ${after.text} to c ${after.text === 'top' ? 'bottom' : after.text}`,
        line,
      );
    }
    reading.at += 2;
    return {
      kind: 'span',
      from: { name, side: after.text as SpanSide },
      to: { name: far!.text, side: side.text as SpanSide },
    };
  }
  if (isWord(reading, 'width') || isWord(reading, 'height')) {
    const dimension = peek(reading)!.text as Dimension;
    reading.at += 1;
    return { kind: 'measure', name, dimension };
  }
  return { kind: 'measure', name };
}
