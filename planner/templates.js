// planner/templates.js
import { state } from '../engine/state.js'
import { dist, projectPointToSegmentClamped } from '../engine/geom.js'

let id = 1
const W = (ax, ay, bx, by, kind = 'capital') => ({
  id: `w${id++}`,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  kind,
})

// --- НАСТРОЙКИ “геометрии стыка” ---
const CAP_W = 28
const NOR_W = 10
const SNAP_DIST = 40 // world units

function trimPointBack(from, to, trimLen) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  return { x: to.x - ux * trimLen, y: to.y - uy * trimLen }
}

function snapAndTrimEndpoint(endpoint, otherEnd, capitals) {
  let best = null

  for (const c of capitals) {
    const pr = projectPointToSegmentClamped(endpoint, c.a, c.b)
    if (pr.d <= SNAP_DIST && (!best || pr.d < best.d)) best = { q: pr.point, d: pr.d }
  }

  if (!best) {
    return { vis: endpoint, build: endpoint }
  }

  const OVERLAP = 5
  const trim = CAP_W / 2 + NOR_W / 2 - OVERLAP
  const build = best.q
  const vis = trimPointBack(otherEnd, build, trim)

  return { vis, build }
}

function snapAndTrimNormalsToCapitals() {
  const caps = state.walls.filter(w => w.kind === 'capital')
  if (!caps.length) return

  for (const w of state.walls) {
    if (w.kind !== 'normal') continue

    const A = snapAndTrimEndpoint(w.a, w.b, caps)
    const B = snapAndTrimEndpoint(w.b, w.a, caps)

    w.a = A.vis
    w.b = B.vis

    // ✅ строительная геометрия для метрик/размеров
    w.va = A.build
    w.vb = B.build
  }
}

export function loadStudioTemplate() {
  id = 1

  const x0 = 0
  const y0 = 0
  const x1 = 1200
  const y1 = 760

  const notchX = 980
  const notchY = 620

  const bedLeft = 760
  const bedTop = 0
  const bedBottom = 360

  const bathTop = 520
  const bathLeft = 520
  const bathRight = 820

  state.walls = [
    // --- capital outer (основная коробка) ---
    W(x0, y0, x1, y0, 'capital'),
    W(x1, y0, x1, notchY, 'capital'),
    W(x1, notchY, notchX, notchY, 'capital'),
    W(notchX, notchY, notchX, y1, 'capital'),
    W(notchX, y1, x0, y1, 'capital'),
    W(x0, y1, x0, y0, 'capital'),

    // --- normals ---
    W(bedLeft, bedTop, bedLeft, bedBottom, 'normal'),
    W(bedLeft, bedBottom, x1, bedBottom, 'normal'),

    W(bathLeft, bathTop, bathRight, bathTop, 'normal'),
    W(bathLeft, bathTop, bathLeft, y1, 'normal'),
  ]

  // подрезаем нормалы к капитальным
  snapAndTrimNormalsToCapitals()

  state.draft = null
}
