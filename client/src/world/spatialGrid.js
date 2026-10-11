// Tiny uniform spatial grid for collision lookups and render culling.
//
// The world is static, so the grid is built once. Queries return only the boxes
// near a region, which keeps both collision checks and per-frame culling O(local)
// instead of scanning every item in the office.

const DEFAULT_CELL = 160

export function buildSpatialGrid(boxes, cellSize = DEFAULT_CELL) {
  const cells = new Map()
  const key = (cx, cy) => `${cx}:${cy}`

  for (const box of boxes) {
    const minX = Math.floor(box.x / cellSize)
    const maxX = Math.floor((box.x + box.w) / cellSize)
    const minY = Math.floor(box.y / cellSize)
    const maxY = Math.floor((box.y + box.h) / cellSize)
    for (let cx = minX; cx <= maxX; cx += 1) {
      for (let cy = minY; cy <= maxY; cy += 1) {
        const cellKey = key(cx, cy)
        const bucket = cells.get(cellKey)
        if (bucket) bucket.push(box)
        else cells.set(cellKey, [box])
      }
    }
  }

  return {
    cellSize,
    size: boxes.length,

    /** Union of boxes whose cells intersect the given rect (may contain duplicates). */
    query(rect) {
      if (rect.w <= 0 || rect.h <= 0) return []
      const minX = Math.floor(rect.x / cellSize)
      const maxX = Math.floor((rect.x + rect.w) / cellSize)
      const minY = Math.floor(rect.y / cellSize)
      const maxY = Math.floor((rect.y + rect.h) / cellSize)
      const found = []
      for (let cx = minX; cx <= maxX; cx += 1) {
        for (let cy = minY; cy <= maxY; cy += 1) {
          const bucket = cells.get(key(cx, cy))
          if (bucket) found.push(...bucket)
        }
      }
      return found
    },

    /** Deduplicated query — used for rendering, where double-drawing matters. */
    queryUnique(rect) {
      return [...new Set(this.query(rect))]
    },
  }
}
