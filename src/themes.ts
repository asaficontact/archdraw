/**
 * The named themes a file chooses with `diagram theme: <name>`, and the one it
 * gets when it says nothing.
 *
 * A theme supplies every color the file does not state. It never supplies a
 * size or a distance, so switching themes cannot move anything — geometry may
 * not depend on appearance.
 *
 * Most of the palettes are borrowed from editor color schemes, all of them MIT
 * licensed and credited in NOTICE. Those palettes were made for code, where a
 * color marks a keyword or a string; a diagram needs a page, two box fills, a
 * border, text and a line. So each is the scheme read as a diagram rather than
 * a transfer of it: the page is the scheme's background, a leaf is its raised
 * surface, a container sits between the two, and the lines take one of its
 * accents.
 */
export interface Theme {
  background: string;
  boxFill: string;
  boxStroke: string;
  containerFill: string;
  /** A container is a region rather than a thing, so its outline is quieter. */
  containerStroke: string;
  text: string;
  mutedText: string;
  edge: string;
  /** An icon's drawn line. */
  iconInk: string;
  /** The body an icon's lines enclose. */
  iconShade: string;
}

/**
 * Sampled out of `examples/reference/arch.png` rather than invented,
 * so the benchmark render and the drawing it is measured against differ by
 * geometry and typography alone. A container is a shade off the page and barely
 * outlined; a leaf is the navy that carries the diagram's weight.
 */
export const DARK_THEME: Theme = {
  background: '#111111',
  boxFill: '#191728',
  boxStroke: '#4f5367',
  containerFill: '#191920',
  containerStroke: '#25242f',
  text: '#d9d9d9',
  mutedText: '#8b8b8b',
  edge: '#5c5c7c',
  // Both sampled off the reference's machine glyphs. Note that the reference
  // gives each icon its own hue — the drive is gray, the laptop periwinkle, the
  // workstation violet — which is a drawing tool's per-shape default and not a
  // system. One pair for the whole set is the deliberate difference: an icon
  // should read as part of the diagram's palette, not as clip art dropped in.
  iconInk: '#8d8d8e',
  iconShade: '#3e3d58',
};

/** The dark theme's counterpart: the same roles, on a white page. */
const LIGHT_THEME: Theme = {
  background: '#ffffff',
  boxFill: '#eef0f7',
  boxStroke: '#8a90a8',
  containerFill: '#f6f7fa',
  containerStroke: '#dcdfe7',
  text: '#1f2328',
  mutedText: '#6e7781',
  edge: '#7c83a0',
  iconInk: '#57606a',
  iconShade: '#d6d9e6',
};

/**
 * Every theme a file may name, in the order they are offered. Pairs sit
 * together, dark first, and the two that have no light half follow them.
 */
export const THEMES: Readonly<Record<string, Theme>> = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
  // Solarized, Ethan Schoonover. base03 page, base02 leaves, blue lines.
  'solarized-dark': {
    background: '#002b36',
    boxFill: '#073642',
    boxStroke: '#586e75',
    containerFill: '#03313c',
    containerStroke: '#0b3f4c',
    text: '#93a1a1',
    mutedText: '#657b83',
    edge: '#268bd2',
    iconInk: '#839496',
    iconShade: '#0f4a58',
  },
  // base3 page, base2 leaves, the same blue.
  'solarized-light': {
    background: '#fdf6e3',
    boxFill: '#eee8d5',
    boxStroke: '#93a1a1',
    containerFill: '#f6efdc',
    containerStroke: '#e3dcc7',
    text: '#586e75',
    mutedText: '#93a1a1',
    edge: '#268bd2',
    iconInk: '#657b83',
    iconShade: '#e0d9c3',
  },
  // Gruvbox, Pavel Pertsev. bg0 page, bg1 leaves, the warm yellow for lines.
  'gruvbox-dark': {
    background: '#282828',
    boxFill: '#3c3836',
    boxStroke: '#665c54',
    containerFill: '#32302f',
    containerStroke: '#3c3836',
    text: '#ebdbb2',
    mutedText: '#a89984',
    edge: '#d79921',
    iconInk: '#a89984',
    iconShade: '#504945',
  },
  'gruvbox-light': {
    background: '#fbf1c7',
    boxFill: '#ebdbb2',
    boxStroke: '#bdae93',
    containerFill: '#f2e5bc',
    containerStroke: '#e5d4a7',
    text: '#3c3836',
    mutedText: '#7c6f64',
    edge: '#b57614',
    iconInk: '#7c6f64',
    iconShade: '#d5c4a1',
  },
  // Catppuccin. Mocha's base page and surface leaves, blue lines.
  'catppuccin-mocha': {
    background: '#1e1e2e',
    boxFill: '#313244',
    boxStroke: '#6c7086',
    containerFill: '#25253a',
    containerStroke: '#313244',
    text: '#cdd6f4',
    mutedText: '#9399b2',
    edge: '#89b4fa',
    iconInk: '#a6adc8',
    iconShade: '#45475a',
  },
  // Latte's base page and crust leaves, lavender lines.
  'catppuccin-latte': {
    background: '#eff1f5',
    boxFill: '#dce0e8',
    boxStroke: '#9ca0b0',
    containerFill: '#e6e9ef',
    containerStroke: '#ccd0da',
    text: '#4c4f69',
    mutedText: '#7c7f93',
    edge: '#7287fd',
    iconInk: '#6c6f85',
    iconShade: '#ccd0da',
  },
  // Nord, Sven Greb. Polar Night page and leaves, Frost lines.
  nord: {
    background: '#2e3440',
    boxFill: '#3b4252',
    boxStroke: '#4c566a',
    containerFill: '#333a47',
    containerStroke: '#3b4252',
    text: '#d8dee9',
    mutedText: '#7b88a1',
    edge: '#81a1c1',
    iconInk: '#aeb7c6',
    iconShade: '#434c5e',
  },
  // Dracula, the free palette. Current-line leaves, comment borders, purple lines.
  dracula: {
    background: '#282a36',
    boxFill: '#44475a',
    boxStroke: '#6272a4',
    containerFill: '#21222c',
    containerStroke: '#343746',
    text: '#f8f8f2',
    mutedText: '#6272a4',
    edge: '#bd93f9',
    iconInk: '#b6b9cc',
    iconShade: '#565a70',
  },
  // For low vision and projectors: no fills to lean on, every line at full
  // strength, and a container told apart by a gray outline alone.
  'high-contrast-dark': {
    background: '#000000',
    boxFill: '#000000',
    boxStroke: '#ffffff',
    containerFill: '#000000',
    containerStroke: '#9a9a9a',
    text: '#ffffff',
    mutedText: '#c8c8c8',
    edge: '#ffffff',
    iconInk: '#ffffff',
    iconShade: '#3a3a3a',
  },
  'high-contrast-light': {
    background: '#ffffff',
    boxFill: '#ffffff',
    boxStroke: '#000000',
    containerFill: '#ffffff',
    containerStroke: '#6a6a6a',
    text: '#000000',
    mutedText: '#3d3d3d',
    edge: '#000000',
    iconInk: '#000000',
    iconShade: '#d0d0d0',
  },
  // For paper: no fill anywhere an ink cartridge would notice, black lines,
  // gray only where the dark theme is quiet.
  print: {
    background: '#ffffff',
    boxFill: '#ffffff',
    boxStroke: '#000000',
    containerFill: '#ffffff',
    containerStroke: '#8c8c8c',
    text: '#000000',
    mutedText: '#666666',
    edge: '#333333',
    iconInk: '#000000',
    iconShade: '#ffffff',
  },
};

/** The theme a file gets when it names none. */
export const DEFAULT_THEME = 'dark';

export const THEME_NAMES: readonly string[] = Object.keys(THEMES);
