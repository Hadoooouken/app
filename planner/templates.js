// planner/templates.js
import { state } from '../engine/state.js'
import { config } from '../engine/config.js'
import { ensureCapitalInnerFaces } from '../engine/capitals-inner.js'
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

// алиасы толщин из конфига
const CAP_W = config.walls.CAP_W
const NOR_W = config.walls.NOR_W
const OVERLAP = config.walls.OVERLAP

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
  const caps = (state.walls || []).filter(w => w && w.kind === 'capital')
  if (!caps.length) return

  for (const w of (state.walls || [])) {
    if (!w || w.kind !== 'normal') continue

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

// ✅ Окна для стартового шаблона.
// wallId — id капитальной стены
// t — положение по стене (0..1)
// kind: 'std' | 'balcony'
// export const studioWindows = [
// Верхняя стена (capTop = w1)
// { wallId: 'w1', t: 0.4, kind: 'std' },
// { wallId: 'w1', t: 0.80, kind: 'std' },
// Пример на правой стене (если нужно оставить)
//   { wallId: 'w6', t: 0.75, kind: 'balcony' },
// ]
// простая дверь-id (не обязательно, но удобно)
function did() {
  return `d${Date.now()}_${Math.random().toString(16).slice(2)}`
}

// ✅ Окна для шаблона 12x7.6
// wallId — id капитальной стены
// t — положение по стене (0..1)
export const studioWindows = [
  // Верхняя стена (capTop = w1), две штуки
  { wallId: 'w1', t: 600 / 1200, kind: 'std' }, // центр окна x=500
  { wallId: 'w1', t: 980 / 1200, kind: 'std' }, // центр окна x=820

  // Левая стена (capLeft = w4), окно примерно по центру y=220
  // capLeft идет (0,760)->(0,0), t = (760 - y)/760
  { wallId: 'w1', t: (350 - 220) / 760, kind: 'balcony' },
]


export function loadStudioTemplate() {
  id = 1

  const x0 = 0
  const y0 = 0
  const x1 = 1200
  const y1 = 760

  // ---- ВНЕШНИЙ КОНТУР (прямоугольник 12x7.6) ----
  const capTop = W(x0, y0, x1, y0, 'capital')   // w1
  const capRight = W(x1, y0, x1, y1, 'capital')   // w2
  const capBottom = W(x1, y1, x0, y1, 'capital')   // w3
  const capLeft = W(x0, y1, x0, y0, 'capital')   // w4

  // ---- ВНУТРЕННИЕ КАПИТАЛЬНЫЕ ----
  // Главная внутренняя вертикальная: x=6м => 600
  const capMid = W(400, 0, 400, 520, 'capital')    // w5


  // Горизонтальная слева: отделяет нижний коридор
  const capMidHLL = W(0, 200, 150, 200, 'capital')
  const capMidHLR = W(400, 200, 250, 200, 'capital')    // w6
  const capMidLL = W(400, 750, 400, 650, 'capital') // 1 метр внутри   // w6



  state.walls = [
    capTop, capRight, capBottom, capLeft,
    capMid, capMidHLL, capMidHLR, capMidLL
  ]

  // ✅ подрезка нормалей тут не влияет (нормалей нет), можно оставить
  snapAndTrimNormalsToCapitals()

  // ✅ строим внутренние грани капитальных
  ensureCapitalInnerFaces()

  // ---- ДВЕРИ ----
  // Входная дверь на нижней стене по центру (t=0.5)
  state.doors = [
    {
      id: did(),
      kind: 'entry',
      wallId: capBottom.id, // w3
      t: 0.5,
      w: 90,
      thick: CAP_W,
      locked: true,
    },
  ]

  // ---- ОКНА ----
  // Если у тебя есть state.windows — лучше так:
  state.windows = [...studioWindows]

  // сброс интерактива
  state.draft = null
  state.selectedWallId = null
  state.hoverWallId = null
  state.selectedDoorId = null
  state.hoverDoorId = null
  state.previewWall = null
  state.previewDoor = null
}