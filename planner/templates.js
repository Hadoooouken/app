// planner/templates.js
import { state, CAP_W, NOR_W, OVERLAP } from '../engine/state.js'
import { projectPointToSegmentClamped } from '../engine/geom.js'

let id = 1
const W = (ax, ay, bx, by, kind = 'capital') => ({
  id: `w${id++}`,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  kind,
})

// --- НАСТРОЙКИ “геометрии стыка” ---
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
    if (pr.d <= SNAP_DIST && (!best || pr.d < best.d)) {
      best = { q: pr.point, d: pr.d }
    }
  }

  if (!best) return { vis: endpoint, build: endpoint }

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

    const a0 = { ...w.a }
    const b0 = { ...w.b }

    const A = snapAndTrimEndpoint(a0, b0, caps)
    const B = snapAndTrimEndpoint(b0, a0, caps)

    w.a = A.vis
    w.b = B.vis

    w.va = A.build
    w.vb = B.build
  }
}

// простая дверь-id (не обязательно, но удобно)
function did() {
  return `d${Date.now()}_${Math.random().toString(16).slice(2)}`
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

  // --- стены ---
  const capTop = W(x0, y0, x1, y0, 'capital')
  const capRightUp = W(x1, y0, x1, notchY, 'capital')
  const capNotch = W(x1, notchY, notchX, notchY, 'capital')
  const capRightDown = W(notchX, notchY, notchX, y1, 'capital')
  const capBottom = W(notchX, y1, x0, y1, 'capital')
  const capLeft = W(x0, y1, x0, y0, 'capital')

  const nBed1 = W(bedLeft, bedTop, bedLeft, bedBottom, 'normal')
  const nBed2 = W(bedLeft, bedBottom, x1, bedBottom, 'normal')

  const nBath1 = W(bathLeft, bathTop, bathRight, bathTop, 'normal')
  const nBath2 = W(bathLeft, bathTop, bathLeft, y1, 'normal')

  state.walls = [
    capTop,
    capRightUp,
    capNotch,
    capRightDown,
    capBottom,
    capLeft,

    nBed1,
    nBed2,
    nBath1,
    nBath2,
  ]

  // ✅ подрезаем нормалы к капитальным
  snapAndTrimNormalsToCapitals()

  // --- двери ---
  // входная дверь (locked)
  state.doors = [
    {
      id: did(),
      kind: 'entry',
      wallId: capBottom.id, // ✅ на капитальной
      t: 0.25,
      w: 90,
      thick: CAP_W,
      locked: true,
    },

    // пример межкомнатной (двигается)
    {
      id: did(),
      kind: 'interior',
      wallId: nBed2.id, // ✅ на normal
      t: 0.5,
      w: 75,
      thick: NOR_W,
    },
  ]

  // сброс интерактива
  state.draft = null
  state.selectedWallId = null
  state.hoverWallId = null
  state.selectedDoorId = null
}
