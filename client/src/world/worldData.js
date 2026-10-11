// ProxiSpeak office — declarative world geometry.
//
// PURE DATA: this module never touches the DOM, the canvas or the network. The
// renderer and the collision system both read from here, which keeps layout
// decisions in one reviewable place.
//
// Coordinate system
//   - logical world: 2560 x 1600 units, origin top-left, x → right, y → down
//   - 1 unit = 1 CSS pixel at zoom 1
//   - every room rect below describes the *interior* (floor) area
//   - walls are centre-line segments; a segment of thickness t covers x ± t/2
//
// Layout (matches the product requirements):
//   left column   : office A, office B, storage & copy, restroom
//   right column  : office C, kitchen, huddle room, restroom
//   centre        : meeting room + lounge (top), open workspace, reception & entrance
//
// A layout unit test asserts that every furniture item stays clear of the wall
// lines, which is what prevents furniture from being clipped by walls.

import { buildSpatialGrid } from './spatialGrid.js'

export const WORLD = Object.freeze({
  width: 2560,
  height: 1600,
  margin: 24,
  wallThickness: 16, // exterior / load-bearing
  partitionThickness: 14, // interior partitions
})

/** Walkable area: inside the exterior walls, minus half a wall thickness. */
export const WALKABLE_BOUNDS = Object.freeze({
  x: WORLD.margin + WORLD.wallThickness / 2,
  y: WORLD.margin + WORLD.wallThickness / 2,
  w: WORLD.width - WORLD.margin * 2 - WORLD.wallThickness,
  h: WORLD.height - WORLD.margin * 2 - WORLD.wallThickness,
})

export const AVATAR_RADIUS = 16

// ---------------------------------------------------------------- zones ------

/** Floor materials — the renderer maps these to palettes/patterns. */
export const FLOORS = Object.freeze({
  OAK: 'oak',
  CARPET_GREY: 'carpet-grey',
  CARPET_TEAL: 'carpet-teal',
  CARPET_MAUVE: 'carpet-mauve',
  CARPET_CLAY: 'carpet-clay',
  TILE_LIGHT: 'tile-light',
  TILE_COOL: 'tile-cool',
  CONCRETE: 'concrete',
})

const zone = (id, name, kind, x, y, w, h, floor, labelAt, detail = '') => ({
  id,
  name,
  kind,
  detail,
  x,
  y,
  w,
  h,
  floor,
  labelAt: labelAt ?? { x: x + w / 2, y: y + h / 2 },
})

export const ZONES = Object.freeze([
  // left column
  zone('office-a', 'Office A', 'office', 24, 24, 440, 380, FLOORS.OAK, { x: 244, y: 60 }, 'private office'),
  zone('office-b', 'Office B', 'office', 24, 404, 440, 380, FLOORS.OAK, { x: 244, y: 440 }, 'private office'),
  zone('storage', 'Storage & Copy', 'utility', 24, 784, 440, 380, FLOORS.CONCRETE, { x: 244, y: 822 }, 'printers & supplies'),
  zone('restroom-w', 'Restroom', 'restroom', 24, 1164, 440, 412, FLOORS.TILE_COOL, { x: 244, y: 1200 }, 'washroom'),

  // right column
  zone('office-c', 'Office C', 'office', 2096, 24, 440, 380, FLOORS.OAK, { x: 2316, y: 60 }, 'private office'),
  zone('kitchen', 'Kitchen', 'kitchen', 2096, 404, 440, 380, FLOORS.TILE_LIGHT, { x: 2316, y: 440 }, 'coffee & lunch'),
  zone('huddle', 'Huddle Room', 'meeting', 2096, 784, 440, 380, FLOORS.CARPET_MAUVE, { x: 2316, y: 822 }, 'focus room'),
  zone('restroom-e', 'Restroom', 'restroom', 2096, 1164, 440, 412, FLOORS.TILE_COOL, { x: 2316, y: 1200 }, 'washroom'),

  // centre column
  zone('meeting', 'Meeting Room', 'meeting', 464, 24, 1104, 428, FLOORS.CARPET_TEAL, { x: 1016, y: 62 }, 'boardroom'),
  zone('lounge', 'Lounge', 'lounge', 1568, 24, 528, 428, FLOORS.CARPET_CLAY, { x: 1832, y: 62 }, 'breakout sofas'),
  zone('workspace', 'Open Workspace', 'workspace', 464, 452, 1632, 668, FLOORS.CARPET_GREY, { x: 1280, y: 490 }, 'open plan desks'),
  zone('reception', 'Reception & Entrance', 'reception', 464, 1120, 1632, 456, FLOORS.OAK, { x: 1280, y: 1158 }, 'welcome desk'),
])

export const ZONE_BY_ID = Object.freeze(Object.fromEntries(ZONES.map((z) => [z.id, z])))

// ---------------------------------------------------------------- walls ------

const T = { OUTER: WORLD.wallThickness, PART: WORLD.partitionThickness }

/**
 * Build wall segments for a straight run, skipping door openings.
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number,thickness:number,kind:string}>}
 */
function wallRun(orientation, fixed, from, to, gaps = [], thickness = T.PART, kind = 'partition') {
  const sorted = [...gaps].sort((a, b) => a.at - b.at)
  const segments = []
  let cursor = from

  for (const gap of sorted) {
    const start = gap.at - gap.width / 2
    const end = gap.at + gap.width / 2
    if (start > cursor) segments.push(makeSegment(orientation, fixed, cursor, start, thickness, kind))
    cursor = Math.max(cursor, end)
  }
  if (cursor < to) segments.push(makeSegment(orientation, fixed, cursor, to, thickness, kind))

  return segments
}

function makeSegment(orientation, fixed, from, to, thickness, kind) {
  return orientation === 'vertical'
    ? { x1: fixed, y1: from, x2: fixed, y2: to, thickness, kind }
    : { x1: from, y1: fixed, x2: to, y2: fixed, thickness, kind }
}

// Door openings (centre + width in world units). Widths leave room for the
// avatar radius on both sides: 90 units of opening vs. 32 units of body.
const D = {
  officeA: { at: 250, width: 92 },
  officeB: { at: 594, width: 92 },
  storage: { at: 974, width: 92 },
  restroomW: { at: 1370, width: 88 },
  officeC: { at: 250, width: 92 },
  kitchen: { at: 594, width: 92 },
  huddle: { at: 974, width: 92 },
  restroomE: { at: 1370, width: 88 },
  meeting: { at: 800, width: 96 },
  lounge: { at: 1830, width: 96 },
  meetingToLounge: { at: 240, width: 130 },
  lobbyArchway: { at: 1185, width: 440 }, // between workspace and reception
  entrance: { at: 1280, width: 280 }, // glass entrance doors
}

export const WALLS = Object.freeze([
  // --- exterior shell -------------------------------------------------------
  ...wallRun('horizontal', 24, 24, 2536, [], T.OUTER, 'outer'), // north
  ...wallRun('horizontal', 1576, 24, 2536, [D.entrance], T.OUTER, 'outer'), // south (entrance)
  ...wallRun('vertical', 24, 24, 1576, [], T.OUTER, 'outer'), // west
  ...wallRun('vertical', 2536, 24, 1576, [], T.OUTER, 'outer'), // east

  // --- left column partitions (solid, doors face the centre) ---------------
  ...wallRun('horizontal', 404, 24, 464, [], T.PART),
  ...wallRun('horizontal', 784, 24, 464, [], T.PART),
  ...wallRun('horizontal', 1164, 24, 464, [], T.PART),
  ...wallRun(
    'vertical',
    464,
    24,
    1576,
    [D.officeA, D.officeB, D.storage, D.restroomW],
    T.PART,
  ),

  // --- right column partitions ---------------------------------------------
  ...wallRun('horizontal', 404, 2096, 2536, [], T.PART),
  ...wallRun('horizontal', 784, 2096, 2536, [], T.PART),
  ...wallRun('horizontal', 1164, 2096, 2536, [], T.PART),
  ...wallRun('vertical', 2096, 24, 1576, [D.officeC, D.kitchen, D.huddle, D.restroomE], T.PART),

  // --- centre: meeting room | lounge ---------------------------------------
  ...wallRun('vertical', 1568, 24, 452, [D.meetingToLounge], T.PART),
  // meeting + lounge | workspace
  ...wallRun('horizontal', 452, 464, 2096, [D.meeting, D.lounge], T.PART),
  // workspace | reception (wide archway, so the wall reads as a partial divider)
  ...wallRun('horizontal', 1120, 464, 2096, [D.lobbyArchway], T.PART),
])

/**
 * Door leaves drawn on top of the wall openings.
 * `orientation` matches the wall run; `swing` (+1/-1) chooses the hinge side.
 */
export const DOORS = Object.freeze([
  { id: 'door-office-a', x: 464, y: 250, width: 92, orientation: 'vertical', kind: 'single', swing: 1 },
  { id: 'door-office-b', x: 464, y: 594, width: 92, orientation: 'vertical', kind: 'single', swing: -1 },
  { id: 'door-storage', x: 464, y: 974, width: 92, orientation: 'vertical', kind: 'single', swing: 1 },
  { id: 'door-restroom-w', x: 464, y: 1370, width: 88, orientation: 'vertical', kind: 'single', swing: -1 },
  { id: 'door-office-c', x: 2096, y: 250, width: 92, orientation: 'vertical', kind: 'single', swing: -1 },
  { id: 'door-kitchen', x: 2096, y: 594, width: 92, orientation: 'vertical', kind: 'single', swing: 1 },
  { id: 'door-huddle', x: 2096, y: 974, width: 92, orientation: 'vertical', kind: 'single', swing: -1 },
  { id: 'door-restroom-e', x: 2096, y: 1370, width: 88, orientation: 'vertical', kind: 'single', swing: 1 },
  { id: 'door-meeting', x: 800, y: 452, width: 96, orientation: 'horizontal', kind: 'double', swing: 1 },
  { id: 'door-lounge', x: 1830, y: 452, width: 96, orientation: 'horizontal', kind: 'single', swing: -1 },
  { id: 'door-meeting-lounge', x: 1568, y: 240, width: 130, orientation: 'vertical', kind: 'opening', swing: 1 },
  { id: 'archway-lobby', x: 1185, y: 1120, width: 440, orientation: 'horizontal', kind: 'opening', swing: 1 },
  // exterior opening: only its inner face is walkable (outside is the street)
  { id: 'entrance', x: 1280, y: 1576, width: 280, orientation: 'horizontal', kind: 'glass', swing: 1, exterior: true },
])

// ----------------------------------------------------------- furniture ------

let itemCounter = 0
const SOLID = { yes: true, no: false }

/**
 * Declarative furniture item.
 * `w`/`h` are the axis-aligned footprint (already rotation-resolved), so the
 * collision box and the layout test never need to know about `rot`.
 *
 * @param {string} type
 * @param {number} x centre x
 * @param {number} y centre y
 * @param {number} w footprint width
 * @param {number} h footprint depth
 * @param {{rot?: number, props?: string[], collide?: boolean, label?: string, tint?: string}} [extra]
 */
function item(type, x, y, w, h, extra = {}) {
  itemCounter += 1
  return Object.freeze({
    id: `${type}-${itemCounter}`,
    type,
    x,
    y,
    w,
    h,
    rot: extra.rot ?? 0,
    props: extra.props ?? [],
    collide: extra.collide ?? SOLID.yes,
    label: extra.label ?? null,
    tint: extra.tint ?? null,
  })
}

/** Desk with a chair pushed in — repeated across the open workspace. */
const workspacePod = (x) => [
  item('desk', x, 640, 160, 80, { props: ['monitor', 'keyboard', 'mug'] }),
  item('chair', x, 730, 44, 44),
  item('desk', x, 960, 160, 80, { rot: 180, props: ['monitor', 'keyboard', 'mug', 'notebook'] }),
  item('chair', x, 870, 44, 44, { rot: 180 }),
]

export const FURNITURE = Object.freeze([
  // --- Office A -------------------------------------------------------------
  item('desk', 140, 200, 80, 170, { rot: 270, props: ['monitor', 'keyboard', 'mug', 'phone'] }),
  item('chair', 250, 215, 46, 46, { rot: 270 }),
  item('bookshelf', 74, 220, 46, 150),
  item('filingCabinet', 380, 110, 62, 92),
  item('plant', 395, 340, 58, 58, { tint: 'lush' }),

  // --- Office B -------------------------------------------------------------
  item('desk', 240, 560, 170, 80, { props: ['monitor', 'keyboard', 'mug', 'plant'] }),
  item('chair', 240, 650, 46, 46),
  item('bookshelf', 74, 640, 46, 160),
  item('plant', 395, 460, 58, 58, { tint: 'slim' }),

  // --- Storage & Copy ------------------------------------------------------
  item('shelfUnit', 96, 950, 92, 262),
  item('printerTable', 250, 860, 122, 72, { props: ['printer'] }),
  item('lockers', 394, 880, 72, 140),
  item('waterCooler', 250, 1090, 48, 48),

  // --- Restroom (west) -----------------------------------------------------
  item('stall', 130, 1290, 130, 142, { props: ['toilet'] }),
  item('stall', 270, 1290, 130, 142, { props: ['toilet'] }),
  item('sinkUnit', 100, 1470, 72, 56),
  item('sinkUnit', 210, 1470, 72, 56),
  item('plant', 395, 1500, 58, 58, { tint: 'calm' }),

  // --- Office C ------------------------------------------------------------
  item('desk', 2330, 200, 160, 80, { props: ['monitor', 'keyboard', 'mug', 'notebook'] }),
  item('chair', 2330, 300, 46, 46),
  item('bookshelf', 2160, 130, 46, 160),
  item('plant', 2470, 340, 58, 58, { tint: 'lush' }),

  // --- Kitchen -------------------------------------------------------------
  item('counter', 2320, 500, 340, 70, { props: ['sink', 'stove', 'coffeeMachine'] }),
  item('fridge', 2470, 620, 80, 92),
  item('cafeTable', 2320, 680, 110, 110),
  item('chair', 2240, 680, 44, 44, { rot: 90 }),
  item('chair', 2400, 680, 44, 44, { rot: 270 }),

  // --- Huddle room ---------------------------------------------------------
  item('collabTable', 2330, 950, 170, 110),
  item('chair', 2330, 866, 44, 44, { rot: 180 }),
  item('chair', 2330, 1034, 44, 44),
  item('chair', 2220, 950, 44, 44, { rot: 90 }),
  item('chair', 2440, 950, 44, 44, { rot: 270 }),
  item('plant', 2480, 1100, 58, 58, { tint: 'slim' }),

  // --- Restroom (east) -----------------------------------------------------
  item('stall', 2440, 1290, 130, 142, { props: ['toilet'] }),
  item('stall', 2300, 1290, 130, 142, { props: ['toilet'] }),
  item('sinkUnit', 2470, 1470, 72, 56),
  item('sinkUnit', 2360, 1470, 72, 56),
  item('plant', 2160, 1500, 58, 58, { tint: 'calm' }),

  // --- Meeting room --------------------------------------------------------
  item('boardroomTable', 1016, 240, 420, 150),
  item('chair', 880, 140, 46, 46, { rot: 180 }),
  item('chair', 1016, 140, 46, 46, { rot: 180 }),
  item('chair', 1152, 140, 46, 46, { rot: 180 }),
  item('chair', 880, 340, 46, 46),
  item('chair', 1016, 340, 46, 46),
  item('chair', 1152, 340, 46, 46),
  item('chair', 770, 240, 46, 46, { rot: 90 }),
  item('chair', 1262, 240, 46, 46, { rot: 270 }),
  item('credenza', 1016, 90, 190, 62, { props: ['tv'] }),
  item('plant', 540, 390, 60, 60, { tint: 'lush' }),
  item('plant', 1500, 390, 60, 60, { tint: 'lush' }),
  item('plant', 540, 100, 60, 60, { tint: 'slim' }),

  // --- Lounge --------------------------------------------------------------
  item('sofa', 1840, 112, 240, 94, { props: ['3seat'] }),
  item('coffeeTable', 1840, 244, 124, 72, { props: ['magazine'] }),
  item('armchair', 1700, 250, 94, 94, { rot: 90 }),
  item('armchair', 1982, 250, 94, 94, { rot: 270 }),
  item('bookshelf', 1620, 130, 46, 160),
  item('plant', 2040, 390, 60, 60, { tint: 'calm' }),
  item('plant', 1632, 390, 60, 60, { tint: 'lush' }),

  // --- Open workspace ------------------------------------------------------
  ...workspacePod(760),
  ...workspacePod(1080),
  ...workspacePod(1400),
  ...workspacePod(1720),
  item('collabTable', 1240, 800, 220, 140),
  item('chair', 1240, 690, 44, 44, { rot: 180 }),
  item('chair', 1240, 910, 44, 44),
  item('chair', 1108, 800, 44, 44, { rot: 90 }),
  item('chair', 1372, 800, 44, 44, { rot: 270 }),
  item('plant', 540, 520, 62, 62, { tint: 'lush' }),
  item('plant', 2020, 520, 62, 62, { tint: 'lush' }),
  item('plant', 540, 1040, 62, 62, { tint: 'slim' }),
  item('plant', 2020, 1040, 62, 62, { tint: 'slim' }),
  item('printerTable', 600, 900, 112, 72, { props: ['printer'] }),
  item('printerTable', 1960, 900, 112, 72, { props: ['printer'] }),
  item('waterCooler', 1240, 1040, 48, 48),

  // --- Reception & entrance -------------------------------------------------
  item('receptionDesk', 1280, 1330, 320, 90, { props: ['monitor', 'bell', 'mug'] }),
  item('chair', 1280, 1240, 46, 46, { rot: 180 }),
  item('sofa', 700, 1380, 230, 94, { props: ['2seat'] }),
  item('armchair', 890, 1390, 94, 94, { rot: 90 }),
  item('coffeeTable', 760, 1480, 112, 72, { props: ['magazine'] }),
  item('sofa', 1860, 1380, 230, 94, { props: ['2seat'] }),
  item('armchair', 1670, 1390, 94, 94, { rot: 270 }),
  item('coffeeTable', 1800, 1480, 112, 72, { props: ['magazine'] }),
  item('plant', 540, 1200, 62, 62, { tint: 'lush' }),
  item('plant', 2020, 1200, 62, 62, { tint: 'lush' }),
  item('plant', 540, 1520, 60, 60, { tint: 'slim' }),
  item('plant', 2020, 1520, 60, 60, { tint: 'slim' }),
])

// -------------------------------------------------------------- decor ------

/** Flat overlays (rugs, light pools) and wall-mounted art (no collision). */
export const DECOR = Object.freeze([
  // rugs
  { id: 'rug-lounge', type: 'rug', x: 1832, y: 250, w: 380, h: 300, tone: 'clay' },
  { id: 'rug-workspace', type: 'rug', x: 1240, y: 800, w: 420, h: 300, tone: 'slate' },
  { id: 'rug-reception-w', type: 'rug', x: 760, y: 1410, w: 320, h: 230, tone: 'sand' },
  { id: 'rug-reception-e', type: 'rug', x: 1800, y: 1410, w: 320, h: 230, tone: 'sand' },
  { id: 'rug-office-a', type: 'rug', x: 190, y: 240, w: 240, h: 220, tone: 'slate' },
  { id: 'rug-meeting', type: 'rug', x: 1016, y: 250, w: 560, h: 330, tone: 'indigo' },

  // wall-mounted boards and screens (drawn after walls, no collision)
  { id: 'board-meeting', type: 'whiteboard', x: 486, y: 150, w: 30, h: 220, facing: 'east' },
  { id: 'board-huddle', type: 'whiteboard', x: 2114, y: 900, w: 30, h: 200, facing: 'east' },
  { id: 'board-office-b', type: 'whiteboard', x: 40, y: 500, w: 26, h: 170, facing: 'east' },
  { id: 'art-office-a', type: 'artFrame', x: 40, y: 110, w: 26, h: 96, facing: 'east' },
  { id: 'art-office-c', type: 'artFrame', x: 2520, y: 120, w: 26, h: 96, facing: 'west' },
  { id: 'mirror-restroom-w', type: 'mirror', x: 40, y: 1440, w: 24, h: 150, facing: 'east' },
  { id: 'mirror-restroom-e', type: 'mirror', x: 2520, y: 1440, w: 24, h: 150, facing: 'west' },
  { id: 'sign-reception', type: 'signage', x: 1400, y: 1548, w: 200, h: 34, facing: 'north', text: 'PROXISPEAK' },
  { id: 'art-workspace-w', type: 'artFrame', x: 40, y: 900, w: 26, h: 110, facing: 'east' },
  { id: 'art-workspace-e', type: 'artFrame', x: 2520, y: 900, w: 26, h: 110, facing: 'west' },

  // ceiling light pools (soft, additive-looking overlays on the floor)
  ...[
    [1016, 240, 380, 300],
    [1832, 240, 300, 260],
    [820, 640, 300, 240],
    [1140, 960, 300, 240],
    [1460, 640, 300, 240],
    [1780, 960, 300, 240],
    [1280, 800, 340, 260],
    [1280, 1330, 420, 320],
    [700, 1390, 260, 220],
    [1860, 1390, 260, 220],
    [2320, 500, 320, 240],
    [2330, 950, 300, 240],
    [160, 200, 260, 240],
    [240, 560, 260, 240],
    [2330, 200, 260, 240],
  ].map(([x, y, w, h], index) => ({ id: `light-${index}`, type: 'lightPool', x, y, w, h, intensity: 0.5 })),
])

export const SPAWNS = Object.freeze([
  { id: 'entrance', label: 'Entrance', x: 1280, y: 1500 },
  { id: 'workspace', label: 'Workspace', x: 920, y: 800 },
  { id: 'meeting', label: 'Meeting room', x: 640, y: 300 },
])

export const DEFAULT_SPAWN = SPAWNS[0]

// --------------------------------------------------------- collision -------

/** Wall segments → solid boxes (walls are solid; door openings are already gaps). */
export function wallColliders(walls = WALLS) {
  return walls.map((wall) => {
    const half = wall.thickness / 2
    return wall.x1 === wall.x2
      ? { x: wall.x1 - half, y: Math.min(wall.y1, wall.y2), w: wall.thickness, h: Math.abs(wall.y2 - wall.y1) }
      : { x: Math.min(wall.x1, wall.x2), y: wall.y1 - half, w: Math.abs(wall.x2 - wall.x1), h: wall.thickness }
  })
}

/** Solid furniture → collision boxes. Rugs, light pools and wall art are ignored. */
export function furnitureColliders(furniture = FURNITURE) {
  return furniture
    .filter((f) => f.collide)
    .map((f) => ({ x: f.x - f.w / 2, y: f.y - f.h / 2, w: f.w, h: f.h }))
}

export const STATIC_COLLIDERS = Object.freeze([...wallColliders(), ...furnitureColliders()])

/** Spatial index over the static colliders — used by collision and rendering. */
export const COLLIDER_GRID = buildSpatialGrid(STATIC_COLLIDERS)

/** Spatial index over furniture footprints, for render culling. */
export const FURNITURE_GRID = buildSpatialGrid(
  FURNITURE.map((f) => ({ x: f.x - f.w / 2, y: f.y - f.h / 2, w: f.w, h: f.h, item: f })),
)

/** Spatial index over decor overlays, for render culling. */
export const DECOR_GRID = buildSpatialGrid(
  DECOR.map((d) => ({ x: d.x - d.w / 2, y: d.y - d.h / 2, w: d.w, h: d.h, item: d })),
)

export const WORLD_SUMMARY = Object.freeze({
  zones: ZONES.length,
  walls: WALLS.length,
  doors: DOORS.length,
  furniture: FURNITURE.length,
  decor: DECOR.length,
  colliders: STATIC_COLLIDERS.length,
})
