import {
  ARROW_LENGTH,
  ARROW_MARKER_WIDTH,
  ATTACH_MARGIN,
  ATTACH_STEP,
  DECK_STEP,
  DEFAULT_FONT_SIZE,
  ICON_LINES,
  LINE_WIDTH,
  PAD,
  SEPARATION_GAP,
  arrowLength,
  fontSizeFor,
  textExtent,
  textStyleFor,
  widestLine,
} from './constants.js';
import type { Attrs, Axis } from './ast.js';
import { describeAxis } from './ast.js';
import { SourceError } from './errors.js';
import { ICON_STROKE, type Icon, type IconTone, type Outline } from './icons.js';
import { monospaceMeasurer, type Measurer } from './measure.js';
import type { Layout, LayoutEdge, LayoutNode, LayoutPass, LineLook } from './model.js';
import { DARK_THEME, THEMES, type Theme } from './themes.js';
import { plain, type Line, type Run } from './text.js';

export interface RenderOptions {
  measurer?: Measurer;
  fontSize?: number;
  theme?: Theme;
}


const CORNER = 8;

/** A rectangle of the drawing, in the same absolute coordinates as the nodes. */
interface Extent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Turn solved geometry into a standalone SVG document. */
export function render(layout: Layout, options: RenderOptions = {}): string {
  const measurer = options.measurer ?? monospaceMeasurer();
  const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
  // A theme passed in — the command line's `--theme` — beats the one the file
  // names, so one source renders in either. `diagram background:` and `text:`
  // are the author overruling a color of whichever theme that is, and a color
  // written by hand wins over any theme, so they are folded in afterwards and
  // everything downstream sees one theme.
  const named = layout.diagram['theme'];
  const base = options.theme ?? (named === undefined ? undefined : THEMES[named]) ?? DARK_THEME;
  const theme: Theme = {
    ...base,
    ...(layout.diagram['background'] !== undefined && { background: layout.diagram['background'] }),
    ...(layout.diagram['text.color'] !== undefined && { text: layout.diagram['text.color'] }),
  };

  const body: string[] = [];
  for (const root of layout.roots) {
    body.push(drawNode(root, theme, measurer, fontSize, layout.markup));
  }
  // Everything the boxes cover. Edges are added to it as they are drawn.
  let ink: Extent = { minX: 0, minY: 0, maxX: layout.width, maxY: layout.height };
  // Endpoints are planned for every edge at once, because where an edge meets a
  // side depends on what else meets that same side. Corridors come after, for
  // the same reason in the other direction: which lane of a gap an edge takes
  // is ordered by where its ends turned out to be.
  const ends = planEndpoints(layout.edges, measurer, fontSize);
  const corridors = planCorridors(layout.edges, ends, measurer, fontSize);
  const routes = planRoutes(layout.edges, layout.nodes, ends, measurer, fontSize);
  planLoops(layout.edges, layout.nodes, ends, corridors, routes, measurer, fontSize);
  aimFreeEnds(layout.edges, ends, corridors);
  const drawn = layout.edges.map((edge) =>
    drawEdge(
      edge,
      ends.get(edge)!,
      corridors.get(edge),
      routes.get(edge),
      layout.nodes,
      theme,
      measurer,
      fontSize,
      layout.markup,
    ),
  );
  // A line with a `crossing:` style is cut where it crosses an earlier one, and
  // the jump drawn over the cut. The cut is a mask rather than a break in the
  // path, so it works the same on a curve as on a corner, and leaves whatever
  // lies underneath — a container's fill — showing through the gap.
  const crossings = findCrossings(drawn);
  const masks: { id: string; holes: Crossing[] }[] = [];
  for (const edge of drawn) {
    const found = crossings.get(edge);
    const parts = [edge.line, ...edge.rest];
    if (found) {
      const id = `cut-${masks.length + 1}`;
      masks.push({ id, holes: found });
      parts[0] = edge.line.replace(/\/>$/, ` mask="url(#${id})"/>`);
      const jumps = found
        .map((crossing) => jumpAt(crossing, edge.edge.look.crossing))
        .filter((d): d is string => d !== undefined)
        .map((d) => `  <path d="${d}" fill="none"${edge.stroke}/>`);
      parts.splice(1, 0, ...jumps);
      for (const crossing of found) {
        edge.ink = union(edge.ink, grow(extentOfPoints([crossing.at]), crossing.reach + edge.edge.look.thickness));
      }
    }
    body.push(linked(parts.join('\n'), edge.edge.attrs['url']));
    ink = union(ink, grow(edge.ink, layout.margin));
  }

  // An edge's geometry is measured rather than solved for, so the resolver sized
  // the canvas from the boxes alone. A curve out of a `top` side, or a text
  // riding above one, lands outside that — so the page grows to hold it and the
  // origin moves with it, rather than the drawing being quietly clipped.
  const canvas = {
    x: Math.floor(ink.minX),
    y: Math.floor(ink.minY),
    width: Math.ceil(ink.maxX) - Math.floor(ink.minX),
    height: Math.ceil(ink.maxY) - Math.floor(ink.minY),
  };

  const arrowColors = new Set(layout.edges.map((edge) => lineOf(edge.appearance, theme.edge)));

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="${canvas.x} ${canvas.y} ${canvas.width} ${canvas.height}" font-family=${quote(measurer.fontFamily)} font-size="${fontSize}px">`,
    '  <defs>',
    ...[...arrowColors].map((color) => arrowMarker(color)),
    // Each mask covers the whole page, in page units: the default region is the
    // line's own bounding box, which a straight level line gives no height, and
    // the line would vanish entirely.
    ...masks.map(({ id, holes }) =>
      [
        `    <mask id="${id}" maskUnits="userSpaceOnUse" x="${canvas.x}" y="${canvas.y}" width="${canvas.width}" height="${canvas.height}">`,
        `      <rect x="${canvas.x}" y="${canvas.y}" width="${canvas.width}" height="${canvas.height}" fill="white"/>`,
        ...holes.map(
          (hole) => `      <circle cx="${round(hole.at.x)}" cy="${round(hole.at.y)}" r="${round(hole.reach)}" fill="black"/>`,
        ),
        '    </mask>',
      ].join('\n'),
    ),
    '  </defs>',
    `  <rect x="${canvas.x}" y="${canvas.y}" width="${canvas.width}" height="${canvas.height}" fill="${theme.background}"/>`,
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

// --- nodes -------------------------------------------------------------------

/**
 * `<a href>` around whatever a node or an edge draws, when it named a
 * destination.
 *
 * SVG has this natively, so a standalone SVG stays standalone and a rasteriser
 * drops it, leaving a PNG unharmed. Plain `href` and not `xlink:href`: the
 * SVG 1.1 spelling would need an `xmlns:xlink` on every drawing whether or not
 * anything in it links anywhere, and every current browser takes the SVG 2 one.
 *
 * `target="_blank"` always, because the playground inlines the SVG into its own
 * page and a click inside it would otherwise navigate the playground away;
 * `rel="noopener"` goes with it as it does anywhere else.
 *
 * **An `<a>` is never nested inside another.** Nesting is the obvious way to let
 * a container carry a destination while a child carries its own, and it does not
 * work: Chrome draws nothing at all inside the inner one, so the child simply
 * disappears from the picture. Every node's anchor therefore wraps only what
 * that node draws — outline and text — and its children are emitted beside
 * it, each wrapping itself. The reading comes out the same anyway, because the
 * container's filled outline lies under the children and catches every click
 * that does not land on one of them.
 *
 * A destination therefore reaches down the tree instead of enclosing it: a child
 * that names none of its own is drawn inside an anchor carrying its container's,
 * and one that names its own overrules it. That is the reading nesting would
 * have given — the container catches every click its children do not — reached
 * by repeating the destination rather than by wrapping.
 */
function linked(svg: string, url: string | undefined): string {
  if (url === undefined || svg.length === 0) return svg;
  // An `&` between query parameters is ordinary in a url and illegal raw in an
  // attribute, so the value is escaped as markup rather than merely quoted.
  return `  <a href=${quote(escapeXml(url))} target="_blank" rel="noopener">\n${svg}\n  </a>`;
}

function drawNode(
  node: LayoutNode,
  theme: Theme,
  measurer: Measurer,
  fontSize: number,
  markup: Record<string, string>,
  inherited?: string,
): string {
  const url = node.attrs['url'] ?? inherited;
  const { own, kids } = nodeSvg(node, theme, measurer, fontSize, markup, url);
  return [linked(own.join('\n'), url), ...kids]
    .filter((part) => part.length > 0)
    .join('\n');
}

/**
 * What a node draws, in two pieces: its own ink and its children's. They are
 * kept apart so the node's `<a>` can wrap what is the node's without
 * swallowing what is a child's.
 */
function nodeSvg(
  node: LayoutNode,
  theme: Theme,
  measurer: Measurer,
  fontSize: number,
  markup: Record<string, string>,
  url: string | undefined,
): { own: string[]; kids: string[] } {
  // A note is set smaller than a box text by default, and `size:` overrides
  // that on anything. Only this node's own text takes the size — children are
  // drawn by their own call and carry whatever they say themselves.
  const size = fontSizeFor(node.kind, node.textAttrs, fontSize, node.line);
  const textHeight = measurer.lineHeight(size);
  const blockWidth = widestLine(node.lines, measurer, size);
  const ink = (run: Run, own: string) => runInk(run, own, markup, theme);

  if (node.body.kind === 'none') {
    const style = textStyleFor(node.textAttrs, node.line, 'start', 'center');
    return { kids: [], own: [sized(
      textBlock(node.lines, node.x, node.y, textHeight, size, node.textBox, {
        color: textColorOf(node.textAttrs, theme, theme.text),
        align: style.align,
        ink,
      }),
      size,
      fontSize,
    )] };
  }

  const glyphSide = ICON_LINES * textHeight;

  if (node.body.kind === 'icon') {
    // No outline, no fill, no padding — the node is the picture. The text, if
    // there is one, sits under it. `at`'s vertical half has nothing to say
    // here — the caption is under the picture and nowhere else — so only its
    // horizontal half is read.
    const style = textStyleFor(node.textAttrs, node.line, 'middle', 'center');
    const drawn = [drawIcon(node.body.icon, node.x + (node.width - glyphSide) / 2, node.y, glyphSide, theme)];
    if (node.lines.some((line) => plain(line).length > 0)) {
      drawn.push(
        sized(
          textBlock(node.lines, node.x, node.y, textHeight, size, node.textBox, {
            color: textColorOf(node.textAttrs, theme, theme.text),
            align: style.align,
            ink,
          }),
          size,
          fontSize,
        ),
      );
    }
    return { own: drawn, kids: [] };
  }

  const outline = node.body.outline;
  const parts: string[] = [];
  const kids: string[] = [];
  const face = faceOf(node);
  // A node with children is colored as a backdrop however they are placed,
  // including a lone badge beside its text. Every rule that tried to tell a
  // badge from contents was a guess; this one is visible in the source.
  const container = node.children.length > 0;
  const border = borderOf(node.appearance, container ? theme.containerStroke : theme.boxStroke);
  const fill = fillOf(node.appearance, container ? theme.containerFill : theme.boxFill);
  // A box is the one kind with two inkable parts, which is why its text needs
  // a word of its own — `border:` cannot stand in for it.
  const text = textColorOf(node.textAttrs, theme, theme.text);

  // Deck copies sit behind the front face, furthest back drawn first.
  for (let depth = node.deckTexts.length; depth >= 1; depth -= 1) {
    const x = face.x - depth * DECK_STEP;
    const y = face.y - depth * DECK_STEP;
    parts.push(
      `  <path d="${outlinePath(outline, x, y, face.width, face.height)}" fill="${theme.containerFill}" stroke="${border}"/>`,
    );
    const copy = node.deckTexts[depth - 1];
    if (copy !== undefined) {
      parts.push(
        sized(
          textBlock([[{ text: copy }]], x, y, textHeight, size,
            { x: PAD, y: PAD, width: face.width - PAD * 2, height: textHeight },
            { color: text, align: 'start', ink },
          ),
          size,
          fontSize,
        ),
      );
    }
  }

  parts.push(
    `  <path d="${outlinePath(outline, face.x, face.y, face.width, face.height)}" fill="${fill}" stroke="${border}"/>`,
  );
  for (const extra of outlineDetail(outline, face.x, face.y, face.width, face.height)) {
    parts.push(`  <path d="${extra}" fill="none" stroke="${border}"/>`);
  }

  // A leaf's text defaults to the middle of its box, a container's to the top
  // left of the band; both then read `at` for where it really goes. Where the
  // text sits is the resolver's answer, in `textBox`; only the alignment of
  // its lines against each other is read here. This follows the band, not the
  // colors: a badged leaf is a backdrop but its text still centers.
  const textStyle = textStyleFor(
    node.textAttrs,
    node.line,
    node.banded ? 'start' : 'middle',
    node.banded ? 'top-left' : 'center',
  );
  parts.push(
    sized(
      textBlock(node.lines, node.x, node.y, textHeight, size, node.textBox, {
        color: text,
        align: textStyle.align,
        ink,
      }),
      size,
      fontSize,
    ),
  );
  for (const child of node.children) {
    kids.push(drawNode(child, theme, measurer, fontSize, markup, url));
  }

  return { own: parts, kids };
}

/**
 * How far the dog-ear cuts into the top-right corner of a `document`.
 *
 * Twice the corner radius, so it is the same size on every box however wide.
 * The reference sizes its fold as a fraction of the box, which is why the fold
 * on those two wide dump boxes almost disappears — the idea was right and
 * only the scaling was wrong.
 */
const FOLD = CORNER * 2;

/** The node's outline, as path data. */
function outlinePath(shape: Outline, x: number, y: number, w: number, h: number): string {
  const r = CORNER;
  if (shape === 'circle') {
    // Two half-turns from the leftmost point, since one arc cannot close.
    const radius = w / 2;
    return [
      `M${round(x)} ${round(y + h / 2)}`,
      `a${round(radius)} ${round(radius)} 0 1 0 ${round(w)} 0`,
      `a${round(radius)} ${round(radius)} 0 1 0 ${round(-w)} 0`,
      'Z',
    ].join(' ');
  }
  if (shape === 'document') {
    // Every corner rounded but the top-right one, which is cut away and folded.
    return [
      `M${round(x + r)} ${round(y)}`,
      `H${round(x + w - FOLD)}`,
      `L${round(x + w)} ${round(y + FOLD)}`,
      `V${round(y + h - r)}`,
      `a${r} ${r} 0 0 1 ${-r} ${r}`,
      `H${round(x + r)}`,
      `a${r} ${r} 0 0 1 ${-r} ${-r}`,
      `V${round(y + r)}`,
      `a${r} ${r} 0 0 1 ${r} ${-r}`,
      'Z',
    ].join(' ');
  }
  return [
    `M${round(x + r)} ${round(y)}`,
    `H${round(x + w - r)}`,
    `a${r} ${r} 0 0 1 ${r} ${r}`,
    `V${round(y + h - r)}`,
    `a${r} ${r} 0 0 1 ${-r} ${r}`,
    `H${round(x + r)}`,
    `a${r} ${r} 0 0 1 ${-r} ${-r}`,
    `V${round(y + r)}`,
    `a${r} ${r} 0 0 1 ${r} ${-r}`,
    'Z',
  ].join(' ');
}

/** Lines drawn inside the outline: the flap of a fold, and nothing else so far. */
function outlineDetail(shape: Outline, x: number, y: number, w: number, h: number): string[] {
  void h;
  if (shape !== 'document') return [];
  return [
    `M${round(x + w - FOLD)} ${round(y)} V${round(y + FOLD)} H${round(x + w)}`,
  ];
}

/** One icon, scaled from its own grid onto a square of `side` at `x, y`. */
function drawIcon(icon: Icon, x: number, y: number, side: number, theme: Theme): string {
  const scale = side / icon.grid;
  const color = (tone: IconTone | undefined): string =>
    tone === 'ink' ? theme.iconInk : tone === 'shade' ? theme.iconShade : theme.background;

  const paths = icon.paths.map((path) => {
    const fill = path.fill === undefined ? 'none' : color(path.fill);
    const stroke =
      path.stroke === undefined
        ? ''
        : ` stroke="${color(path.stroke)}" stroke-width="${ICON_STROKE}" stroke-linejoin="round"`;
    return `    <path d="${path.d}" fill="${fill}"${stroke}/>`;
  });

  return [
    `  <g transform="translate(${round(x)} ${round(y)}) scale(${round(scale * 1000) / 1000})">`,
    ...paths,
    '  </g>',
  ].join('\n');
}

// --- edges -------------------------------------------------------------------

/**
 * One edge, drawn. The line is kept apart from the rest so that the crossings,
 * which need every line to exist first, can cut into it afterwards.
 */
interface DrawnEdge {
  edge: LayoutEdge;
  /** The line's element, closed with `/>` so a mask can be added to it. */
  line: string;
  /** Its text, after it. */
  rest: string[];
  ink: Extent;
  /** The line as a polyline, curves flattened, for finding where lines cross. */
  trace: Point[];
  color: string;
  stroke: string;
}

function drawEdge(
  edge: LayoutEdge,
  ends: EdgeEnds,
  corridor: Corridor | undefined,
  route: Route | undefined,
  nodes: LayoutNode[],
  theme: Theme,
  measurer: Measurer,
  fontSize: number,
  markup: Record<string, string>,
): DrawnEdge {
  const { start, end } = ends;
  const color = lineOf(edge.appearance, theme.edge);
  const stroke = strokeOf(color, edge.look);

  const markerEnd = ` marker-end="url(#${markerId(color)})"`;
  const markerStart = edge.both ? ` marker-start="url(#${markerId(color)}-back)"` : '';

  // A named side is a statement about how the line should leave or arrive, so
  // it is drawn as a curve that actually does leave and arrive that way. With
  // neither side named there is nothing to honor and the line stays straight.
  const curved = start.side !== undefined || end.side !== undefined;
  const bowed = ends.bow !== undefined && (ends.bow.x !== 0 || ends.bow.y !== 0);
  const parts: string[] = [];
  // What the line actually covers, so the canvas can be sized to hold it. A
  // curve leaving a `top` side rides above every box in the drawing, and the
  // node bounds know nothing about it.
  let ink = extentOfPoints([start, end]);
  let midX: number;
  let midY: number;

  const jointed = edge.look.path !== 'curved' && (route || corridor || curved || bowed);
  if (jointed) {
    // `path: square` and `path: straight` are the same fixed points — the ends,
    // which way each faces, the run a clause asked for — joined by a different
    // rule, and both come out as straight pieces meeting at corners.
    const textWidth =
      edge.lines === undefined
        ? 0
        : widestLine(edge.lines, measurer, fontSizeFor('edge', edge.textAttrs, fontSize, edge.line));
    const plan = jointedLine(edge, ends, corridor, route, nodes, textWidth);
    const d =
      edge.look.corners === 'rounded'
        ? roundedPath(plan.points, arrowLength(edge.look.thickness))
        : sharpPath(plan.points);
    parts.push(`  <path d="${d}" fill="none"${stroke}${markerEnd}${markerStart}/>`);
    ink = union(ink, extentOfPoints(plan.points));
    midX = plan.mid.x;
    midY = plan.mid.y;
  } else if (route) {
    parts.push(
      `  <path d="${roundedPath(route.points)}" fill="none"${stroke}${markerEnd}${markerStart}/>`,
    );
    ink = union(ink, extentOfPoints(route.points));
    midX = route.mid.x;
    midY = route.mid.y;
  } else if (corridor) {
    const path = corridorPath(start, end, corridor);
    ink = union(ink, path.ink);
    parts.push(
      `  <path d="${path.d}" fill="none"${stroke}${markerEnd}${markerStart}/>`,
    );
    // The text goes on the straight run rather than at the midpoint of the
    // whole path, so it sits in the gap the author asked the line to travel.
    midX = path.mid.x;
    midY = path.mid.y;
  } else if (curved) {
    const reach = controlReach(start, end);
    // A bundle whose sides were too short to spread it takes the rest of the
    // room in the middle, exactly as a straight group does — see `bowBundles`.
    // Displacing both control points equally moves the curve's middle by three
    // quarters as much, so the bow is scaled up by the inverse of that.
    const lift = 4 / 3;
    const bx = (ends.bow?.x ?? 0) * lift;
    const by = (ends.bow?.y ?? 0) * lift;
    const c1 = { x: start.x + start.tx * reach + bx, y: start.y + start.ty * reach + by };
    const c2 = { x: end.x + end.tx * reach + bx, y: end.y + end.ty * reach + by };
    parts.push(
      `  <path d="M ${round(start.x)} ${round(start.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(end.x)} ${round(end.y)}" fill="none"${stroke}${markerEnd}${markerStart}/>`,
    );
    ink = union(ink, cubicExtent(start, c1, c2, end));
    // The point halfway along a cubic, which is where the text belongs.
    midX = (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8;
    midY = (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8;
  } else if (ends.bow && bowed) {
    // A straight line that could not get the room it needed at its ends, so it
    // takes it in the middle. Both control points carry the same displacement,
    // which keeps the arc symmetric; a cubic's middle moves three quarters of
    // the way its controls do, so the displacement is the bow scaled up by that.
    const lift = 4 / 3;
    const run = { x: (end.x - start.x) / 3, y: (end.y - start.y) / 3 };
    const c1 = {
      x: start.x + run.x + ends.bow.x * lift,
      y: start.y + run.y + ends.bow.y * lift,
    };
    const c2 = {
      x: end.x - run.x + ends.bow.x * lift,
      y: end.y - run.y + ends.bow.y * lift,
    };
    parts.push(
      `  <path d="M ${round(start.x)} ${round(start.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(end.x)} ${round(end.y)}" fill="none"${stroke}${markerEnd}${markerStart}/>`,
    );
    ink = union(ink, cubicExtent(start, c1, c2, end));
    midX = (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8;
    midY = (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8;
  } else {
    parts.push(
      `  <line x1="${round(start.x)}" y1="${round(start.y)}" x2="${round(end.x)}" y2="${round(end.y)}"${stroke}${markerEnd}${markerStart}/>`,
    );
    midX = (start.x + end.x) / 2;
    midY = (start.y + end.y) / 2;
  }

  if (edge.text !== undefined) {
    // An edge text breaks on ` / ` exactly as a box text does, so a two-line
    // caption on an arrow needs no vocabulary of its own. The block is centered
    // on the midpoint, which keeps a one-line text where it has always been.
    const size = fontSizeFor('edge', edge.textAttrs, fontSize, edge.line);
    const textHeight = measurer.lineHeight(size);
    const lines = edge.lines!;
    const width = widestLine(lines, measurer, size);
    const height = lines.length * textHeight;
    const top = midY - height / 2;
    // The text knocks a hole in whatever it lands on rather than sitting in a
    // chip of its own: an outlined box reads as a node, which is the one thing
    // a text on a line is not.
    parts.push(
      `  <rect x="${round(midX - width / 2 - 5)}" y="${round(top)}" width="${round(width + 10)}" height="${round(height)}" fill="${theme.background}"/>`,
    );
    ink = union(ink, {
      minX: midX - width / 2 - 5,
      minY: top,
      maxX: midX + width / 2 + 5,
      maxY: top + height,
    });
    parts.push(
      sized(
        textBlock(lines, midX - width / 2, top, textHeight, size,
          { x: 0, y: 0, width, height },
          {
            // A colored edge carries its meaning into its text; an uncolored
            // one leaves the words to read as ordinary text.
            color: textColorOf(edge.textAttrs, theme, lineOf(edge.appearance, theme.text)),
            align: 'middle',
            ink: (run, own) => runInk(run, own, markup, theme),
          },
        ),
        size,
        fontSize,
      ),
    );
  }

  // The stroke straddles the path, so half of it lies outside the geometry.
  const [line, ...rest] = parts;
  return {
    edge,
    line: line!,
    rest,
    ink: grow(ink, edge.look.thickness / 2),
    trace: traceOf(line!),
    color,
    stroke,
  };
}

/**
 * The stroke of a line: its color, its thickness and its pattern. The dashes
 * are measured in thicknesses, so a pattern keeps its proportions on a thick
 * line, which covers most of what a density setting would be for. A solid line
 * of the ordinary thickness writes exactly what every line always did.
 */
function strokeOf(color: string, look: LineLook): string {
  const w = look.thickness;
  const dashes: Record<LineLook['pattern'], string> = {
    solid: '',
    dashed: ` stroke-dasharray="${round(w * 4)} ${round(w * 3)}"`,
    // A zero-length dash with a round cap is a dot as wide as the line.
    dotted: ` stroke-dasharray="0 ${round(w * 3)}" stroke-linecap="round"`,
    'dash-dot': ` stroke-dasharray="${round(w * 5)} ${round(w * 3)} 0 ${round(w * 3)}" stroke-linecap="round"`,
  };
  return ` stroke="${color}" stroke-width="${w}"${dashes[look.pattern]}`;
}

/**
 * The points of a square or straight line, and where its text sits.
 *
 * Both start from what the file fixed. A square line leaves each side head-on
 * and turns only at right angles; a straight one goes directly from point to
 * point, and bends only where a clause — `below c`, `between a and b` — puts a
 * point it has to pass through.
 */
function jointedLine(
  edge: LayoutEdge,
  ends: EdgeEnds,
  corridor: Corridor | undefined,
  route: Route | undefined,
  nodes: LayoutNode[],
  textWidth: number,
): { points: Point[]; mid: Point } {
  const { start, end } = ends;
  const square = edge.look.path === 'square';
  const stub = ROUTE_RADIUS + arrowLength(edge.look.thickness);
  const fromFace = faceOf(edge.from);
  const toFace = faceOf(edge.to);

  if (route) {
    if (square) return { points: route.points, mid: route.mid };
    if (textWidth === 0) {
      const points = straighten(route.points, edge, nodes);
      return { points, mid: textSpot(points, textWidth) };
    }
    // The route pushed its run out far enough to hold the text clear of the
    // boxes it passes, and that room is only on the run. So a straight line
    // with a text keeps the text's point and straightens either side of it;
    // cutting across the run would put the text back against the box.
    const [before, after] = splitAt(route.points, route.mid);
    const points = tidyRoute([
      ...straighten(before, edge, nodes),
      ...straighten(after, edge, nodes).slice(1),
    ]);
    return { points, mid: route.mid };
  }

  if (corridor) {
    const p1 = corridorPoint(corridor, corridor.enter);
    const p2 = corridorPoint(corridor, corridor.leave);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    if (!square) return { points: tidyRoute([start, p1, p2, end]), mid };
    const forward = corridor.leave >= corridor.enter ? 1 : -1;
    const run = corridor.axis === 'y' ? { x: forward, y: 0 } : { x: 0, y: forward };
    const points = tidyRoute([
      ...rightAngles(start, headingOf(start, fromFace), p1, { x: -run.x, y: -run.y }, stub),
      ...rightAngles(p2, run, end, headingOf(end, toFace), stub),
    ]);
    return { points, mid };
  }

  const bow = ends.bow ?? { x: 0, y: 0 };
  const bowed = bow.x !== 0 || bow.y !== 0;
  if (!square) {
    // A bowed line is one of a crowded group, and its middle is the only room
    // left for its text, so it bends there.
    const middle = { x: (start.x + end.x) / 2 + bow.x, y: (start.y + end.y) / 2 + bow.y };
    const points = bowed ? [start, middle, end] : [start, end];
    return { points, mid: bowed ? middle : textSpot(points, textWidth) };
  }

  const out = headingOf(start, fromFace);
  const back = headingOf(end, toFace);
  // A bow is room for the texts of a crowded group, taken in the middle. Between
  // sides that face each other that middle is a run the lanes can widen along;
  // at right angles there is none, and the text finds room on a level piece.
  if (!bowed || (out.x !== 0) !== (back.x !== 0)) {
    const points = tidyRoute(rightAngles(start, out, end, back, stub));
    return { points, mid: textSpot(points, textWidth) };
  }
  // Out of each side, across by the bow, and joined at right angles.
  const a = { x: start.x + out.x * stub, y: start.y + out.y * stub };
  const b = { x: end.x + back.x * stub, y: end.y + back.y * stub };
  const points = tidyRoute(squareUp([start, a, { x: a.x + bow.x, y: a.y + bow.y }, { x: b.x + bow.x, y: b.y + bow.y }, b, end]));
  return { points, mid: textSpot(points, textWidth) };
}

/**
 * Which way an end points, as one of the four directions. A named side says so;
 * an end the renderer placed is on some side of its box, and that is the one.
 */
function headingOf(anchor: Anchor, face: Box): Point {
  if (anchor.side !== undefined) return { x: anchor.tx, y: anchor.ty };
  const candidates: [number, Point][] = [
    [Math.abs(anchor.x - face.x), { x: -1, y: 0 }],
    [Math.abs(anchor.x - (face.x + face.width)), { x: 1, y: 0 }],
    [Math.abs(anchor.y - face.y), { x: 0, y: -1 }],
    [Math.abs(anchor.y - (face.y + face.height)), { x: 0, y: 1 }],
  ];
  candidates.sort((p, q) => p[0] - q[0]);
  return candidates[0]![1];
}

/**
 * A right-angled line from `from`, leaving along `out`, to `to`, arriving
 * against `back` — `back` points out of the far side, so the line's last piece
 * travels the opposite way. The fewest turns that leave and arrive head-on:
 * none when the two face each other in line, one when they are at right angles
 * and the corner lies ahead of both, two in the middle when they face each
 * other offset, and a way round past a stub at each end otherwise.
 */
function rightAngles(from: Point, out: Point, to: Point, back: Point, stub: number): Point[] {
  const across = out.x !== 0;
  const parallel = across === (back.x !== 0);
  const ahead = (p: Point, q: Point, d: Point): number => (q.x - p.x) * d.x + (q.y - p.y) * d.y;

  if (parallel) {
    const facing = out.x * back.x + out.y * back.y < 0;
    if (facing && ahead(from, to, out) > 0) {
      if (Math.abs(across ? to.y - from.y : to.x - from.x) < 0.5) return [from, to];
      const m = across ? (from.x + to.x) / 2 : (from.y + to.y) / 2;
      return across
        ? [from, { x: m, y: from.y }, { x: m, y: to.y }, to]
        : [from, { x: from.x, y: m }, { x: to.x, y: m }, to];
    }
    if (!facing) {
      // Both sides face the same way: out past whichever is further, and back.
      const far = across
        ? (out.x > 0 ? Math.max(from.x, to.x) : Math.min(from.x, to.x)) + out.x * stub
        : (out.y > 0 ? Math.max(from.y, to.y) : Math.min(from.y, to.y)) + out.y * stub;
      return across
        ? [from, { x: far, y: from.y }, { x: far, y: to.y }, to]
        : [from, { x: from.x, y: far }, { x: to.x, y: far }, to];
    }
    // Facing, but the far end is behind: out, across the middle, and in.
    const a = { x: from.x + out.x * stub, y: from.y + out.y * stub };
    const b = { x: to.x + back.x * stub, y: to.y + back.y * stub };
    const m = across ? (from.y + to.y) / 2 : (from.x + to.x) / 2;
    return across
      ? [from, a, { x: a.x, y: m }, { x: b.x, y: m }, b, to]
      : [from, a, { x: m, y: a.y }, { x: m, y: b.y }, b, to];
  }

  const corner = across ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
  if (ahead(from, corner, out) > 0 && ahead(to, corner, back) > 0) return [from, corner, to];
  // The one corner lies behind an end: step out of both sides first and join
  // the two stubs with whichever corner does not double back.
  const a = { x: from.x + out.x * stub, y: from.y + out.y * stub };
  const b = { x: to.x + back.x * stub, y: to.y + back.y * stub };
  const options = [
    { x: b.x, y: a.y },
    { x: a.x, y: b.y },
  ];
  const turn =
    options.find((c) => ahead(a, c, out) >= 0 && ahead(b, c, back) >= 0) ?? options[across ? 1 : 0]!;
  return [from, a, turn, b, to];
}

/** Put a right-angled corner between any two points that are not in line. */
function squareUp(points: Point[]): Point[] {
  const out: Point[] = [points[0]!];
  let alongX = true;
  for (let index = 1; index < points.length; index += 1) {
    const a = out[out.length - 1]!;
    const b = points[index]!;
    const dx = Math.abs(b.x - a.x) >= 0.5;
    const dy = Math.abs(b.y - a.y) >= 0.5;
    if (dx && dy) {
      out.push(alongX ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
    } else if (dx || dy) {
      alongX = dx;
    }
    out.push(b);
  }
  return out;
}

/**
 * A route's points with every corner dropped that a straight piece can skip.
 * The route already keeps each clause; a straight piece may cut a corner only
 * where it stays clear of every box the route kept clear of, which keeps the
 * clauses too — a piece between two points below a node, touching nothing, is
 * below it all the way.
 */
function straighten(points: Point[], edge: LayoutEdge, nodes: LayoutNode[]): Point[] {
  const own = [faceOf(edge.from), faceOf(edge.to)].map((box) => grow(extentOfBox(box), -1));
  const others = nodes
    .filter((node) => !contains(node, edge.from) && !contains(node, edge.to))
    .map((node) => grow(extentOfBox(faceOf(node)), ATTACH_MARGIN / 2));
  const clear = (a: Point, b: Point): boolean =>
    ![...own, ...others].some((box) => segmentHits(a, b, box));

  const kept = [points[0]!];
  let at = 0;
  while (at < points.length - 1) {
    let next = at + 1;
    for (let far = points.length - 1; far > at + 1; far -= 1) {
      if (clear(points[at]!, points[far]!)) {
        next = far;
        break;
      }
    }
    kept.push(points[next]!);
    at = next;
  }
  return kept;
}

/**
 * A line cut in two at `at`, a point on one of its pieces, each half keeping
 * `at` as its end. A point on no piece cuts at the nearest one.
 */
function splitAt(points: Point[], at: Point): [Point[], Point[]] {
  let piece = 0;
  let nearest = Infinity;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const t = length === 0 ? 0 : Math.max(0, Math.min(1,
      ((at.x - a.x) * (b.x - a.x) + (at.y - a.y) * (b.y - a.y)) / (length * length)));
    const off = Math.hypot(a.x + t * (b.x - a.x) - at.x, a.y + t * (b.y - a.y) - at.y);
    if (off < nearest) {
      nearest = off;
      piece = index;
    }
  }
  return [
    tidyRoute([...points.slice(0, piece), at]),
    tidyRoute([at, ...points.slice(piece)]),
  ];
}

function extentOfBox(box: Box): Extent {
  return { minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height };
}

/** Whether the segment from `a` to `b` passes through the inside of `box`. */
function segmentHits(a: Point, b: Point, box: Extent): boolean {
  if (box.maxX <= box.minX || box.maxY <= box.minY) return false;
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: [number, number][] = [
    [-dx, a.x - box.minX],
    [dx, box.maxX - a.x],
    [-dy, a.y - box.minY],
    [dy, box.maxY - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}

/**
 * Where a jointed line's text rides: the middle of its longest level piece, if
 * one is long enough to hold the text with line showing either side, and the
 * middle of its longest piece otherwise. A level piece comes first because a
 * text knocks a hole as wide as itself, which on an upright piece is a hole far
 * wider than the line — and lines grouped on one side sit a text's height apart
 * on their level pieces, never a text's width apart on their upright ones.
 */
function textSpot(points: Point[], textWidth: number): Point {
  let best = { x: (points[0]!.x + points[points.length - 1]!.x) / 2, y: (points[0]!.y + points[points.length - 1]!.y) / 2 };
  let level: Point | undefined;
  let longest = -1;
  let longestLevel = -1;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const here = Math.hypot(b.x - a.x, b.y - a.y);
    const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (here > longest + 0.5) {
      longest = here;
      best = middle;
    }
    if (Math.abs(b.y - a.y) < 0.5 && here >= textWidth + ARROW_LENGTH * 2 && here > longestLevel + 0.5) {
      longestLevel = here;
      level = middle;
    }
  }
  return level ?? best;
}

function sharpPath(points: Point[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${round(point.x)} ${round(point.y)}`).join(' ');
}

/**
 * A drawn line's element read back as a polyline, curves flattened. Reading
 * the element rather than each drawing branch keeping its own record means the
 * crossings are found on exactly what was drawn.
 */
function traceOf(element: string): Point[] {
  const line = /<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/.exec(element);
  if (line) {
    return [
      { x: Number(line[1]), y: Number(line[2]) },
      { x: Number(line[3]), y: Number(line[4]) },
    ];
  }
  const d = /d="([^"]*)"/.exec(element)?.[1] ?? '';
  const tokens = d.match(/[MLC]|-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? [];
  const points: Point[] = [];
  let command = 'M';
  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index]!;
    if (/[MLC]/.test(token)) {
      command = token;
      index += 1;
      continue;
    }
    const read = (): Point => {
      const point = { x: Number(tokens[index]), y: Number(tokens[index + 1]) };
      index += 2;
      return point;
    };
    if (command === 'C') {
      const from = points[points.length - 1]!;
      const [c1, c2, to] = [read(), read(), read()];
      for (let step = 1; step <= 12; step += 1) {
        const t = step / 12;
        const u = 1 - t;
        points.push({
          x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
          y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
        });
      }
    } else {
      points.push(read());
    }
  }
  return points;
}

// --- crossings ------------------------------------------------------------------

/** Where one line crosses an earlier one, and which way it is heading there. */
interface Crossing {
  at: Point;
  along: Point;
  /** Half the length of line the crossing takes out. */
  reach: number;
}

/**
 * Where each line with a `crossing:` style crosses a line declared before it.
 * The later line is the one that jumps, so the file's order says who goes over,
 * and a line never jumps where it leaves or arrives — a crossing that close to
 * an end is two lines meeting at a box, not passing each other.
 */
function findCrossings(drawn: DrawnEdge[]): Map<DrawnEdge, Crossing[]> {
  const found = new Map<DrawnEdge, Crossing[]>();
  drawn.forEach((later, index) => {
    if (later.edge.look.crossing === 'none') return;
    const crossings: Crossing[] = [];
    for (const earlier of drawn.slice(0, index)) {
      const reach = 3 + later.edge.look.thickness * 1.5 + earlier.edge.look.thickness / 2;
      const clear = reach + arrowLength(later.edge.look.thickness);
      const ends = [later.trace[0]!, later.trace[later.trace.length - 1]!, earlier.trace[0]!, earlier.trace[earlier.trace.length - 1]!];
      for (let i = 1; i < later.trace.length; i += 1) {
        const a = later.trace[i - 1]!;
        const b = later.trace[i]!;
        for (let j = 1; j < earlier.trace.length; j += 1) {
          const at = intersect(a, b, earlier.trace[j - 1]!, earlier.trace[j]!);
          if (!at) continue;
          if (ends.some((end) => Math.hypot(end.x - at.x, end.y - at.y) < clear)) continue;
          if (crossings.some((c) => Math.hypot(c.at.x - at.x, c.at.y - at.y) < (c.reach + reach) * 1.2)) continue;
          const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          crossings.push({ at, along: { x: (b.x - a.x) / length, y: (b.y - a.y) / length }, reach });
        }
      }
    }
    if (crossings.length > 0) found.set(later, crossings);
  });
  return found;
}

/** Where two segments cross, if they do. Lines that only touch or run together do not. */
function intersect(a: Point, b: Point, c: Point, d: Point): Point | undefined {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denominator = r.x * s.y - r.y * s.x;
  if (Math.abs(denominator) < 1e-9) return undefined;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denominator;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denominator;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return undefined;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

/**
 * The jump drawn over one crossing: a half circle for `arc`, three sides of a
 * square for `square`, and nothing for `gap`, which is the cut alone. A jump
 * rises to the same side everywhere — up, or right on a line going straight up
 * or down — so a row of them reads as one line hopping.
 */
function jumpAt(crossing: Crossing, style: LineLook['crossing']): string | undefined {
  const { at, along, reach } = crossing;
  let normal = { x: along.y, y: -along.x };
  if (normal.y > 1e-6 || (Math.abs(normal.y) <= 1e-6 && normal.x < 0)) normal = { x: -normal.x, y: -normal.y };
  const a = { x: at.x - along.x * reach, y: at.y - along.y * reach };
  const b = { x: at.x + along.x * reach, y: at.y + along.y * reach };
  if (style === 'arc') {
    // Which way round the arc sweeps depends on which side of the line is up.
    const sweep = along.x * normal.y - along.y * normal.x < 0 ? 1 : 0;
    return `M ${round(a.x)} ${round(a.y)} A ${round(reach)} ${round(reach)} 0 0 ${sweep} ${round(b.x)} ${round(b.y)}`;
  }
  if (style === 'square') {
    const up = (p: Point): Point => ({ x: p.x + normal.x * reach, y: p.y + normal.y * reach });
    return sharpPath([a, up(a), up(b), b]);
  }
  return undefined;
}

function union(a: Extent, b: Extent): Extent {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function grow(extent: Extent, by: number): Extent {
  return {
    minX: extent.minX - by,
    minY: extent.minY - by,
    maxX: extent.maxX + by,
    maxY: extent.maxY + by,
  };
}

function extentOfPoints(points: Point[]): Extent {
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}

/**
 * What a cubic actually covers, which is not what its control points cover. A
 * handle reaching 140 pixels up carries the curve only about three quarters of
 * that, and sizing the page off the handles would leave a visible band of empty
 * canvas above every curved edge. Solved rather than sampled: the extremes are
 * the ends plus wherever the derivative — a quadratic — crosses zero.
 */
function cubicExtent(p0: Point, c1: Point, c2: Point, p3: Point): Extent {
  const span = (a: number, b: number, c: number, d: number): [number, number] => {
    const values = [a, d];
    // The derivative of the cubic, written as a quadratic in t.
    const qa = 3 * (-a + 3 * b - 3 * c + d);
    const qb = 6 * (a - 2 * b + c);
    const qc = 3 * (b - a);
    const roots: number[] = [];
    if (Math.abs(qa) < 1e-9) {
      if (Math.abs(qb) > 1e-9) roots.push(-qc / qb);
    } else {
      const disc = qb * qb - 4 * qa * qc;
      if (disc >= 0) {
        const root = Math.sqrt(disc);
        roots.push((-qb + root) / (2 * qa), (-qb - root) / (2 * qa));
      }
    }
    for (const t of roots) {
      if (t <= 0 || t >= 1) continue;
      const u = 1 - t;
      values.push(u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d);
    }
    return [Math.min(...values), Math.max(...values)];
  };

  const [minX, maxX] = span(p0.x, c1.x, c2.x, p3.x);
  const [minY, maxY] = span(p0.y, c1.y, c2.y, p3.y);
  return { minX, minY, maxX, maxY };
}

/** Walk out from the center of a box toward a point, stopping at the border. */
function sidePoint(box: Box, toward: { x: number; y: number }): { x: number; y: number } {
  const center = centerOf(box);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (dx === 0 && dy === 0) return center;
  if (box.round) {
    const scale = box.width / 2 / Math.hypot(dx, dy);
    return { x: center.x + dx * scale, y: center.y + dy * scale };
  }

  const scaleX = dx === 0 ? Infinity : box.width / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : box.height / 2 / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);

  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

// --- where an edge meets a box -------------------------------------------------

// The four sides an edge may attach to. Deliberately not `ATTACH_SIDES` from
// `ast.ts`, which carries `center` as well because an alignment can share a
// center line and an attachment cannot sit on one.
const ATTACH_SIDES = ['top', 'bottom', 'left', 'right'] as const;
type AttachSide = (typeof ATTACH_SIDES)[number];

/** A point on a box's border, with the outward direction the line takes there. */
interface Anchor {
  x: number;
  y: number;
  /** Unit vector pointing out of the box. */
  tx: number;
  ty: number;
  /** The side the author named, or undefined when the renderer chose the point. */
  side?: AttachSide;
}

interface EdgeEnds {
  start: Anchor;
  end: Anchor;
  /**
   * How far the middle of the line is pushed across its own run, when the two
   * boxes are too small to give the group enough edge to spread along. See
   * `planSpreads`.
   */
  bow?: { x: number; y: number };
}

/** One edge's claim on one side of one box, before the point on it is known. */
interface Claim {
  edge: LayoutEdge;
  which: 'start' | 'end';
  side: AttachSide;
  /** Where the far end of this edge sits, which is what orders claims along the side. */
  toward: { x: number; y: number };
  /**
   * Where this claim sits in the lane order of its bundle, or undefined when
   * the edge is in none. `toward` cannot order edges that go to the same place,
   * and a bundle is exactly the case where they all do.
   */
  rank?: number;
}

/**
 * The edges running between one pair of sides.
 *
 * Two edges joining the bottom of A to the left of B are not two independent
 * orderings, one per side; they are one order used twice. Step outward along
 * A's bottom edge and the same edge must step outward along B's left edge, or
 * the two lines scissor across each other instead of nesting. So a bundle
 * carries a single lane index per edge and applies it at both ends, with the
 * sense of one end tied to the sense of the other.
 *
 * `planEndpoints` on its own cannot get this right, and the reason is worth
 * keeping: it orders each side by where the far ends sit, which is the correct
 * rule and a degenerate one here — every edge in a bundle has the *same* far
 * box, so that signal says nothing and the two sides end up ordered without
 * reference to each other.
 */
interface Bundle {
  /** The two (node, side) pairs the bundle runs between. */
  ends: [BundleEnd, BundleEnd];
  /** The edges, in lane order: index 0 sits at one extreme of the group. */
  lanes: LayoutEdge[];
  /**
   * Whether a step along the first end's side is a step the same way along the
   * second's. False is the common case for a corner-to-corner pair: further
   * left along a bottom edge is further *down* the left edge it aims at.
   */
  aligned: boolean;
  /** How far apart adjacent lanes sit, measured along either side. */
  step: number;
}

interface BundleEnd {
  node: LayoutNode;
  side: AttachSide;
}

/**
 * Work out where every edge meets every box.
 *
 * An author names a *side* — `to: top` — and never a point on it. Alone on a
 * side an edge lands at its center; sharing the side with others, the points
 * spread so they do not sit on top of each other. Which one goes where is
 * derived from where the far ends actually are, never chosen: of two edges
 * arriving at one top edge, the one coming from further left arrives further
 * left. That is the same rule as box non-overlap — the tool separates things by
 * default, and reads the direction off the solved layout rather than asking.
 *
 * Where several edges run between the *same* pair of sides that rule has
 * nothing to read, and a `Bundle` supplies the order instead — see there.
 */
function planEndpoints(
  edges: LayoutEdge[],
  measurer: Measurer,
  fontSize: number,
): Map<LayoutEdge, EdgeEnds> {
  const claims = new Map<LayoutNode, Map<AttachSide, Claim[]>>();
  const achieved = new Map<LayoutNode, Map<AttachSide, number>>();
  const named = new Map<LayoutEdge, { start?: Anchor; end?: Anchor }>();
  const bundles = planBundles(edges, measurer, fontSize);
  const spreads = planSpreads(edges, measurer, fontSize);

  for (const edge of edges) {
    named.set(edge, {});
    const fromSide = sideAttr(edge, 'from');
    const toSide = sideAttr(edge, 'to');
    if (fromSide) {
      claim(claims, edge.from, fromSide, {
        edge,
        which: 'start',
        side: fromSide,
        toward: centerOf(faceOf(edge.to)),
        rank: rankIn(bundles.get(edge), edge, edge.from, fromSide),
      });
    }
    if (toSide) {
      claim(claims, edge.to, toSide, {
        edge,
        which: 'end',
        side: toSide,
        toward: centerOf(faceOf(edge.from)),
        rank: rankIn(bundles.get(edge), edge, edge.to, toSide),
      });
    }
  }

  // Place every claimed side, spreading the points that share one.
  for (const [node, bySide] of claims) {
    const face = faceOf(node);
    for (const [side, group] of bySide) {
      const along = side === 'top' || side === 'bottom' ? 'x' : 'y';
      const span = along === 'x' ? face.width : face.height;
      const origin = along === 'x' ? face.x : face.y;

      // Far ends first, as ever; a bundle's own lane order settles the edges
      // that share one, which are precisely the ones the first key cannot.
      const ordered = [...group].sort(
        (a, b) => a.toward[along] - b.toward[along] || (a.rank ?? 0) - (b.rank ?? 0),
      );
      // A bundle's lanes have to hold whole texts apart rather than the points
      // of two arrows, so its step is the one that governs the side it lands on.
      const wanted = Math.max(
        ATTACH_STEP,
        ...group.map((entry) => bundles.get(entry.edge)?.step ?? 0),
      );
      const usable = Math.max(0, span - ATTACH_MARGIN * 2);
      const step = ordered.length > 1 ? Math.min(wanted, usable / (ordered.length - 1)) : 0;
      const first = origin + span / 2 - (step * (ordered.length - 1)) / 2;

      ordered.forEach((entry, index) => {
        const at = first + index * step;
        named.get(entry.edge)![entry.which] = anchorOn(face, side, at);
      });
      // What the side could actually give, which is less than `wanted` when it
      // is too short for the group. `bowBundles` makes up the difference.
      let steps = achieved.get(node);
      if (!steps) achieved.set(node, (steps = new Map()));
      steps.set(side, step);
    }
  }

  const bows = bowBundles(bundles, achieved);

  // Fill in the ends the author said nothing about, now that the named ones
  // are known: an unnamed end aims at wherever its partner ended up.
  const ends = new Map<LayoutEdge, EdgeEnds>();
  for (const edge of edges) {
    const partial = named.get(edge)!;
    const fromFace = faceOf(edge.from);
    const toFace = faceOf(edge.to);
    // Several edges between one pair of boxes with no side named anywhere: the
    // line each would have drawn alone, moved aside so they do not coincide.
    const spread = spreads.get(edge);
    if (spread) {
      ends.set(edge, { ...parallelEnds(fromFace, toFace, spread.offset), bow: spread.bow });
      continue;
    }
    // With neither end named this is the straight line it always was, each end
    // aiming at the other box's center.
    const start = partial.start ?? free(fromFace, partial.end ?? centerOf(toFace));
    const end = partial.end ?? free(toFace, partial.start ?? centerOf(fromFace));
    ends.set(edge, { start, end, bow: bows.get(edge) });
  }
  return ends;
}

/**
 * Group the edges that run between the same pair of sides, and work out the
 * lane order and lane width each group needs.
 *
 * Only an edge whose author named *both* sides can be in a bundle: a bundle is a
 * statement about two specific edges, and an end with no side named has not
 * picked one yet.
 */
function planBundles(
  edges: LayoutEdge[],
  measurer: Measurer,
  fontSize: number,
): Map<LayoutEdge, Bundle> {
  const ids = new Map<LayoutNode, number>();
  const idOf = (node: LayoutNode): number => {
    let id = ids.get(node);
    if (id === undefined) {
      id = ids.size;
      ids.set(node, id);
    }
    return id;
  };

  const groups = new Map<string, { ends: [BundleEnd, BundleEnd]; edges: LayoutEdge[] }>();
  for (const edge of edges) {
    const fromSide = sideAttr(edge, 'from');
    const toSide = sideAttr(edge, 'to');
    if (!fromSide || !toSide || edge.from === edge.to) continue;

    const a = { node: edge.from, side: fromSide };
    const b = { node: edge.to, side: toSide };
    const keyA = `${idOf(a.node)}:${a.side}`;
    const keyB = `${idOf(b.node)}:${b.side}`;
    // The pair is unordered — `a -> b` and `b -> a` join the same two edges —
    // so the key is canonical and the ends are stored in that same order.
    const swap = keyB < keyA;
    const key = swap ? `${keyB}|${keyA}` : `${keyA}|${keyB}`;
    const ends: [BundleEnd, BundleEnd] = swap ? [b, a] : [a, b];

    const group = groups.get(key);
    if (group) group.edges.push(edge);
    else groups.set(key, { ends, edges: [edge] });
  }

  const bundles = new Map<LayoutEdge, Bundle>();
  for (const group of groups.values()) {
    if (group.edges.length < 2) continue;
    const [first, second] = group.ends;
    const t0 = tangentOf(first.side);
    const t1 = tangentOf(second.side);
    const from = sideCenter(first);
    const to = sideCenter(second);
    const run = { x: to.x - from.x, y: to.y - from.y };

    // Nesting is a matter of which side of the line each end steps toward. Step
    // both ends to the same side of the run and the whole line translates;
    // step them to opposite sides and it pivots, which is a crossing.
    const aligned = cross(run, t0) * cross(run, t1) >= 0;
    const sense = aligned ? 1 : -1;

    // Two edges leaving in opposite directions are the ordinary case, and which
    // lane each takes is then read off the diagram rather than off the order the
    // author happened to type them in: a line keeps to one side of its own run.
    // Edges pointing the same way have no such signal and fall back to the file.
    const order = new Map(group.edges.map((edge, index) => [edge, index]));
    const lanes = [...group.edges].sort(
      (a, b) =>
        Number(a.from !== first.node) - Number(b.from !== first.node) ||
        order.get(a)! - order.get(b)!,
    );

    // One lane apart moves an edge's start by `step` along one side and its end
    // by `step` along the other, so the midpoint of the line — which is where
    // its text goes — moves by the average of the two.
    const drift = { x: (t0.x + sense * t1.x) / 2, y: (t0.y + sense * t1.y) / 2 };
    const bundle: Bundle = {
      ends: group.ends,
      lanes,
      aligned,
      step: Math.max(ATTACH_STEP, laneStep(lanes, drift, measurer, fontSize)),
    };
    for (const edge of lanes) bundles.set(edge, bundle);
  }
  return bundles;
}

/** Where one edge of a coincident group runs, relative to the line it would draw alone. */
interface Spread {
  /** How far its two ends are moved across the run. */
  offset: number;
  /**
   * How far its middle is moved further still, as a vector. Zero — and so a
   * straight line — whenever the boxes are big enough to hold the whole group
   * at full spacing, which is the ordinary case.
   */
  bow: { x: number; y: number };
}

/**
 * The sideways offset each edge takes when several run between the same two
 * boxes and none of them names a side.
 *
 * An unnamed end has no side to spread along: it aims at the far box's center
 * and attaches wherever that ray crosses the border, so every edge in such a
 * group produces the *same* ray and they are drawn on top of one another —
 * one visible line, every text stacked on one point. `planEndpoints` cannot
 * see this and `planBundles` will not, since a bundle is a statement about two
 * named edges.
 *
 * The repair keeps the attachment rule exactly as it is and only stops two
 * edges using it at the same place: the line an edge would have drawn alone is
 * translated across its own run by a lane, which is the straight-line version
 * of the nesting a bundle already gives curves. A lone edge is in no group and
 * so is untouched.
 *
 * Where the boxes are too small to hold the group at full spacing, the ends
 * are squeezed evenly to fit the edge — there is nowhere further to attach —
 * and the shortfall is made up in the middle instead: each line bows across
 * its run by exactly what its endpoints could not give it, so the texts, which
 * ride at the midpoints, come apart even though the arrows do not. The bow is
 * therefore derived rather than styled, and it is zero whenever the edge was
 * long enough, which is why the ordinary case is still a straight line.
 *
 * A `between` edge is left out. Its route is the corridor it named, its lane
 * inside that corridor is `planCorridors`' business, and `aimFreeEnds` will
 * re-aim these ends at the corridor afterwards regardless.
 */
function planSpreads(
  edges: LayoutEdge[],
  measurer: Measurer,
  fontSize: number,
): Map<LayoutEdge, Spread> {
  const ids = new Map<LayoutNode, number>();
  const idOf = (node: LayoutNode): number => {
    let id = ids.get(node);
    if (id === undefined) {
      id = ids.size;
      ids.set(node, id);
    }
    return id;
  };

  const groups = new Map<string, { first: LayoutNode; edges: LayoutEdge[] }>();
  for (const edge of edges) {
    if (sideAttr(edge, 'from') || sideAttr(edge, 'to')) continue;
    if (edge.from === edge.to || edge.between) continue;

    const a = idOf(edge.from);
    const b = idOf(edge.to);
    const swap = b < a;
    const key = swap ? `${b}|${a}` : `${a}|${b}`;
    const first = swap ? edge.to : edge.from;

    const group = groups.get(key);
    if (group) group.edges.push(edge);
    else groups.set(key, { first, edges: [edge] });
  }

  const spreads = new Map<LayoutEdge, Spread>();
  for (const group of groups.values()) {
    if (group.edges.length < 2) continue;
    const from = centerOf(faceOf(group.first));
    const sample = group.edges[0]!;
    const other = sample.from === group.first ? sample.to : sample.from;
    const to = centerOf(faceOf(other));
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    // Translating the line moves its midpoint — where the text goes — by
    // exactly this, so it is the drift `laneStep` needs.
    const across = { x: -dy / length, y: dx / length };

    // The same derived order a bundle uses: edges pointing opposite ways each
    // keep to one side of their own run, so a reciprocal pair reads as a
    // circulation, and only edges pointing the same way fall back to the file.
    const order = new Map(group.edges.map((edge, index) => [edge, index]));
    const lanes = [...group.edges].sort(
      (a, b) =>
        Number(a.from !== group.first) - Number(b.from !== group.first) ||
        order.get(a)! - order.get(b)!,
    );

    // How far a lane may be shifted before its line no longer passes through the
    // box at all. `exitAlong` clamps beyond that, which piles the outer lanes
    // onto a corner and puts their texts back on top of each other — so the
    // group is squeezed evenly instead, exactly as `planEndpoints` squeezes a
    // side too short for the edges arriving on it, and just as silently.
    const reach = (node: LayoutNode): number => {
      const face = faceOf(node);
      const byX = across.x === 0 ? Infinity : face.width / 2 / Math.abs(across.x);
      const byY = across.y === 0 ? Infinity : face.height / 2 / Math.abs(across.y);
      return Math.max(0, Math.min(byX, byY) - ATTACH_MARGIN);
    };
    // Which way lane 0 lies is arbitrary, so fix it the way the rest of the
    // renderer does — toward increasing x, or increasing y where the run is
    // horizontal. Without this the first edge written is topmost on a rightward
    // run and rightmost on a downward one, for no reason a reader could see.
    const orient = across.x < 0 || (across.x === 0 && across.y < 0) ? -1 : 1;
    const usable = 2 * Math.min(reach(group.first), reach(other));
    const wanted = Math.max(ATTACH_STEP, laneStep(lanes, across, measurer, fontSize));
    const step = Math.min(wanted, usable / (lanes.length - 1));
    lanes.forEach((edge, index) => {
      const place = index - (lanes.length - 1) / 2;
      // The lane is measured across the pair's own run, which has one direction;
      // an edge written the other way round travels the opposite way and would
      // otherwise take the same offset to the opposite side, putting a
      // reciprocal pair back on one line. Negated, both keep to their own left,
      // which is the circulation a bundle already draws.
      const sense = (edge.from === group.first ? 1 : -1) * orient;
      const shortfall = place * (wanted - step) * sense;
      spreads.set(edge, {
        offset: place * step * sense,
        bow: { x: across.x * shortfall, y: across.y * shortfall },
      });
    });
  }
  return spreads;
}

/**
 * The bow each bundled edge needs, where the sides it was given were too short
 * to hold the group at the spacing its texts asked for.
 *
 * A named side is squeezed exactly as an unnamed group's edge is — the step
 * shrinks to `usable / (n - 1)` and the texts ride down on top of each other —
 * and until this existed, naming the two sides the tool would have chosen
 * anyway made the picture strictly worse than saying nothing. That is not a
 * line worth defending, so the same repair applies: a lane's midpoint is not
 * on an edge and is free to move, and each line makes up in the middle exactly
 * what its two ends could not give it.
 *
 * The shortfall is a vector because the two ends move along different sides.
 * `drift` is how far a lane's midpoint travels per unit of step — the average
 * of the two ends' displacements, which is what `laneStep` sized the step
 * against — so the room a lane wanted is `drift * step`, the room it got is the
 * same average taken over the steps the two sides actually managed, and the
 * bow is the difference. It is zero whenever both sides were long enough,
 * which is why nothing that already fitted has moved.
 */
function bowBundles(
  bundles: Map<LayoutEdge, Bundle>,
  achieved: Map<LayoutNode, Map<AttachSide, number>>,
): Map<LayoutEdge, { x: number; y: number }> {
  const bows = new Map<LayoutEdge, { x: number; y: number }>();
  const stepOn = (end: BundleEnd): number => achieved.get(end.node)?.get(end.side) ?? 0;

  for (const bundle of new Set(bundles.values())) {
    const [first, second] = bundle.ends;
    const t0 = tangentOf(first.side);
    const t1 = tangentOf(second.side);
    const sense = bundle.aligned ? 1 : -1;
    const drift = { x: (t0.x + sense * t1.x) / 2, y: (t0.y + sense * t1.y) / 2 };

    const s0 = stepOn(first);
    const s1 = stepOn(second);
    const got = { x: (s0 * t0.x + sense * s1 * t1.x) / 2, y: (s0 * t0.y + sense * s1 * t1.y) / 2 };
    const short = {
      x: drift.x * bundle.step - got.x,
      y: drift.y * bundle.step - got.y,
    };
    if (short.x === 0 && short.y === 0) continue;

    bundle.lanes.forEach((edge, index) => {
      const place = index - (bundle.lanes.length - 1) / 2;
      bows.set(edge, { x: short.x * place, y: short.y * place });
    });
  }
  return bows;
}

/**
 * How far apart adjacent lanes must sit for their texts to clear each other.
 *
 * The texts are knockout rectangles, so two of them clear when they are apart
 * on *either* axis — hence the smaller of the two answers. `drift` is how far
 * the midpoint travels per unit of step, and it is never zero: the two ends
 * cancel only when both sides run the same way, and two such sides are always
 * `aligned`, which adds rather than subtracts.
 */
function laneStep(
  lanes: LayoutEdge[],
  drift: { x: number; y: number },
  measurer: Measurer,
  fontSize: number,
): number {
  const withText = lanes.filter((edge) => edge.text !== undefined);
  if (withText.length < 2) return 0;

  const need = (axis: Axis): number =>
    Math.max(
      ...withText.map((edge) =>
        textExtent(edge.lines!, edge.textAttrs, axis, measurer, fontSize, edge.line),
      ),
    );

  const along = (axis: Axis, reach: number): number =>
    reach === 0 ? Infinity : need(axis) / Math.abs(reach);
  return Math.min(along('x', drift.x), along('y', drift.y));
}

/** Which lane of its bundle an edge's end at this side takes, if it is in one. */
function rankIn(
  bundle: Bundle | undefined,
  edge: LayoutEdge,
  node: LayoutNode,
  side: AttachSide,
): number | undefined {
  if (!bundle) return undefined;
  const lane = bundle.lanes.indexOf(edge);
  const [first, second] = bundle.ends;
  if (node === first.node && side === first.side) return lane;
  if (node === second.node && side === second.side) return bundle.aligned ? lane : -lane;
  return undefined;
}

/** The unit vector along a side, pointing the way that coordinate increases. */
function tangentOf(side: AttachSide): { x: number; y: number } {
  return side === 'top' || side === 'bottom' ? { x: 1, y: 0 } : { x: 0, y: 1 };
}

/** The midpoint of one side of a box. */
function sideCenter(end: BundleEnd): { x: number; y: number } {
  const face = faceOf(end.node);
  const along = end.side === 'top' || end.side === 'bottom' ? face.width : face.height;
  const origin = end.side === 'top' || end.side === 'bottom' ? face.x : face.y;
  return anchorOn(face, end.side, origin + along / 2);
}

function cross(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return a.x * b.y - a.y * b.x;
}

function claim(
  claims: Map<LayoutNode, Map<AttachSide, Claim[]>>,
  node: LayoutNode,
  side: AttachSide,
  entry: Claim,
): void {
  let bySide = claims.get(node);
  if (!bySide) {
    bySide = new Map();
    claims.set(node, bySide);
  }
  const group = bySide.get(side);
  if (group) group.push(entry);
  else bySide.set(side, [entry]);
}

/** The point `at` along one side of a box, with the outward normal for that side. */
function anchorOn(face: Box, side: AttachSide, at: number): Anchor {
  if (face.round) return anchorOnCircle(face, side, at);
  switch (side) {
    case 'top':
      return { x: at, y: face.y, tx: 0, ty: -1, side };
    case 'bottom':
      return { x: at, y: face.y + face.height, tx: 0, ty: 1, side };
    case 'left':
      return { x: face.x, y: at, tx: -1, ty: 0, side };
    case 'right':
      return { x: face.x + face.width, y: at, tx: 1, ty: 0, side };
  }
}

/**
 * The same, on a circle: a side is the quarter of the circle around its
 * compass point, and `at` is walked round the arc rather than along a
 * straight edge, so points spaced a step apart on a side are a step apart on
 * the circle too. The line meets the circle square on, heading from its center.
 */
function anchorOnCircle(face: Box, side: AttachSide, at: number): Anchor {
  const radius = face.width / 2;
  const center = centerOf(face);
  const across = side === 'top' || side === 'bottom' ? at - center.x : at - center.y;
  const turn = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, across / radius));
  // SVG's y runs down, so the bottom is a quarter-turn clockwise from the right.
  const angle = {
    right: turn,
    bottom: Math.PI / 2 - turn,
    left: Math.PI - turn,
    top: -Math.PI / 2 + turn,
  }[side];
  const tx = Math.cos(angle);
  const ty = Math.sin(angle);
  return { x: center.x + radius * tx, y: center.y + radius * ty, tx, ty, side };
}

/** An end with no side named: leave from the border, pointing at the far end. */
function free(face: Box, toward: { x: number; y: number }): Anchor {
  const point = sidePoint(face, toward);
  const center = centerOf(face);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: point.x, y: point.y, tx: dx / length, ty: dy / length };
}

/**
 * Walk from a point inside a box along a direction, stopping at the border.
 *
 * `sidePoint` walks from the center, which is the only place a single line
 * passes through. A fanned-out group's lines are parallel to that one and
 * beside it, so each needs the border crossing of its own line rather than of
 * the center's — which is what keeps the group parallel instead of splayed.
 */
function exitAlong(
  box: Box,
  from: { x: number; y: number },
  dir: { x: number; y: number },
): { x: number; y: number } {
  // A shift wider than the box leaves the origin outside it; clamping back in
  // is the graceful answer, and the crowding it signals is a diagnostic.
  const x = Math.min(Math.max(from.x, box.x), box.x + box.width);
  const y = Math.min(Math.max(from.y, box.y), box.y + box.height);
  if (box.round) {
    // Where the ray leaves the circle: the larger root of |p + t·dir − c| = r.
    const center = centerOf(box);
    const px = x - center.x;
    const py = y - center.y;
    const a = dir.x * dir.x + dir.y * dir.y;
    const b = px * dir.x + py * dir.y;
    const c = px * px + py * py - (box.width / 2) ** 2;
    const reach = b * b - a * c;
    if (a === 0 || reach < 0) return { x, y };
    const t = Math.max(0, (-b + Math.sqrt(reach)) / a);
    return { x: x + dir.x * t, y: y + dir.y * t };
  }
  const tx = dir.x === 0 ? Infinity : ((dir.x > 0 ? box.x + box.width : box.x) - x) / dir.x;
  const ty = dir.y === 0 ? Infinity : ((dir.y > 0 ? box.y + box.height : box.y) - y) / dir.y;
  const t = Math.min(tx, ty);
  if (!Number.isFinite(t)) return { x, y };
  return { x: x + dir.x * Math.max(0, t), y: y + dir.y * Math.max(0, t) };
}

/**
 * Both ends of an edge that named no side, moved `offset` sideways across its
 * own run.
 *
 * The whole line is translated rather than each end being nudged along its
 * border, so the result is genuinely parallel to the line the edge would have
 * drawn alone, exactly `offset` away from it. Where each end lands then falls
 * out of that: level boxes put both points further along the same two edges,
 * and a diagonal pair whose line leaves through a corner puts one point on each
 * of the two edges meeting there. Neither is a case in the code.
 */
function parallelEnds(from: Box, to: Box, offset: number): EdgeEnds {
  const a = centerOf(from);
  const b = centerOf(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const dir = { x: dx / length, y: dy / length };
  const across = { x: -dir.y * offset, y: dir.x * offset };
  const startAt = exitAlong(from, { x: a.x + across.x, y: a.y + across.y }, dir);
  const endAt = exitAlong(to, { x: b.x + across.x, y: b.y + across.y }, { x: -dir.x, y: -dir.y });
  return {
    start: { x: startAt.x, y: startAt.y, tx: dir.x, ty: dir.y },
    end: { x: endAt.x, y: endAt.y, tx: -dir.x, ty: -dir.y },
  };
}

/** How far the control points sit off the ends. Proportional, but bounded. */
function controlReach(start: Anchor, end: Anchor): number {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  return Math.max(24, Math.min(140, distance * 0.4));
}

// --- corridors ----------------------------------------------------------------

/**
 * Where an edge runs while it is passing the two nodes a `between` clause named.
 *
 * A corridor is *measured*, never solved for: both nodes are already placed by
 * the time the renderer sees them, so the gap between them is a pair of numbers
 * and the edge is routed through it. Nothing here can move a box. That is the
 * deliberate half of the feature — an arrow states where it goes, and if the
 * gap it names is too tight, that is something to report rather than repair.
 */
interface Corridor {
  /** The axis the gap binds. A gap between something above and something below binds y. */
  axis: Axis;
  /** Where on that axis this edge runs. Several edges in one gap take their own lanes. */
  lane: number;
  /** Where the run begins and ends on the other axis, in the order the edge travels. */
  enter: number;
  leave: number;
  /**
   * The edge turns back on itself to reach the run, rather than curving into
   * it — the channel of an edge that goes around its row. See `planLoops`.
   */
  loop?: boolean;
}

interface Point {
  x: number;
  y: number;
}

/** The free interval between two boxes on one axis, or nothing if they overlap. */
function clearance(
  aStart: number,
  aSize: number,
  bStart: number,
  bSize: number,
): { lo: number; hi: number } | undefined {
  if (aStart + aSize < bStart) return { lo: aStart + aSize, hi: bStart };
  if (bStart + bSize < aStart) return { lo: bStart + bSize, hi: aStart };
  return undefined;
}

/**
 * Which gap `between a and b` means, and how far along it reaches.
 *
 * The axis is derived wherever the pair leaves only one answer, the same way a
 * separation direction is: one node is above the other, or one is left of the
 * other, and whichever it is says which axis the gap binds. Most pairs are like
 * that, and for them the file says nothing about axes at all.
 *
 * A pair sitting diagonally has two gaps and needs the author to pick, which is
 * what `wanted` carries. That is a tie-break rather than part of the statement:
 * where it is not needed it may still be written, and is then checked rather
 * than ignored, because a word that silently does nothing looks like a bug in
 * the tool.
 */
function gapBetween(
  a: Box,
  b: Box,
  aName: string,
  bName: string,
  wanted: Axis | undefined,
  line: number,
): { axis: Axis; lo: number; hi: number; across: [number, number] } {
  const pair = `"${aName}" and "${bName}"`;
  const found = {
    y: clearance(a.y, a.height, b.y, b.height),
    x: clearance(a.x, a.width, b.x, b.width),
  };

  if (wanted !== undefined && found[wanted] === undefined) {
    const other = wanted === 'y' ? 'x' : 'y';
    throw new SourceError(
      found[other]
        ? `${pair} have no gap between them ${describeAxis(wanted)} — they are apart ${describeAxis(other)}, so drop the word or say "${describeAxis(other)}"`
        : `${pair} touch or overlap, so there is no gap between them to pass through`,
      line,
    );
  }
  if (wanted === undefined && found.y && found.x) {
    throw new SourceError(
      `${pair} are apart both vertically and horizontally, so I cannot tell which gap you mean — write "between ${aName} and ${bName} vertically" for the gap above and below them, or "horizontally" for the gap beside them`,
      line,
    );
  }

  // Whichever was asked for, or whichever is the only one there is.
  const axis: Axis = wanted ?? (found.y ? 'y' : 'x');
  const gap = found[axis];
  if (!gap) {
    throw new SourceError(
      `${pair} touch or overlap, so there is no gap between them to pass through`,
      line,
    );
  }
  // The corridor reaches as far as the pair does on the other axis: that is the
  // stretch over which the line is actually passing them.
  return {
    axis,
    ...gap,
    across:
      axis === 'y'
        ? [Math.min(a.x, b.x), Math.max(a.x + a.width, b.x + b.width)]
        : [Math.min(a.y, b.y), Math.max(a.y + a.height, b.y + b.height)],
  };
}

/**
 * Route every edge that named a gap.
 *
 * Edges sharing one gap share its lanes, spread like attachments on a side and
 * ordered the same derived way — by where their ends actually sit, so the two
 * arriving at the hub's left edge in one order run through the corridor in that
 * same order and never cross.
 */
function planCorridors(
  edges: LayoutEdge[],
  ends: Map<LayoutEdge, EdgeEnds>,
  measurer: Measurer,
  fontSize: number,
): Map<LayoutEdge, Corridor> {
  const plans = new Map<LayoutEdge, Corridor>();
  const groups = new Map<
    string,
    { axis: Axis; lo: number; hi: number; across: [number, number]; members: LayoutEdge[] }
  >();

  for (const edge of edges) {
    if (!edge.between) continue;
    const [first, second] = edge.between.nodes;
    const gap = gapBetween(
      faceOf(first),
      faceOf(second),
      first.name,
      second.name,
      edge.between.axis,
      edge.line,
    );
    // The pair names one gap however the author ordered them. The axis is in
    // the key because a diagonal pair really does have two, and two edges may
    // legitimately name the same pair and take different ones.
    const key = [gap.axis, ...[first.name, second.name].sort()].join(' ');
    const group = groups.get(key);
    if (group) group.members.push(edge);
    else groups.set(key, { ...gap, members: [edge] });
  }

  for (const group of groups.values()) {
    const along = (edge: LayoutEdge): number => {
      const { start, end } = ends.get(edge)!;
      return (start[group.axis] + end[group.axis]) / 2;
    };
    const ordered = [...group.members].sort((a, b) => along(a) - along(b));

    // Lanes are spread as attachments on a side are, including the squeeze when
    // there is not enough room — see `planEndpoints`. The step is wider here,
    // because a lane carries a whole text rather than the point of an arrow,
    // and two lanes closer together than a text is deep would draw the texts
    // over each other. Still derived, not chosen: it is the size of what is
    // actually running along the corridor.
    const span = group.hi - group.lo;
    const usable = Math.max(0, span - ATTACH_MARGIN * 2);
    const want = Math.max(
      ATTACH_STEP,
      ...ordered.map((edge) => laneExtent(edge, group.axis, measurer, fontSize)),
    );
    const step = ordered.length > 1 ? Math.min(want, usable / (ordered.length - 1)) : 0;
    const firstLane = group.lo + span / 2 - (step * (ordered.length - 1)) / 2;

    ordered.forEach((edge, index) => {
      const { start, end } = ends.get(edge)!;
      const run: Axis = group.axis === 'y' ? 'x' : 'y';
      // The corridor binds only where the edge is actually passing the pair, so
      // its reach is the overlap of the pair's extent with the edge's own.
      const enterAt = Math.max(group.across[0], Math.min(start[run], end[run]));
      const leaveAt = Math.min(group.across[1], Math.max(start[run], end[run]));
      if (leaveAt <= enterAt) {
        const [a, b] = edge.between!.nodes;
        throw new SourceError(
          `this edge never passes between "${a.name}" and "${b.name}"`,
          edge.line,
        );
      }
      const forward = end[run] >= start[run];
      plans.set(edge, {
        axis: group.axis,
        lane: firstLane + index * step,
        enter: forward ? enterAt : leaveAt,
        leave: forward ? leaveAt : enterAt,
      });
    });
  }

  return plans;
}

/**
 * Route every edge that has to go around its own two boxes.
 *
 * An edge leaving the left of one box for the right of another, with the second
 * box further right, has to turn back on itself, and a single curve can only
 * do that by crossing its own boxes. In a row it flattened into a straight line
 * through both; stepped down, even by a `normal` gap, it still doubled back
 * across the first box. So such an edge runs along a channel instead, turning
 * back at each end: in the gap between its two boxes if that holds the line
 * and its text, and otherwise over the top of everything between its ends,
 * with its text on the top, where it cannot land on a box.
 *
 * Over the top, always, and round the right for a column. Nothing here weighs
 * one way round against the other: the shorter way ties in the case that
 * seemed to argue for it, and a default that flips on one box's height is
 * harder to predict than one that never does. The run is placed the way a
 * `between` channel is, measured off where the boxes landed.
 */
function planLoops(
  edges: LayoutEdge[],
  nodes: LayoutNode[],
  ends: Map<LayoutEdge, EdgeEnds>,
  corridors: Map<LayoutEdge, Corridor>,
  routes: Map<LayoutEdge, Route>,
  measurer: Measurer,
  fontSize: number,
): void {
  // Loops over the top, gathered so that two sharing a stretch can take a lane
  // each rather than drawing on top of one another.
  const tops: OutsideRun[] = [];
  for (const edge of edges) {
    if (corridors.has(edge) || edge.passes) continue;
    const { start, end } = ends.get(edge)!;
    if (start.side === undefined || end.side === undefined) continue;
    // Sides at right angles, one facing away from the other end. Going out
    // past both boxes and coming straight in is right when the boxes are side
    // by side. When the other end lies within the span of the box facing away
    // — stacked boxes — coming straight in would pass through that box, so
    // the curve is kept, which has room to bend round the corner; and if even
    // the curve hits a box, the line goes round the facing-away box on the
    // side it names.
    if (start.tx * end.tx + start.ty * end.ty === 0) {
      const away = awayEnd(edge, start, end);
      if (away && within(faceOf(away.node), away.anchor, away.other)) {
        if (curveHits(edge, ends.get(edge)!, nodes)) {
          implyRoute(edge, away.node, sidePass(away.anchor.side!), nodes, ends, routes, measurer, fontSize);
        }
        continue;
      }
      const inWay = nodes.filter(
        (node) => !(contains(node, edge.from) && contains(node, edge.to)),
      );
      const plan = turnBack(edge, start, end, inWay, routes, measurer, fontSize);
      if (plan) tops.push(plan);
      continue;
    }
    // Both sides facing the same way, one box behind the other: the line has
    // to get round that box to reach the far side, which a curve cannot. It
    // goes over the top, or round the right for a column, as a loop does.
    if (start.tx === end.tx && start.ty === end.ty) {
      const away = awayEnd(edge, start, end);
      if (away && curveHits(edge, ends.get(edge)!, nodes)) {
        implyRoute(edge, away.node, start.tx !== 0 ? 'above' : 'right', nodes, ends, routes, measurer, fontSize);
      }
      continue;
    }
    // The two ends point opposite ways along one axis, each away from the other.
    if (start.tx !== -end.tx || start.ty !== -end.ty) continue;
    const run: Axis = start.tx !== 0 ? 'x' : 'y';
    const across: Axis = run === 'x' ? 'y' : 'x';
    const outward = run === 'x' ? start.tx : start.ty;
    if (outward * (end[run] - start[run]) >= 0) continue;
    const a = faceOf(edge.from);
    const b = faceOf(edge.to);

    // Far enough out that the line reads as passing, and that half the text,
    // centered on the line, still clears the box beside it.
    const clear = Math.max(
      SEPARATION_GAP,
      laneExtent(edge, across, measurer, fontSize) / 2 + ATTACH_MARGIN,
    );
    const from = Math.min(lo(a, run), lo(b, run));
    const to = Math.max(hi(a, run), hi(b, run));
    const inWay = nodes.filter(
      (node) => !(contains(node, edge.from) && contains(node, edge.to)),
    );
    const blocked = (low: number, high: number): boolean =>
      inWay.some((node) => {
        const face = faceOf(node);
        return (
          lo(face, run) < to && hi(face, run) > from &&
          lo(face, across) < high && hi(face, across) > low
        );
      });

    // Boxes apart across the axis have a gap between them, and a line that
    // fits in it turns back through that — the shortest way, and the one a
    // single curve was reaching for.
    const [upper, lower] = lo(a, across) <= lo(b, across) ? [a, b] : [b, a];
    const gap = { lo: hi(upper, across), hi: lo(lower, across) };
    const middle = (gap.lo + gap.hi) / 2;
    if (gap.hi - gap.lo >= clear * 2 && !blocked(middle - clear, middle + clear)) {
      corridors.set(edge, {
        axis: across,
        lane: middle,
        enter: start[run],
        leave: end[run],
        loop: true,
      });
      continue;
    }

    // Otherwise over the top. Measured as distance outward — up for a row,
    // right for a column — so one loop serves both.
    const sign = across === 'y' ? -1 : 1;
    const out = (box: Box): [number, number] => {
      const [p, q] = [sign * lo(box, across), sign * hi(box, across)];
      return [Math.min(p, q), Math.max(p, q)];
    };
    const inner = Math.min(sign * start[across], sign * end[across]);
    // A box that shares the stretch and reaches into the band the line needs
    // pushes the line out past it, which can bring another into the band.
    const pushOut = (start: number): number => {
      let lane = start;
      for (let moved = true; moved; ) {
        moved = false;
        for (const node of inWay) {
          const face = faceOf(node);
          if (lo(face, run) >= to || hi(face, run) <= from) continue;
          const [near, far] = out(face);
          if (far + clear > lane && near < lane + clear && far > inner) {
            lane = far + clear;
            moved = true;
          }
        }
      }
      return lane;
    };
    tops.push({
      edge,
      across,
      sign,
      lane: pushOut(Math.max(out(a)[1], out(b)[1]) + clear),
      loop: true,
      from,
      to,
      height: sign * start[across] + sign * end[across],
      pushOut,
      place: (lane) =>
        corridors.set(edge, { axis: across, lane: sign * lane, enter: start[run], leave: end[run], loop: true }),
    });
  }

  // Lines over one stretch nest so they do not cross. A turn-back goes inside
  // any loop, because it comes in to a box from the side the loops pass over;
  // otherwise the shorter goes inside, and of two the same length, the one
  // whose ends sit further out. Each lane is as far from the one inside it as
  // the lanes of a named gap are.
  tops.sort((p, q) =>
    Number(p.loop) - Number(q.loop) || p.to - p.from - (q.to - q.from) || q.height - p.height);
  const placed: typeof tops = [];
  for (const top of tops) {
    for (let moved = true; moved; ) {
      moved = false;
      for (const other of placed) {
        if (other.across !== top.across || other.sign !== top.sign) continue;
        if (other.from >= top.to || top.from >= other.to) continue;
        const step = Math.max(
          ATTACH_STEP,
          laneExtent(top.edge, top.across, measurer, fontSize),
          laneExtent(other.edge, other.across, measurer, fontSize),
        );
        if (Math.abs(top.lane - other.lane) < step - 0.5) {
          top.lane = top.pushOut(other.lane + step);
          moved = true;
        }
      }
    }
    placed.push(top);
    top.place(top.lane);
  }
}

/**
 * A line that runs outside its boxes, parallel to them: a loop over the top of
 * a row, or a right-angled edge turning back. Distances are measured outward,
 * the way it goes, so one shape serves every side.
 */
interface OutsideRun {
  edge: LayoutEdge;
  across: Axis;
  sign: number;
  lane: number;
  /** A loop, rather than a right-angled edge turning back. */
  loop: boolean;
  /** The stretch along the run it spans. */
  from: number;
  to: number;
  /** How far out the two ends sit, the way the line goes: the higher ends take the inner lane. */
  height: number;
  /** A lane moved out past any box that reaches into the band the line needs. */
  pushOut: (lane: number) => number;
  /** Record the line at its final lane. */
  place: (lane: number) => void;
}

/**
 * A route for an edge whose named sides are at right angles and one of which
 * faces away from the other end: `from: left  to: top` with the far node to
 * the right. A single curve leaving that side can only turn back across its
 * own box. So the line steps out of the side facing away, goes out past both
 * boxes the way the other side faces, runs along there, and comes straight in
 * to the other side. Undefined when neither side faces away, where the curve
 * already reads right. The route is recorded in `routes` once its lane is
 * settled against any other line running outside the same boxes.
 */
function turnBack(
  edge: LayoutEdge,
  start: Anchor,
  end: Anchor,
  inWay: LayoutNode[],
  routes: Map<LayoutEdge, Route>,
  measurer: Measurer,
  fontSize: number,
): OutsideRun | undefined {
  const facesAway = (from: Anchor, to: Anchor): boolean =>
    from.tx * (to.x - from.x) + from.ty * (to.y - from.y) < 0;
  const startAway = facesAway(start, end);
  if (!startAway && !facesAway(end, start)) return undefined;
  // Planned from the end facing away, and turned round if that is the far end.
  const [away, other] = startAway ? [start, end] : [end, start];
  const [awayBox, otherBox] = (startAway ? [edge.from, edge.to] : [edge.to, edge.from]).map(faceOf) as [Box, Box];
  const run: Axis = away.tx !== 0 ? 'x' : 'y';
  const across: Axis = run === 'x' ? 'y' : 'x';
  const make = axesAcross(across).make;
  // The way the other side faces, which is the way the line goes out.
  const sign = across === 'y' ? other.ty : other.tx;
  const clear = Math.max(
    SEPARATION_GAP,
    laneExtent(edge, across, measurer, fontSize) / 2 + ATTACH_MARGIN,
  );
  const stub = away[run] + (run === 'x' ? away.tx : away.ty) * ROUTE_STUB;
  const from = Math.min(stub, other[run], lo(awayBox, run), lo(otherBox, run));
  const to = Math.max(stub, other[run], hi(awayBox, run), hi(otherBox, run));
  // Measured as distance outward, the way the line goes.
  const out = (box: Box): [number, number] => {
    const [p, q] = [sign * lo(box, across), sign * hi(box, across)];
    return [Math.min(p, q), Math.max(p, q)];
  };
  const inner = Math.min(sign * away[across], sign * other[across]);
  const pushOut = (start: number): number => {
    let level = start;
    for (let moved = true; moved; ) {
      moved = false;
      for (const node of inWay) {
        const face = faceOf(node);
        if (lo(face, run) >= to || hi(face, run) <= from) continue;
        const [near, far] = out(face);
        if (far + clear > level && near < level + clear && far > inner) {
          level = far + clear;
          moved = true;
        }
      }
    }
    return level;
  };
  return {
    edge,
    across,
    sign,
    lane: pushOut(Math.max(out(awayBox)[1], out(otherBox)[1]) + clear),
    loop: false,
    from,
    to,
    height: sign * away[across] + sign * other[across],
    pushOut,
    place: (lane) => {
      const at = sign * lane;
      // A shallow turn steps out no further than half its depth, the half
      // circle a loop's turn makes, so it stays inside any loop turning
      // round the same box.
      const outward = run === 'x' ? away.tx : away.ty;
      const step = away[run] + outward * Math.min(ROUTE_STUB, Math.abs(at - away[across]) / 2);
      const points = tidyRoute([away, make(step, away[across]), make(step, at), make(other[run], at), other]);
      // The text rides on the longest piece, which is the run outside the
      // boxes unless the two ends are nearly level.
      let mid = make((stub + other[run]) / 2, at);
      let best = -1;
      for (let index = 0; index + 1 < points.length; index += 1) {
        const [p, q] = [points[index]!, points[index + 1]!];
        const length = Math.hypot(q.x - p.x, q.y - p.y);
        if (length > best) {
          best = length;
          mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        }
      }
      routes.set(edge, { points: startAway ? points : points.reverse(), mid });
    },
  };
}

/**
 * Whether the single curve an edge would otherwise be drawn as passes through
 * a box: either of its own, or any other that holds neither end. Measured on
 * the curve itself, so the answer is the picture's and not a rule about which
 * sides were named.
 *
 * Only passing through counts. Also counting a curve that merely comes close,
 * or whose text touches a node, was tried (2026-09-27) and sent nearly every
 * such edge the long way round with square corners, which the user rejected
 * outright.
 */
function curveHits(edge: LayoutEdge, { start, end, bow }: EdgeEnds, nodes: LayoutNode[]): boolean {
  const reach = controlReach(start, end);
  const lift = 4 / 3;
  const bx = (bow?.x ?? 0) * lift;
  const by = (bow?.y ?? 0) * lift;
  const c1 = { x: start.x + start.tx * reach + bx, y: start.y + start.ty * reach + by };
  const c2 = { x: end.x + end.tx * reach + bx, y: end.y + end.ty * reach + by };
  const at = (t: number): Point => {
    const u = 1 - t;
    return {
      x: u * u * u * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
      y: u * u * u * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
    };
  };
  // The line starts and ends on its own boxes' sides, so those are shrunk a
  // pixel to let it touch them there.
  const boxes = [
    ...[edge.from, edge.to].map((node) => grow(extentOfBox(faceOf(node)), -1)),
    ...nodes
      .filter((node) => !contains(node, edge.from) && !contains(node, edge.to))
      .map((node) => extentOfBox(faceOf(node))),
  ];
  const steps = 32;
  let previous = start as Point;
  for (let step = 1; step <= steps; step += 1) {
    const point = at(step / steps);
    if (boxes.some((box) => segmentHits(previous, point, box))) return true;
    previous = point;
  }
  return false;
}

/**
 * The end of an edge whose side faces away from the other end, with its node
 * and the other end's anchor; the start if both do.
 */
function awayEnd(
  edge: LayoutEdge,
  start: Anchor,
  end: Anchor,
): { node: LayoutNode; anchor: Anchor; other: Anchor } | undefined {
  const facesAway = (from: Anchor, to: Anchor): boolean =>
    from.tx * (to.x - from.x) + from.ty * (to.y - from.y) < 0;
  if (facesAway(start, end)) return { node: edge.from, anchor: start, other: end };
  if (facesAway(end, start)) return { node: edge.to, anchor: end, other: start };
  return undefined;
}

/**
 * Whether a line coming straight in to `other`, across the way `anchor`'s side
 * faces, would pass through `box` — that is, `other` lies within the box's
 * span along that way.
 */
function within(box: Box, anchor: Anchor, other: Anchor): boolean {
  const run: Axis = anchor.tx !== 0 ? 'x' : 'y';
  return lo(box, run) < other[run] && other[run] < hi(box, run);
}

/** The clause that passes a node on the side named. */
function sidePass(side: AttachSide): 'above' | 'below' | 'left' | 'right' {
  return side === 'top' ? 'above' : side === 'bottom' ? 'below' : side;
}

/**
 * Route an edge as if it carried one clause the author did not write, passing
 * `node` on that side. If that cannot be drawn, the edge keeps its curve: a
 * refusal would name a clause that is not in the file, and would refuse a file
 * earlier versions drew.
 */
function implyRoute(
  edge: LayoutEdge,
  node: LayoutNode,
  direction: 'above' | 'below' | 'left' | 'right',
  nodes: LayoutNode[],
  ends: Map<LayoutEdge, EdgeEnds>,
  routes: Map<LayoutEdge, Route>,
  measurer: Measurer,
  fontSize: number,
): void {
  const written = `${direction === 'left' || direction === 'right' ? `${direction} of` : direction} ${node.name}`;
  try {
    routes.set(edge, planRoute(edge, [{ direction, nodes: [node], written }], nodes, ends.get(edge)!, measurer, fontSize));
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
  }
}

/** A line drawn as straight pieces with rounded corners, and where its text rides. */
interface Route {
  points: Point[];
  mid: Point;
}

/** The most a route's corner is rounded by. */
const ROUTE_RADIUS = 20;
/**
 * How far a route leaves its side before its first turn: a full corner, and the
 * arrowhead's length on top so the head lands on a straight piece of line.
 */
const ROUTE_STUB = ROUTE_RADIUS + ARROW_LENGTH;
/** The narrowest gap a route will cross over in, between two nodes it passes on opposite sides. */
const CROSSING_ROOM = ATTACH_MARGIN * 2;

/** Which way one section of a route travels, and the axis its levels are on. */
interface Axes {
  /** The axis a stretch's level is on: y for a section passing things above and below. */
  across: Axis;
  /** The axis the section travels along. */
  run: Axis;
  make: (along: number, level: number) => Point;
}

function axesAcross(across: Axis): Axes {
  return across === 'y'
    ? { across, run: 'x', make: (along, level) => ({ x: along, y: level }) }
    : { across, run: 'y', make: (along, level) => ({ x: level, y: along }) };
}

/** A clause as one section of a route reads it: where along the run it binds, and the level it bounds. */
interface RouteClause {
  pass: LayoutPass;
  from: number;
  to: number;
  bound: number;
  further: boolean;
}

/** A piece of a section's way, and the band of levels its clauses leave the line. */
interface RoutePiece {
  from: number;
  to: number;
  lo: number;
  hi: number;
  floor: RouteClause | undefined;
  ceiling: RouteClause | undefined;
}

/** Consecutive pieces sharing one level. `first` and `last` index the pieces. */
interface Stretch {
  lo: number;
  hi: number;
  first: number;
  last: number;
  from: number;
  to: number;
  level: number;
}

/** One way of travel along a route: across the page, or up or down it. */
interface Section {
  axes: Axes;
  pieces: RoutePiece[];
  stretches: Stretch[];
}

/**
 * Route every edge that says which side of something it passes.
 *
 * `below resolver` means that where the line passes Resolver it is below it —
 * not that the whole line is. So the line is a run of straight stretches along
 * the way it travels, and each clause binds only the stretch lying alongside
 * its nodes. A clause naming several nodes binds the stretch alongside all of
 * them, which is how `below a and b` says "with no rising in between" and two
 * separate clauses do not. Consecutive stretches that can share one level do;
 * where they cannot, the line crosses over in the gap between the two sets of
 * nodes, and if there is no gap, the file is refused rather than drawn through
 * a box. No clause says an order: the line meets the nodes in the order they
 * sit along its way.
 *
 * Above and below are passed travelling across the page, left and right
 * travelling up or down it, so an edge naming both kinds turns between such
 * runs, as few times as keeps every clause. Which comes first is the named
 * side's to say, and across when no end names one.
 *
 * Nothing here moves a node or looks for a path. Every level is read off where
 * the named nodes landed, as a `between` channel is, and the only other nodes
 * consulted are ones sitting on a stretch, which push it further the way its
 * clause already points.
 */
function planRoutes(
  edges: LayoutEdge[],
  nodes: LayoutNode[],
  ends: Map<LayoutEdge, EdgeEnds>,
  measurer: Measurer,
  fontSize: number,
): Map<LayoutEdge, Route> {
  const routes = new Map<LayoutEdge, Route>();
  for (const edge of edges) {
    if (edge.passes) routes.set(edge, planRoute(edge, edge.passes, nodes, ends.get(edge)!, measurer, fontSize));
  }
  return routes;
}

function planRoute(
  edge: LayoutEdge,
  passes: LayoutPass[],
  nodes: LayoutNode[],
  { start, end }: EdgeEnds,
  measurer: Measurer,
  fontSize: number,
): Route {
  const subject = `edge ${edge.from.name} -> ${edge.to.name}`;
  const a = faceOf(edge.from);
  const b = faceOf(edge.to);
  const named = (anchor: Anchor, face: Box): Point =>
    anchor.side === undefined ? centerOf(face) : anchor;
  // Far enough out that the line reads as passing. The one stretch carrying
  // the text is held further out, so that half the text, centered on the line,
  // still clears the box beside it.
  const clear = SEPARATION_GAP;
  const inWay = nodes.filter(
    (node) => !(contains(node, edge.from) && contains(node, edge.to)),
  );

  // Above and below are passed travelling across the page, left and right
  // travelling up or down it. An edge naming only one kind is one section.
  const acrossPasses = passes.filter((pass) => sideAxis(pass) === 'y');
  const downPasses = passes.filter((pass) => sideAxis(pass) === 'x');
  if (acrossPasses.length === 0 || downPasses.length === 0) {
    const axes = axesAcross(sideAxis(passes[0]!));
    const travel = Math.sign(named(end, b)[axes.run] - named(start, a)[axes.run]) || 1;
    const section = cut(axes, passes, reach(start, a, axes), reach(end, b, axes), travel);
    const carrier = longest(section.stretches);
    settle(section, (centerOf(a)[axes.across] + centerOf(b)[axes.across]) / 2, carrier);
    return finish(
      [
        ...approach(start, a, axes, section.stretches[0]!.level, travel),
        ...crossings(section),
        ...approach(end, b, axes, section.stretches[section.stretches.length - 1]!.level, -travel).reverse(),
      ],
      carrier,
      axes,
    );
  }

  // Both kinds: the line turns between travelling across the page and
  // travelling down it, as often as its clauses need. A side named at an end
  // says which it does first; with none named, it goes across first. The
  // fewest turns that keep every clause win, and at each count the other
  // order is tried before adding a turn. If every attempt fails the same way,
  // that is the error; if they fail differently, no one of them is the reason
  // and the error names every clause.
  const sideways = (anchor: Anchor): boolean | undefined =>
    anchor.side === undefined ? undefined : anchor.side === 'left' || anchor.side === 'right';
  const acrossFirst = sideways(start) ?? !(sideways(end) ?? false);
  const refusals: SourceError[] = [];
  for (const count of [2, 3, 4]) {
    for (const order of [acrossFirst, !acrossFirst]) {
      try {
        return turned(order, count);
      } catch (error) {
        if (!(error instanceof SourceError)) throw error;
        refusals.push(error);
      }
    }
  }
  if (refusals.every((refusal) => refusal.message === refusals[0]!.message)) throw refusals[0]!;
  const written = passes.map((pass) => `"${pass.written}"`);
  throw new SourceError(
    `${subject}: no line keeps ${written.slice(0, -1).join(', ')} and ${written[written.length - 1]} ` +
      'all at once, whichever way it turns — each way misses one of those nodes or runs into one. ' +
      'Give the nodes more room, or drop a clause',
    edge.line,
  );

  /**
   * A route in `count` sections, alternating across and down, joined at
   * corners. Each section is planned as an edge naming one kind is, running
   * from the level of the section before it to the level of the one after,
   * and each clause binds every section of its kind that passes its node.
   * The first and last keep as near their own ends as their clauses allow,
   * so with nothing in the way two sections make an L through the corner
   * level with both ends; a section between hugs its own clauses. Where the
   * corners land depends on every section, so they are planned in turn
   * until none moves.
   */
  function turned(acrossFirst: boolean, count: number): Route {
    const axes = Array.from({ length: count }, (_, index) =>
      axesAcross((index % 2 === 0) === acrossFirst ? 'y' : 'x'));
    const last = count - 1;
    const targets = axes.map(({ across }, index) =>
      index === 0
        ? centerOf(a)[across]
        : index === last
          ? centerOf(b)[across]
          : (centerOf(a)[across] + centerOf(b)[across]) / 2);
    // Each section's first and last level, which bound its neighbours' runs.
    const firstLevels = [...targets];
    const lastLevels = [...targets];
    const startAt = reach(start, a, axes[0]!);
    const endAt = reach(end, b, axes[last]!);
    // A section starts or ends at the middle of its end's own node, which
    // must not push it: the line leaves that node from the side facing it.
    const obstacles = inWay.filter((node) => !contains(node, edge.from) && !contains(node, edge.to));
    const near = new Set(passes.flatMap((pass) => pass.nodes));
    // Which stretch carries the text: its section and index, from the last round.
    let carries: [number, number] | undefined;
    let sections: Section[] = [];
    let travels: number[] = [];
    let bound = new Set<LayoutPass>();
    for (let round = 0; round < 8; round += 1) {
      let moved = false;
      sections = [];
      travels = [];
      bound = new Set();
      axes.forEach((section, index) => {
        const from = index === 0 ? startAt : lastLevels[index - 1]!;
        const to = index === last ? endAt : firstLevels[index + 1]!;
        const travel = Math.sign(
          (index === last ? named(end, b)[section.run] : to) -
            (index === 0 ? named(start, a)[section.run] : from),
        ) || 1;
        const low = Math.min(from, to);
        const high = Math.max(from, to);
        const mine = passes.filter((pass) => {
          const box = boundingBox(pass.nodes.map(faceOf));
          return sideAxis(pass) === section.across && hi(box, section.run) > low && lo(box, section.run) < high;
        });
        mine.forEach((pass) => bound.add(pass));
        const planned = cut(section, mine, from, to, travel);
        const carrier = carries?.[0] === index ? planned.stretches[carries[1]] : undefined;
        settle(planned, targets[index]!, carrier, obstacles, index > 0 && index < last, near);
        const first = planned.stretches[0]!.level;
        const final = planned.stretches[planned.stretches.length - 1]!.level;
        if (Math.abs(first - firstLevels[index]!) >= 0.5 || Math.abs(final - lastLevels[index]!) >= 0.5) {
          moved = true;
        }
        firstLevels[index] = first;
        lastLevels[index] = final;
        sections.push(planned);
        travels.push(travel);
      });
      let wanted: [number, number] | undefined;
      if (edge.lines !== undefined) {
        sections.forEach((section, index) => {
          const best = longest(section.stretches);
          if (!wanted || length(best) > length(sections[wanted[0]]!.stretches[wanted[1]]!)) {
            wanted = [index, section.stretches.indexOf(best)];
          }
        });
      }
      const settled = round > 0 && !moved && wanted?.[0] === carries?.[0] && wanted?.[1] === carries?.[1];
      carries = wanted;
      if (settled) break;
    }
    const unpassed = passes.find((pass) => !bound.has(pass));
    if (unpassed) {
      throw new SourceError(
        `${subject}: the line never passes ${quoteNames(unpassed.nodes)}, so "${unpassed.written}" says ` +
          'nothing about it',
        edge.line,
      );
    }
    const points = [...approach(start, a, axes[0]!, firstLevels[0]!, travels[0]!)];
    sections.forEach((section, index) => {
      points.push(...crossings(section));
      if (index < last) points.push(section.axes.make(firstLevels[index + 1]!, lastLevels[index]!));
    });
    points.push(...approach(end, b, axes[last]!, lastLevels[last]!, -travels[last]!).reverse());
    const broken = breaks(points);
    if (broken) {
      throw new SourceError(
        `${subject}: a line passing things both above or below and left or right has to turn, and ` +
          `no way it can turn keeps "${broken.written}" — drop that clause, or one of the others`,
        edge.line,
      );
    }
    const [which, index] = carries ?? [0, 0];
    const carrier = edge.lines === undefined ? undefined : sections[which]!.stretches[index];
    return finish(points, carrier, axes[which]!);
  }

  /** The first clause the drawn line breaks, wherever it lies alongside that clause's nodes. */
  function breaks(points: Point[]): LayoutPass | undefined {
    for (const pass of passes) {
      const box = boundingBox(pass.nodes.map(faceOf));
      const across = sideAxis(pass);
      const run: Axis = across === 'y' ? 'x' : 'y';
      const further = pass.direction === 'below' || pass.direction === 'right';
      for (let index = 0; index + 1 < points.length; index += 1) {
        const [p, q] = [points[index]!, points[index + 1]!];
        const alongside = Math.abs(p[run] - q[run]) < 0.5
          ? p[run] > lo(box, run) + 0.5 && p[run] < hi(box, run) - 0.5
          : Math.min(Math.max(p[run], q[run]), hi(box, run)) -
              Math.max(Math.min(p[run], q[run]), lo(box, run)) > 0.5;
        if (!alongside) continue;
        const kept = further
          ? Math.min(p[across], q[across]) >= hi(box, across) - 0.5
          : Math.max(p[across], q[across]) <= lo(box, across) + 0.5;
        if (!kept) return pass;
      }
    }
    return undefined;
  }

  /**
   * Where the line reaches along a run at one end, before it turns onto a
   * stretch. Enough to tell which nodes it passes.
   */
  function reach(anchor: Anchor, face: Box, { run }: Axes): number {
    const along = run === 'x' ? anchor.tx : anchor.ty;
    return anchor.side !== undefined && along !== 0
      ? anchor[run] + along * ROUTE_STUB
      : named(anchor, face)[run];
  }

  function length(stretch: Stretch): number {
    return Math.abs(stretch.to - stretch.from);
  }

  function longest(stretches: Stretch[]): Stretch {
    return stretches.reduce((best, stretch) => (length(stretch) > length(best) ? stretch : best));
  }

  /**
   * The way from `first` to `last` along a run, cut wherever a clause starts
   * or stops binding, with each piece given the band its clauses leave the
   * line, and consecutive pieces grouped into stretches that can share one
   * level. Levels are left for `settle`.
   */
  function cut(axes: Axes, passes: LayoutPass[], first: number, last: number, travel: number): Section {
    const { across, run } = axes;
    const low = Math.min(first, last);
    const high = Math.max(first, last);

    const clauses = passes.map((pass) => {
      const box = boundingBox(pass.nodes.map(faceOf));
      if (hi(box, run) <= low || lo(box, run) >= high) {
        throw new SourceError(
          `${subject}: the line never passes ${quoteNames(pass.nodes)}, so "${pass.written}" says nothing ` +
            'about it',
          edge.line,
        );
      }
      const further = pass.direction === 'below' || pass.direction === 'right';
      return {
        pass,
        from: lo(box, run),
        to: hi(box, run),
        bound: further ? hi(box, across) + clear : lo(box, across) - clear,
        further,
      };
    });

    // Cut the way into pieces at every place a clause starts or stops binding,
    // and give each piece the band its clauses leave the line.
    const cuts = [...new Set([low, high, ...clauses.flatMap((c) => [c.from, c.to])])]
      .filter((at) => at >= low && at <= high)
      .sort((p, q) => (p - q) * travel);
    const pieces = cuts.slice(0, -1).map((from, index) => {
      const to = cuts[index + 1]!;
      const middle = (from + to) / 2;
      const binding = clauses.filter((c) => c.from < middle && c.to > middle);
      const floor = binding.filter((c) => c.further).sort((p, q) => q.bound - p.bound)[0];
      const ceiling = binding.filter((c) => !c.further).sort((p, q) => p.bound - q.bound)[0];
      if (floor && ceiling && floor.bound > ceiling.bound) {
        const grouped = [floor, ceiling].some((c) => c.pass.nodes.length > 1);
        throw new SourceError(
          `${subject}: "${floor.pass.written}" and "${ceiling.pass.written}" cannot both hold — there ` +
            'is a stretch where the line is alongside both, and it cannot be ' +
            `${sideWord(floor.pass)} ${quoteNames(floor.pass.nodes)} and ${sideWord(ceiling.pass)} ` +
            `${quoteNames(ceiling.pass.nodes)} at the same point. Drop one` +
            (grouped
              ? ', or name the nodes in separate clauses so the line may cross over between them'
              : ''),
          edge.line,
        );
      }
      return {
        from,
        to,
        lo: floor?.bound ?? -Infinity,
        hi: ceiling?.bound ?? Infinity,
        floor,
        ceiling,
      };
    });

    // A way of no length, as the first section of a turned route can be when
    // the corner is level with its start, is one piece binding nothing.
    if (pieces.length === 0) {
      pieces.push({ from: low, to: high, lo: -Infinity, hi: Infinity, floor: undefined, ceiling: undefined });
    }

    // Consecutive pieces share one level for as long as their bands overlap.
    const stretches: Stretch[] = [];
    let current: Stretch = { lo: -Infinity, hi: Infinity, first: 0, last: 0, from: 0, to: 0, level: 0 };
    pieces.forEach((piece, index) => {
      const lower = Math.max(current.lo, piece.lo);
      const upper = Math.min(current.hi, piece.hi);
      if (lower <= upper) {
        Object.assign(current, { lo: lower, hi: upper, last: index });
      } else {
        stretches.push(current);
        current = { lo: piece.lo, hi: piece.hi, first: index, last: index, from: 0, to: 0, level: 0 };
      }
    });
    stretches.push(current);
    for (const stretch of stretches) {
      stretch.from = pieces[stretch.first]!.from;
      stretch.to = pieces[stretch.last]!.to;
    }
    return { axes, pieces, stretches };
  }

  /**
   * Each stretch sits as near `target` as its band allows, and a node lying
   * on it pushes it on the way its clause already points. `carrier` is the
   * stretch held clear for the text, if this section has it.
   */
  function settle(
    { axes: { across, run }, stretches }: Section,
    target: number,
    carrier: Stretch | undefined,
    obstacles: LayoutNode[] = inWay,
    hug = false,
    near: Set<LayoutNode> = new Set(),
  ): void {
    const textClear = Math.max(clear, laneExtent(edge, across, measurer, fontSize) / 2 + ATTACH_MARGIN);
    for (const stretch of stretches) {
      const room = stretch === carrier && edge.lines !== undefined ? textClear : clear;
      const extra = room - clear;
      const lower = stretch.lo + extra;
      const upper = stretch.hi - extra;
      // A stretch hugging its clauses sits as close as its one bound allows.
      const wanted = !hug
        ? target
        : stretch.hi === Infinity && stretch.lo !== -Infinity
          ? lower
          : stretch.lo === -Infinity && stretch.hi !== Infinity
            ? upper
            : target;
      stretch.level = lower <= upper
        ? Math.min(Math.max(wanted, lower), upper)
        : (stretch.lo + stretch.hi) / 2;
      const push = stretch.hi === Infinity ? 1 : stretch.lo === -Infinity ? -1 : 0;
      if (push === 0) continue;
      const from = Math.min(stretch.from, stretch.to);
      const to = Math.max(stretch.from, stretch.to);
      for (let moved = true; moved; ) {
        moved = false;
        for (const node of obstacles) {
          const face = faceOf(node);
          if (lo(face, run) >= to || hi(face, run) <= from) continue;
          // A node the edge names is one it is meant to go close by, so it
          // keeps the line only as far off as a crossing does.
          const off = near.has(node) && room === clear ? ATTACH_MARGIN : room;
          if (lo(face, across) >= stretch.level + off || hi(face, across) <= stretch.level - off) {
            continue;
          }
          stretch.level = push > 0 ? hi(face, across) + off : lo(face, across) - off;
          moved = true;
        }
      }
    }
  }

  /**
   * Between two stretches the line crosses over, in whatever run of pieces at
   * the end of the first leaves room for both levels.
   */
  function crossings({ axes: { make }, pieces, stretches }: Section): Point[] {
    const points: Point[] = [];
    for (let index = 0; index + 1 < stretches.length; index += 1) {
      const here = stretches[index]!;
      const next = stretches[index + 1]!;
      let open = here.last + 1;
      while (
        open > here.first &&
        pieces[open - 1]!.lo <= next.level &&
        pieces[open - 1]!.hi >= next.level
      ) {
        open -= 1;
      }
      const from = open <= here.last ? pieces[open]!.from : pieces[here.last]!.to;
      const to = pieces[here.last]!.to;
      if (Math.abs(to - from) < CROSSING_ROOM) {
        const behind = [...pieces.slice(here.first, here.last + 1)]
          .reverse()
          .map((piece) => piece.floor ?? piece.ceiling)
          .find((clause) => clause !== undefined)!;
        const entering = pieces[next.first]!;
        const ahead = (next.level > here.level ? entering.floor : entering.ceiling) ??
          entering.floor ?? entering.ceiling!;
        throw new SourceError(
          `${subject}: to pass "${behind.pass.written}" and "${ahead.pass.written}" the line has to ` +
            `cross over between ${quoteNames(behind.pass.nodes)} and ${quoteNames(ahead.pass.nodes)}, and there ` +
            'is no room between them — give the placement between them a gap, or drop one of the two',
          edge.line,
        );
      }
      const at = (from + to) / 2;
      points.push(make(at, here.level), make(at, next.level));
    }
    return points;
  }

  /**
   * The route drawn through `points`, with its text at the middle of the
   * piece that lies on the stretch held clear for it.
   */
  function finish(points: Point[], carrier: Stretch | undefined, { across, run }: Axes): Route {
    const drawn = tidyRoute(points);
    let mid = centerOf(boundingBox([a, b]));
    let best = -1;
    for (let index = 0; index + 1 < drawn.length; index += 1) {
      const [p, q] = [drawn[index]!, drawn[index + 1]!];
      if (!carrier) break;
      if (Math.abs(p[across] - carrier.level) > 0.5 || Math.abs(q[across] - carrier.level) > 0.5) {
        continue;
      }
      const length = Math.abs(q[run] - p[run]);
      if (length > best) {
        best = length;
        mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      }
    }
    return { points: drawn, mid };
  }

  /**
   * The points from one end of the line to the level of its nearest stretch.
   * `toward` is the way the line heads along its run from this end.
   */
  function approach(given: Anchor, face: Box, axes: Axes, level: number, toward: number): Point[] {
    const { across, run, make } = axes;
    const anchor = given.side !== undefined ? given : leaving(face, axes, level, toward);
    const along = run === 'x' ? anchor.tx : anchor.ty;
    const out = across === 'x' ? anchor.tx : anchor.ty;
    if (along !== 0) {
      // Out along the run, one way or the other, then across to the level.
      const turn = make(anchor[run] + along * ROUTE_STUB, anchor[across]);
      return [anchor, turn, make(turn[run], level)];
    }
    if ((level - anchor[across]) * out >= 0) return [anchor, make(anchor[run], level)];
    // The side faces away from the level, so the line steps round the back of
    // its own node — the end the run is heading away from — to get there.
    const stub = make(anchor[run], anchor[across] + out * ROUTE_STUB);
    const back = toward > 0 ? lo(face, run) - ROUTE_STUB : hi(face, run) + ROUTE_STUB;
    return [anchor, stub, make(back, stub[across]), make(back, level)];
  }

  /**
   * An end naming no side leaves from the one facing the level it is going
   * to, or, when the level is alongside the node, the one facing its way.
   */
  function leaving(face: Box, { across, run }: Axes, level: number, toward: number): Anchor {
    const center = centerOf(face);
    const side: AttachSide =
      level > hi(face, across)
        ? across === 'y' ? 'bottom' : 'right'
        : level < lo(face, across)
          ? across === 'y' ? 'top' : 'left'
          : run === 'x'
            ? toward > 0 ? 'right' : 'left'
            : toward > 0 ? 'bottom' : 'top';
    return anchorOn(face, side, side === 'top' || side === 'bottom' ? center.x : center.y);
  }
}

/** Which axis a clause's side sits on: above and below are a matter of y. */
function sideAxis(pass: LayoutPass): Axis {
  return pass.direction === 'above' || pass.direction === 'below' ? 'y' : 'x';
}

/** "below", "left of" — the side as the author would say it. */
function sideWord(pass: LayoutPass): string {
  return pass.direction === 'above' || pass.direction === 'below'
    ? pass.direction
    : `${pass.direction} of`;
}

/** The box that just bounds several. */
function boundingBox(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - y,
  };
}

/** `"a"`, `"a" and "b"` — for error messages. */
function quoteNames(nodes: LayoutNode[]): string {
  const quoted = nodes.map((node) => `"${node.name}"`);
  return quoted.length <= 1
    ? (quoted[0] ?? '')
    : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/** Drop repeated points and ones partway along a straight piece, which are not corners. */
function tidyRoute(points: Point[]): Point[] {
  const kept: Point[] = [];
  for (const point of points) {
    const previous = kept[kept.length - 1];
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.5) continue;
    const before = kept[kept.length - 2];
    if (
      before && previous &&
      Math.abs((previous.x - before.x) * (point.y - previous.y) - (previous.y - before.y) * (point.x - previous.x)) < 1e-6 &&
      (previous.x - before.x) * (point.x - previous.x) + (previous.y - before.y) * (point.y - previous.y) >= 0
    ) {
      kept[kept.length - 1] = point;
      continue;
    }
    kept.push(point);
  }
  return kept;
}

/**
 * A line through `points` with every corner rounded. A corner takes at most
 * half of each piece it shares with a neighboring corner, and the whole of a
 * piece at either end short of the arrowhead, so two corners never overlap and
 * the head always lands on a straight piece.
 */
function roundedPath(points: Point[], arrow: number = ARROW_LENGTH): string {
  const parts = [`M ${round(points[0]!.x)} ${round(points[0]!.y)}`];
  const kappa = 0.5523; // a cubic's handle, as a share of the radius, for a quarter circle
  for (let index = 1; index + 1 < points.length; index += 1) {
    const [before, corner, after] = [points[index - 1]!, points[index]!, points[index + 1]!];
    const inward = Math.hypot(corner.x - before.x, corner.y - before.y);
    const outward = Math.hypot(after.x - corner.x, after.y - corner.y);
    const radius = Math.max(
      0,
      Math.min(
        ROUTE_RADIUS,
        index === 1 ? inward - arrow : inward / 2,
        index + 2 === points.length ? outward - arrow : outward / 2,
      ),
    );
    const din = { x: (corner.x - before.x) / inward, y: (corner.y - before.y) / inward };
    const dout = { x: (after.x - corner.x) / outward, y: (after.y - corner.y) / outward };
    const enter = { x: corner.x - din.x * radius, y: corner.y - din.y * radius };
    const leave = { x: corner.x + dout.x * radius, y: corner.y + dout.y * radius };
    parts.push(
      `L ${round(enter.x)} ${round(enter.y)}`,
      `C ${round(enter.x + din.x * radius * kappa)} ${round(enter.y + din.y * radius * kappa)}, ` +
        `${round(leave.x - dout.x * radius * kappa)} ${round(leave.y - dout.y * radius * kappa)}, ` +
        `${round(leave.x)} ${round(leave.y)}`,
    );
  }
  const last = points[points.length - 1]!;
  parts.push(`L ${round(last.x)} ${round(last.y)}`);
  return parts.join(' ');
}

function lo(box: Box, axis: Axis): number {
  return axis === 'x' ? box.x : box.y;
}

function hi(box: Box, axis: Axis): number {
  return axis === 'x' ? box.x + box.width : box.y + box.height;
}

/** Whether `inner` is `outer` or sits somewhere inside it. */
function contains(outer: LayoutNode, inner: LayoutNode): boolean {
  for (let node: LayoutNode | undefined = inner; node; node = node.parent) {
    if (node === outer) return true;
  }
  return false;
}

/**
 * An end whose side the author did not name aims at the far box's center, which
 * is the wrong thing to aim at once the line has been told to go somewhere else
 * on the way. Point those ends at the corridor instead.
 */
function aimFreeEnds(
  edges: LayoutEdge[],
  ends: Map<LayoutEdge, EdgeEnds>,
  corridors: Map<LayoutEdge, Corridor>,
): void {
  for (const edge of edges) {
    const plan = corridors.get(edge);
    if (!plan) continue;
    const current = ends.get(edge)!;
    const start =
      current.start.side === undefined
        ? free(faceOf(edge.from), corridorPoint(plan, plan.enter))
        : current.start;
    const end =
      current.end.side === undefined
        ? free(faceOf(edge.to), corridorPoint(plan, plan.leave))
        : current.end;
    ends.set(edge, { start, end });
  }
}

/**
 * How much room an edge's text takes across the corridor — its depth in a
 * horizontal channel, its width in a vertical one. Zero for an edge with no text,
 * which needs no more than the arrow spacing.
 *
 * `textExtent` measures the knockout along whichever axis it is handed, and the
 * axis wanted here is the one the channel is measured on rather than the one the
 * edge runs along — a channel measured vertically carries edges running
 * horizontally, and what has to fit between two lanes of it is a text's depth.
 */
function laneExtent(
  edge: LayoutEdge,
  axis: Axis,
  measurer: Measurer,
  fontSize: number,
): number {
  if (edge.lines === undefined) return 0;
  return textExtent(edge.lines, edge.textAttrs, axis, measurer, fontSize, edge.line);
}

function corridorPoint(plan: Corridor, at: number): Point {
  return plan.axis === 'y' ? { x: at, y: plan.lane } : { x: plan.lane, y: at };
}

/**
 * The path a corridor edge takes: a curve out of its start into the gap, the
 * straight run along the gap, and a curve out of the gap to its end. It is
 * three pieces rather than one cubic because a single curve has no way to stay
 * inside an interval over part of its length — which is the whole claim the
 * author is making.
 */
function corridorPath(
  start: Anchor,
  end: Anchor,
  plan: Corridor,
): { d: string; mid: Point; ink: Extent } {
  const p1 = corridorPoint(plan, plan.enter);
  const p2 = corridorPoint(plan, plan.leave);
  const forward = plan.leave >= plan.enter ? 1 : -1;
  // Along the run the line travels one way, so that is its tangent at both ends
  // of the straight stretch — it enters the gap already going where the gap goes.
  const rt = plan.axis === 'y' ? { tx: forward, ty: 0 } : { tx: 0, ty: forward };

  const reach = plan.loop ? loopReach : corridorReach;
  const r1 = reach(start, p1, plan.axis);
  const c1 = { x: start.x + start.tx * r1, y: start.y + start.ty * r1 };
  const c2 = { x: p1.x - rt.tx * r1, y: p1.y - rt.ty * r1 };

  const r2 = reach(p2, end, plan.axis);
  const c3 = { x: p2.x + rt.tx * r2, y: p2.y + rt.ty * r2 };
  const c4 = { x: end.x + end.tx * r2, y: end.y + end.ty * r2 };

  const d = [
    `M ${round(start.x)} ${round(start.y)}`,
    `C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(p1.x)} ${round(p1.y)}`,
    `L ${round(p2.x)} ${round(p2.y)}`,
    `C ${round(c3.x)} ${round(c3.y)}, ${round(c4.x)} ${round(c4.y)}, ${round(end.x)} ${round(end.y)}`,
  ].join(' ');

  const ink = union(
    cubicExtent(start, c1, c2, p1),
    cubicExtent(p2, c3, c4, end),
  );

  return { d, mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, ink };
}

/**
 * How far the handles reach on an approach curve. Bounded by half the distance
 * available along the run as well as by the straight-line distance: both ends of
 * this curve point along the run, so handles longer than that would reach past
 * each other and bulge the line back the way it came.
 */
function corridorReach(from: Point, to: Point, axis: Axis): number {
  const run = Math.abs(axis === 'y' ? to.x - from.x : to.y - from.y);
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.min(140, Math.max(8, Math.min(distance * 0.4, run / 2)));
}

/**
 * How far the handles reach on the turn at either end of a loop. The turn
 * leaves heading one way and joins the run heading the other, over the depth
 * between the side and the run, so it is a half circle on that depth — and a
 * cubic comes closest to a half circle with handles two thirds of its diameter.
 */
function loopReach(from: Point, to: Point, axis: Axis): number {
  return (Math.abs(axis === 'y' ? to.y - from.y : to.x - from.x) * 2) / 3;
}

function sideAttr(edge: LayoutEdge, key: 'from' | 'to'): AttachSide | undefined {
  const value = edge.attrs[key];
  if (value === undefined) return impliedSide(edge, key);
  if (!(ATTACH_SIDES as readonly string[]).includes(value)) {
    throw new SourceError(
      `"${key}: ${value}" is not a side — use ${ATTACH_SIDES.join(', ')}`,
      edge.line,
    );
  }
  return value as AttachSide;
}

/**
 * The side a square line leaves or arrives on when its author named none.
 *
 * A curved or straight line with no sides aims straight at the other box, but a
 * square one can only leave a side head-on, so it has to pick one. Boxes that
 * share a column join top to bottom and boxes that share a row join side to
 * side; otherwise the line goes across first and then down, the tie the mixed
 * passes settled. An end whose partner did name a side keeps the line to one
 * turn where it can. Everything after this treats the side as though it had
 * been written, so the ends are spread and bundled like any named side.
 *
 * An edge through a `between` gap or past a named node is routed by its clauses,
 * and one from a node to itself or to its own container has no outside to pick
 * from, so none of those is given a side here.
 */
function impliedSide(edge: LayoutEdge, key: 'from' | 'to'): AttachSide | undefined {
  if (edge.look.path !== 'square' || edge.between || edge.passes) return undefined;
  if (contains(edge.from, edge.to) || contains(edge.to, edge.from)) return undefined;
  const own = faceOf(key === 'from' ? edge.from : edge.to);
  const other = faceOf(key === 'from' ? edge.to : edge.from);
  const partnerKey = key === 'from' ? 'to' : 'from';
  const partner = edge.attrs[partnerKey] as AttachSide | undefined;
  const overlapX = own.x < other.x + other.width && other.x < own.x + own.width;
  const overlapY = own.y < other.y + other.height && other.y < own.y + own.height;
  const across: AttachSide = centerOf(other).x >= centerOf(own).x ? 'right' : 'left';
  const upDown: AttachSide = centerOf(other).y >= centerOf(own).y ? 'bottom' : 'top';
  if (partner !== undefined && (ATTACH_SIDES as readonly string[]).includes(partner)) {
    // The partner's side is fixed, so take whichever side of this box joins it
    // in the fewest turns. The order breaks ties the way the rest of this does.
    const theirs = anchorOn(other, partner, partner === 'top' || partner === 'bottom' ? centerOf(other).x : centerOf(other).y);
    const order: AttachSide[] = overlapX && !overlapY ? [upDown, across] : [across, upDown];
    const sides = [...order, ...ATTACH_SIDES.filter((side) => !order.includes(side))];
    let best = sides[0]!;
    let fewest = Infinity;
    for (const side of sides) {
      const mine = anchorOn(own, side, side === 'top' || side === 'bottom' ? centerOf(own).x : centerOf(own).y);
      const [from, to] = key === 'from' ? [mine, theirs] : [theirs, mine];
      const turns = tidyRoute(
        rightAngles(from, { x: from.tx, y: from.ty }, to, { x: to.tx, y: to.ty }, ROUTE_STUB),
      ).length;
      if (turns < fewest) {
        fewest = turns;
        best = side;
      }
    }
    return best;
  }
  if (overlapX && !overlapY) return upDown;
  if (overlapY && !overlapX) return across;
  // Across first, then down: the start leaves across and the end is reached down.
  return key === 'from' ? across : upDown;
}

function arrowMarker(color: string): string {
  const id = markerId(color);
  return [
    `    <marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="${ARROW_MARKER_WIDTH}" markerHeight="${ARROW_MARKER_WIDTH}" orient="auto-start-reverse">`,
    `      <path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/>`,
    '    </marker>',
    `    <marker id="${id}-back" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="${ARROW_MARKER_WIDTH}" markerHeight="${ARROW_MARKER_WIDTH}" orient="auto-start-reverse">`,
    `      <path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/>`,
    '    </marker>',
  ].join('\n');
}

function markerId(color: string): string {
  return `arrow-${color.replace(/[^a-zA-Z0-9]/g, '')}`;
}

// --- small shared pieces ------------------------------------------------------

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The circle in this square is what is drawn, so a line meets that instead. */
  round?: boolean;
}

/** The rectangle actually drawn. Differs from the node box only for a deck. */
function faceOf(node: LayoutNode): Box {
  return {
    x: node.x + node.inset,
    y: node.y + node.inset,
    width: node.width - node.inset,
    height: node.height - node.inset,
    round: node.body.kind === 'shape' && node.body.outline === 'circle',
  };
}

function centerOf(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Wrap a block of text in its own size, but only when that differs from the
 * document's — everything at the default size inherits it from the <svg>
 * element, so an ordinary diagram's output is unchanged.
 */
function sized(block: string, size: number, fontSize: number): string {
  if (size === fontSize || block.length === 0) return block;
  return `  <g font-size="${size}px">\n${block}\n  </g>`;
}

/**
 * Draw a block of text into the room it was given.
 *
 * Two independent questions, which is why there are two words for them. `side`
 * is where the block sits across that room, from the horizontal half of the
 * text's `at`. `align` is how the block's own lines range against each other,
 * which matters whenever they are of unequal length and is a different thing
 * from where the block is.
 *
 * Where the block is as wide as the room — which is every text whose box is
 * sized from it, so nearly all of them — the two coincide and `side` changes
 * nothing.
 */
function textBlock(
  lines: Line[],
  x: number,
  y: number,
  lineHeight: number,
  fontSize: number,
  box: { x: number; y: number; width: number; height: number },
  style: {
    color: string;
    align: 'start' | 'middle' | 'end';
    ink: (run: Run, own: string) => string;
  },
): string {
  // `box` is the ink the text occupies, worked out by the resolver — the one
  // place that decides where a text sits, because `hub text` is a placement
  // target and the answer has to be a number before anything is solved.
  const blockLeft = x + box.x;
  const top = y + box.y;
  const anchorX =
    style.align === 'middle'
      ? blockLeft + box.width / 2
      : style.align === 'end'
        ? blockLeft + box.width
        : blockLeft;
  return lines
    .map((line, index) => {
      if (plain(line).length === 0) return '';
      const baseline = top + index * lineHeight + lineHeight / 2 + fontSize * 0.35;
      // One `<text>` per line, with a `<tspan>` per run inside it, so the runs
      // flow from the line's own anchor and a mark never moves a character.
      // A line drawn in one color says so on the `<text>` and emits no spans at
      // all, which is what keeps a whole quiet line identical to what the
      // `subtext:` it replaced produced.
      const colors = line.map((run) => style.ink(run, style.color));
      const uniform = colors.every((color) => color === colors[0]);
      const body = uniform
        ? escapeXml(plain(line))
        : line
            .map((run, run_index) =>
              colors[run_index] === style.color
                ? escapeXml(run.text)
                : `<tspan fill="${colors[run_index]}">${escapeXml(run.text)}</tspan>`,
            )
            .join('');
      return `  <text x="${round(anchorX)}" y="${round(baseline)}" fill="${uniform ? colors[0] ?? style.color : style.color}" text-anchor="${style.align}">${body}</text>`;
    })
    .filter((element) => element.length > 0)
    .join('\n');
}

/**
 * The color a marked-up run is drawn in. The mark names a *style*, never a
 * color, so the word borrows a meaning the file already has rather than
 * restating a value that goes stale the day the thing it means is recolored.
 * The resolver has already refused a mark naming a style that does not exist or
 * that says nothing about text.
 */
function runInk(
  run: Run,
  own: string,
  markup: Record<string, string>,
  theme: Theme,
): string {
  if (run.style === undefined) return own;
  return namedColor(markup[run.style]!, theme);
}

/**
 * A text's own color. `muted` is the one reserved word: it defers to the theme,
 * so a quiet line stays readable when the theme changes. Anything else is a
 * color, the same as `fill:` and `border:` take.
 */
function textColorOf(textAttrs: Attrs, theme: Theme, fallback: string): string {
  const value = textAttrs['color'];
  return value === undefined ? fallback : namedColor(value, theme);
}

function namedColor(value: string, theme: Theme): string {
  return value === 'muted' ? theme.mutedText : value;
}

/**
 * A color is written as the viewer will receive it — `#14532d`, or any CSS
 * color. The renderer keeps no list of color words of its own, so a diagram
 * is never limited to the ones somebody remembered to add here.
 *
 * Each names the part it colors, so each reads exactly one key. The word these
 * replaced, `stroke:`, named no part and meant a different one on every kind,
 * which is why a box's text could not be colored at all until `text:`.
 */
function borderOf(appearance: Record<string, string>, fallback: string): string {
  return appearance['border'] ?? fallback;
}

function lineOf(appearance: Record<string, string>, fallback: string): string {
  return appearance['line'] ?? fallback;
}

function fillOf(appearance: Record<string, string>, fallback: string): string {
  return appearance['fill'] ?? fallback;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Escapes what has to be escaped in element content, and no more. A double
 * quote is legal there, and some SVG renderers mishandle `&quot;` in text.
 */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function quote(value: string): string {
  return `"${value.replace(/"/g, "'")}"`;
}
