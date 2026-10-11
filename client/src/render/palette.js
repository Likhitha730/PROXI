// ProxiSpeak visual language.
//
// One cohesive palette for the whole office: warm neutral floors, slate walls and
// indigo/teal accents. Everything the renderer draws pulls from here, which is
// what keeps the scene looking like a single designed space instead of a pile of
// unrelated rectangles.

export const PALETTE = Object.freeze({
  // outside the building (letterbox)
  backdrop: '#0a0e15',
  backdropTile: 'rgba(91, 140, 255, 0.045)',
  vignette: 'rgba(4, 7, 12, 0.55)',

  floors: Object.freeze({
    oak: { base: '#c8a578', alt: '#bd9a6c', seam: 'rgba(120, 86, 50, 0.30)', pattern: 'planks', grain: 'rgba(255, 240, 210, 0.10)' },
    'carpet-grey': { base: '#c3cbd8', alt: '#bcc5d3', seam: 'rgba(126, 138, 158, 0.26)', pattern: 'carpet', cell: 96 },
    'carpet-teal': { base: '#5f7f82', alt: '#587a7d', seam: 'rgba(28, 48, 52, 0.24)', pattern: 'carpet', cell: 96 },
    'carpet-mauve': { base: '#7f7488', alt: '#786d82', seam: 'rgba(44, 36, 54, 0.24)', pattern: 'carpet', cell: 96 },
    'carpet-clay': { base: '#b5907a', alt: '#ad8873', seam: 'rgba(96, 62, 44, 0.22)', pattern: 'carpet', cell: 96 },
    'tile-light': { base: '#e3e7ec', alt: '#dce1e7', seam: 'rgba(150, 162, 176, 0.42)', pattern: 'tiles', cell: 64 },
    'tile-cool': { base: '#d9e2e8', alt: '#d2dce4', seam: 'rgba(138, 158, 172, 0.42)', pattern: 'tiles', cell: 64 },
    concrete: { base: '#c2c5ca', alt: '#bcbfc4', seam: 'rgba(128, 132, 138, 0.30)', pattern: 'tiles', cell: 128 },
  }),

  walls: Object.freeze({
    face: '#46536a',
    top: '#5e6d86',
    edge: '#333d4e',
    trim: '#39455a',
    shadow: 'rgba(9, 13, 20, 0.30)',
    highlight: 'rgba(180, 200, 235, 0.12)',
  }),

  doors: Object.freeze({
    frame: '#6d7c92',
    leaf: '#96714c',
    leafEdge: '#7a5a3c',
    glass: 'rgba(150, 205, 232, 0.22)',
    glassEdge: 'rgba(200, 232, 248, 0.45)',
    handle: '#dce3ec',
    threshold: 'rgba(40, 50, 66, 0.18)',
  }),

  wood: Object.freeze({
    top: '#d6a877',
    topDark: '#c1935f',
    mid: '#a97646',
    dark: '#7c5232',
    deepest: '#5d3c25',
    grain: 'rgba(92, 60, 34, 0.18)',
  }),

  metal: Object.freeze({
    base: '#8d97a7',
    light: '#c3cbd7',
    dark: '#5c6575',
    deepest: '#3f4757',
  }),

  fabric: Object.freeze({
    slate: '#69748a',
    slateDark: '#586176',
    grey: '#8f98a8',
    indigo: '#4e5f92',
    indigoDark: '#3f4d79',
    clay: '#a97258',
    teal: '#3e7d79',
    cream: '#d9d2c4',
  }),

  glass: Object.freeze({
    fill: 'rgba(150, 200, 235, 0.16)',
    edge: 'rgba(198, 226, 245, 0.42)',
  }),

  screen: Object.freeze({
    frame: '#2b3446',
    off: '#1b2231',
    glow: '#7fb2ff',
    glowSoft: 'rgba(127, 178, 255, 0.35)',
    content: 'rgba(208, 228, 255, 0.55)',
  }),

  plant: Object.freeze({
    leafDark: '#2c6b45',
    leaf: '#3d8c57',
    leafLight: '#58ab6e',
    leafCalm: '#4f9b76',
    pot: '#9c5a3c',
    potLight: '#b56b46',
    soil: '#4b3a2c',
  }),

  porcelain: Object.freeze({
    base: '#eef3f6',
    shade: '#d7e0e6',
    dark: '#c2ccd4',
  }),

  accents: Object.freeze({
    indigo: '#4f6bd8',
    indigoSoft: 'rgba(79, 107, 216, 0.16)',
    teal: '#2f9e8f',
    amber: '#e0a33e',
    coral: '#dd6b5f',
    green: '#3f9e63',
  }),

  labels: Object.freeze({
    zone: 'rgba(236, 243, 255, 0.5)',
    zoneLetter: 'rgba(236, 243, 255, 0.34)',
    bubble: 'rgba(12, 17, 26, 0.82)',
    // Warm bubble for the avatar you have selected, matching its amber ring.
    bubbleSelected: 'rgba(38, 28, 12, 0.88)',
    bubbleBorder: 'rgba(120, 150, 200, 0.35)',
    bubbleText: '#eaf1ff',
    localBadge: '#4f6bd8',
  }),

  shadow: 'rgba(9, 13, 20, 0.20)',
  shadowSoft: 'rgba(9, 13, 20, 0.13)',
  light: 'rgba(255, 244, 214, 0.10)',
})

// ------------------------------------------------------------- helpers ------

function parseHex(hex) {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  }
}

const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')

/**
 * Lighten (amount > 0) or darken (amount < 0) a hex colour.
 * Used for the subtle top/side faces that give furniture its 2.5D depth.
 */
export function shade(hex, amount) {
  const { r, g, b } = parseHex(hex)
  const mix = (channel) => (amount >= 0 ? channel + (255 - channel) * amount : channel * (1 + amount))
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`
}

/** Hex → rgba() string with the given alpha. */
export function withAlpha(hex, alpha) {
  if (hex.startsWith('rgba')) return hex
  const { r, g, b } = parseHex(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Mix two hex colours (0 → a, 1 → b). */
export function mix(a, b, t) {
  const ca = parseHex(a)
  const cb = parseHex(b)
  return `#${toHex(ca.r + (cb.r - ca.r) * t)}${toHex(ca.g + (cb.g - ca.g) * t)}${toHex(ca.b + (cb.b - ca.b) * t)}`
}

export function floorPalette(material) {
  return PALETTE.floors[material] ?? PALETTE.floors['carpet-grey']
}
