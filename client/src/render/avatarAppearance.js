// Procedural avatar appearance.
//
// No sprite sheets and no external images: every avatar is built from a stable
// seed, so the same player id always produces the same person on every client and
// after every reload. When presence arrives over the network, peers only need to
// send their id and everyone renders the same colleague.

import { createRngKit } from '../world/random.js'
import { PALETTE } from './palette.js'

export const SKIN_TONES = Object.freeze([
  '#f2cfae',
  '#e6b48c',
  '#cf9468',
  '#a9724a',
  '#835237',
  '#5f3c28',
])

export const HAIR_COLOURS = Object.freeze([
  '#241d1a',
  '#3c2a20',
  '#5a3d28',
  '#8a6039',
  '#c39a5e',
  '#d9c39a',
  '#383d47',
  '#6f5178',
  '#a8452f',
])

export const HAIR_STYLES = Object.freeze(['short', 'buzz', 'bun', 'ponytail', 'curly', 'long', 'side-part', 'wavy'])

export const SHIRT_COLOURS = Object.freeze([
  PALETTE.fabric.indigo,
  PALETTE.accents.teal,
  PALETTE.accents.coral,
  PALETTE.accents.amber,
  PALETTE.fabric.slate,
  PALETTE.accents.green,
  PALETTE.fabric.clay,
  '#7b6ba8',
  '#4a7fa5',
  '#b8563f',
])

export const ACCESSORIES = Object.freeze(['none', 'glasses', 'headphones', 'badge', 'beard', 'earrings', 'scarf'])

const PANTS = ['#39414f', '#2f3745', '#4a3f36', '#333a48', '#434c5c']

/**
 * Build a deterministic appearance for a player id.
 *
 * @param {string} id stable identifier (session id, or 'local' for this client)
 * @param {{variant?: string|number, preferAccent?: boolean}} [options]
 * @returns {{id:string, seed:string, skin:string, hair:string, hairStyle:string, shirt:string, pants:string, accessory:string, accent:string, hasBag:boolean}}
 */
export function createAvatarAppearance(id, options = {}) {
  const seed = `${id}:${options.variant ?? ''}`
  const rng = createRngKit(seed)

  const shirt = rng.pick(SHIRT_COLOURS)
  return Object.freeze({
    id,
    seed,
    skin: rng.pick(SKIN_TONES),
    hair: rng.pick(HAIR_COLOURS),
    hairStyle: rng.pick(HAIR_STYLES),
    shirt: options.accentShirt ? PALETTE.fabric.indigo : shirt,
    pants: rng.pick(PANTS),
    accessory: rng.pick(ACCESSORIES),
    accent: options.accentColour ?? PALETTE.accents.indigo,
    hasBag: rng.chance(0.35),
  })
}

/** The local player is always easy to pick out of a crowd. */
export function createLocalAppearance(id = 'local') {
  const base = createAvatarAppearance(id, { variant: 'local', accentShirt: true })
  return Object.freeze({ ...base, accessory: base.accessory === 'none' ? 'badge' : base.accessory })
}

/** Derive a short, stable hue for minimap-ish indicators (unused visually today). */
export function appearanceHue(appearance) {
  let hash = 0
  for (const char of appearance.seed) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return hash
}
