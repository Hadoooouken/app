// renderer/render.js
import { state, UNITS_PER_M, GRID_STEP_VIEW } from '../engine/state.js'
import { ensureCapitalInnerFaces } from '../engine/capitals-inner.js'


const CAP_W = 28
const NOR_W = 10

const CAP_COLOR = '#111'
const NOR_COLOR = '#343938'
const SELECT_COLOR = '#0a84ff'

// cursor colors
const CURSOR_IDLE = '#111'
const CURSOR_INVALID = '#ff3b30'

// dimensions
const DIM_COLOR = '#111'
const DIM_BG = '#ffffff'
const DIM_BG_OPACITY = 0.75

// --- helpers ---
function keyOf(p) {
  return `${Math.round(p.x * 1000)}:${Math.round(p.y * 1000)}`
}
function unitsToMeters(u) {
  return u / UNITS_PER_M
}
function formatMeters(m) {
  return `${m.toFixed(2)} м`
}
function midPoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}
function angleDeg(a, b) {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
}
function readableRotation(deg) {
  let r = deg
  while (r > 180) r -= 360
  while (r < -180) r += 360
  if (r > 90 || r < -90) r += 180
  while (r > 180) r -= 360
  while (r < -180) r += 360
  return r
}
function unitNormal(a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return { nx: -dy / len, ny: dx / len }
}

// bbox for "inside box" label — use capitals a/b
function getCapitalBBox(walls) {
  const caps = walls.filter(w => w.kind === 'capital')
  if (!caps.length) return null

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  for (const w of caps) {
    const a = w.a
    const b = w.b
    minX = Math.min(minX, a.x, b.x)
    minY = Math.min(minY, a.y, b.y)
    maxX = Math.max(maxX, a.x, b.x)
    maxY = Math.max(maxY, a.y, b.y)
  }

  return { minX, minY, maxX, maxY }
}

export function fitToWalls(draw, opts = {}) {
  const { padding = 180, maxScale = 1.4, minScale = 0.15 } = opts

  const walls = state.walls || []
  if (!draw || walls.length === 0) return

  const caps = walls.filter(w => w.kind === 'capital')
  const list = caps.length ? caps : walls

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const w of list) {
    minX = Math.min(minX, w.a.x, w.b.x)
    minY = Math.min(minY, w.a.y, w.b.y)
    maxX = Math.max(maxX, w.a.x, w.b.x)
    maxY = Math.max(maxY, w.a.y, w.b.y)
  }

  const wW = Math.max(1, maxX - minX)
  const wH = Math.max(1, maxY - minY)

  const rect = draw.node.getBoundingClientRect()
  const viewW = Math.max(1, rect.width - padding * 2)
  const viewH = Math.max(1, rect.height - padding * 2)

  let s = Math.min(viewW / wW, viewH / wH)
  s = Math.max(minScale, Math.min(maxScale, s))

  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const sx = rect.width / 2
  const sy = rect.height / 2

  state.view.scale = s
  state.view.offsetX = sx - cx * s
  state.view.offsetY = sy - cy * s
}

function getCapitalsCentroid(walls) {
  const caps = walls.filter(w => w.kind === 'capital')
  if (!caps.length) return { x: 0, y: 0 }

  // берём точки a (у тебя капы идут кольцом, этого достаточно)
  let sx = 0, sy = 0, n = 0
  for (const w of caps) {
    sx += w.a.x
    sy += w.a.y
    n++
  }
  return { x: sx / n, y: sy / n }
}

/**
 * Возвращает нормаль (nx, ny), направленную НАРУЖУ относительно centroid.
 * Логика: если шаг по нормали приближает к центру — это внутрь, значит надо перевернуть.
 */
function outwardNormal(a, b, centroid) {
  const { nx, ny } = unitNormal(a, b)
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }

  const eps = 1 // маленький шаг в world
  const p1 = { x: mid.x + nx * eps, y: mid.y + ny * eps }
  const p2 = { x: mid.x - nx * eps, y: mid.y - ny * eps }

  const d1 = Math.hypot(p1.x - centroid.x, p1.y - centroid.y)
  const d2 = Math.hypot(p2.x - centroid.x, p2.y - centroid.y)

  // если p1 ближе к центру — нормаль смотрит внутрь, переворачиваем
  return d1 < d2 ? { nx: -nx, ny: -ny } : { nx, ny }
}

/* =========================
   ✅ Scene cache (NO draw.clear)
   Grid = SVG pattern (fast)
========================= */
let cache = null

function ensureScene(draw) {
  if (cache && cache.draw === draw) return cache

  // не чистим каждый кадр, создаём один раз
  const scene = draw.group().id('scene')
  const gridG = scene.group().id('grid')
  const wallsG = scene.group().id('walls')
  const dimsG = scene.group().id('dims')
  const overlayG = scene.group().id('overlay')

  // GRID via pattern
  const step = GRID_STEP_VIEW
  const pattern = draw.pattern(step, step, (add) => {
    add.line(0, 0, step, 0).stroke({ width: 1, color: '#e3dfd7' })
    add.line(0, 0, 0, step).stroke({ width: 1, color: '#e3dfd7' })
  })

  // huge rect covered by pattern
  const WORLD = 24000
  const gridRect = gridG
    .rect(WORLD, WORLD)
    .move(-WORLD / 2, -WORLD / 2)
    .fill(pattern)
    .attr({ 'pointer-events': 'none' })

  cache = { draw, scene, gridG, wallsG, dimsG, overlayG, gridRect, pattern }
  return cache
}

export function render(draw) {
  ensureCapitalInnerFaces()

  const { scene, wallsG, dimsG, overlayG } = ensureScene(draw)

  // transform whole scene
  scene.transform({
    translateX: state.view.offsetX,
    translateY: state.view.offsetY,
    scale: state.view.scale,
  })

  const invScale = 1 / Math.max(1e-6, state.view.scale)

  // ✅ clear only dynamic layers
  wallsG.clear()
  dimsG.clear()
  overlayG.clear()

  const walls = state.walls || []
  const caps = walls.filter(w => w.kind === 'capital')
  const normals = walls.filter(w => w.kind !== 'capital')

  // 1) CAPITAL
  for (const w of caps) {
    wallsG
      .line(w.a.x, w.a.y, w.b.x, w.b.y)
      .stroke({
        width: CAP_W,
        color: CAP_COLOR,
        linecap: 'round',
        linejoin: 'round',
      })
      .attr({ 'pointer-events': 'none' })
  }

  // 2) NORMAL visible (hover/selected)
  for (const w of normals) {
    const isSelected = w.id && w.id === state.selectedWallId
    const isHovered = !isSelected && w.id && w.id === state.hoverWallId

    let stroke = NOR_COLOR
    let strokeWidth = NOR_W
    let opacity = 1

    if (isHovered) {
      stroke = SELECT_COLOR
      strokeWidth = NOR_W + 2
      opacity = 0.95
    }
    if (isSelected) {
      stroke = SELECT_COLOR
      strokeWidth = NOR_W + 4
      opacity = 1
    }

    wallsG
      .line(w.a.x, w.a.y, w.b.x, w.b.y)
      .stroke({
        width: strokeWidth,
        color: stroke,
        opacity,
        linecap: 'butt',
        linejoin: 'round',
      })
      .attr({ 'pointer-events': 'none' })
  }

  // HIT lines (separate pass)
  for (const w of normals) {
    if (!w.id) continue

    wallsG
      .line(w.a.x, w.a.y, w.b.x, w.b.y)
      .stroke({
        width: Math.max(22, NOR_W + 16),
        color: '#000',
        opacity: 0,
        linecap: 'round',
      })
      .attr({
        'pointer-events': 'stroke',
        'data-kind': 'normal',
        'data-wall-id': w.id,
      })
  }

  // 3) nodes for NORMAL (close gaps)
  const degree = new Map()
  for (const w of normals) {
    const ka = keyOf(w.a)
    const kb = keyOf(w.b)
    degree.set(ka, (degree.get(ka) || 0) + 1)
    degree.set(kb, (degree.get(kb) || 0) + 1)
  }

  const drawn = new Set()
  const nodeSize = NOR_W
  for (const w of normals) {
    for (const p of [w.a, w.b]) {
      const k = keyOf(p)
      if ((degree.get(k) || 0) < 2) continue
      if (drawn.has(k)) continue
      drawn.add(k)

      wallsG
        .rect(nodeSize, nodeSize)
        .center(p.x, p.y)
        .fill(NOR_COLOR)
        .radius(2)
        .attr({ 'pointer-events': 'none' })
    }
  }

  // 4) selected highlight + handles
  if (state.selectedWallId) {
    const w = normals.find(x => x.id === state.selectedWallId)
    if (w) {
      wallsG
        .line(w.a.x, w.a.y, w.b.x, w.b.y)
        .stroke({
          width: NOR_W + 6,
          color: SELECT_COLOR,
          opacity: 0.35,
          linecap: 'butt',
          linejoin: 'round',
        })
        .attr({ 'pointer-events': 'none' })

      const r = 12
      wallsG
        .circle(r * 2)
        .center(w.a.x, w.a.y)
        .fill('#fff')
        .stroke({ width: 3, color: SELECT_COLOR })
        .attr({ 'pointer-events': 'none' })

      wallsG
        .circle(r * 2)
        .center(w.b.x, w.b.y)
        .fill('#fff')
        .stroke({ width: 3, color: SELECT_COLOR })
        .attr({ 'pointer-events': 'none' })
    }
  }

  // ---------- SNAP PULSE ----------
  {
    const sp = state.ui?.snapPulse
    if (sp && Number.isFinite(sp.x) && Number.isFinite(sp.y)) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const t0 = sp.t ?? now
      const dt = now - t0

      if (dt < 350) {
        const k = dt / 350
        const r = (6 + 10 * k) * invScale
        const opacity = 0.55 * (1 - k)

        overlayG
          .circle(r * 2)
          .center(sp.x, sp.y)
          .fill({ color: '#000', opacity: 0 })
          .stroke({ width: 2 * invScale, color: SELECT_COLOR, opacity })
          .attr({ 'pointer-events': 'none' })

        overlayG
          .circle(3 * invScale * 2)
          .center(sp.x, sp.y)
          .fill({ color: SELECT_COLOR, opacity: 0.9 })
          .attr({ 'pointer-events': 'none' })
      }
    }
  }

  // ---------- DIMENSIONS ----------
  dimsG.attr({ 'pointer-events': 'none' })

  const fontSize = 12 * invScale
  const pad = 3 * invScale
  // 1) length label for each wall
const capCentroid = getCapitalsCentroid(walls)

for (const w of walls) {
  const posA = w.a
  const posB = w.b

  // длина — по строительной геометрии
  let lenA, lenB
  if (w.kind !== 'capital') {
    lenA = w.va || w.a
    lenB = w.vb || w.b
  } else {
    lenA = w.ia || w.a
    lenB = w.ib || w.b
  }

  const lenUnits = Math.hypot(lenB.x - lenA.x, lenB.y - lenA.y)
  const lenM = unitsToMeters(lenUnits)
  const txt = formatMeters(lenM)

  // позиция подписи — по ВИДИМОЙ геометрии (posA/posB)
  const mid = midPoint(posA, posB)
  const ang = readableRotation(angleDeg(posA, posB))

  let nx, ny
  if (w.kind === 'capital') {
    ({ nx, ny } = outwardNormal(posA, posB, capCentroid)) // ✅ наружу
  } else {
    ({ nx, ny } = unitNormal(posA, posB))
  }

 const offsetFromWall =
  (w.kind === 'capital' ? (CAP_W / 2 + 14) : 14) * invScale

  const lx = mid.x + nx * offsetFromWall
  const ly = mid.y + ny * offsetFromWall

  const isSelected = w.id && w.id === state.selectedWallId
  const fillText = isSelected ? SELECT_COLOR : DIM_COLOR

  const t = dimsG.text(txt)
  t.font({ size: fontSize, family: 'system-ui, -apple-system, Segoe UI, Roboto, Arial' })
  t.fill(fillText)

  const bb = t.bbox()
  const bg = dimsG
    .rect(bb.width + pad * 2, bb.height + pad * 2)
    .fill({ color: DIM_BG, opacity: DIM_BG_OPACITY })
    .radius(3 * invScale)

  const g = dimsG.group()
  g.add(bg)
  g.add(t)

  bg.move(lx - bb.width / 2 - pad, ly - bb.height / 2 - pad)
  t.center(lx, ly)

  g.rotate(ang, lx, ly)
}


  // 2) "inside box" label
  {
    const bb = getCapitalBBox(walls)
    if (bb) {
      const Wm = unitsToMeters(bb.maxX - bb.minX)
      const Hm = unitsToMeters(bb.maxY - bb.minY)

      const label = `Коробка: ${Wm.toFixed(2)} × ${Hm.toFixed(2)} м`

      const fontSize2 = 13 * invScale
      const pad2 = 4 * invScale
      const rx = 6 * invScale

      const cx = (bb.minX + bb.maxX) / 2
      const y = bb.minY - 70 * invScale

      const g = dimsG.group()

      const t = g.text(label)
      t.font({
        size: fontSize2,
        family: 'system-ui, -apple-system, Segoe UI, Roboto, Arial',
        weight: 600,
      })
      t.fill('#111')

      const tb = t.bbox()
      const bg = g
        .rect(tb.width + pad2 * 2, tb.height + pad2 * 2)
        .fill({ color: '#fff', opacity: 0.9 })
        .radius(rx)

      bg.center(cx, y)
      t.center(cx, y)
      bg.back()
    }
  }

  // ---------- draft / preview ----------
  if (state.draft) {
    const { a, b } = state.draft
    overlayG.line(a.x, a.y, b.x, b.y).stroke({
      width: 6,
      color: SELECT_COLOR,
      dasharray: '10 8',
      linecap: 'round',
    })
  }

  if (state.previewWall) {
    const { a, b, ok } = state.previewWall
    overlayG.line(a.x, a.y, b.x, b.y).stroke({
      width: 6,
      color: ok ? SELECT_COLOR : CURSOR_INVALID,
      dasharray: '10 8',
      linecap: 'round',
    })
  }

  // ---------- CURSOR DOT ----------
  if (
    state.mode === 'draw-wall' &&
    state.snapPoint &&
    Number.isFinite(state.snapPoint.x) &&
    Number.isFinite(state.snapPoint.y)
  ) {
    const cs = state.cursorState || 'idle'
    const color = cs === 'valid' ? SELECT_COLOR : cs === 'invalid' ? CURSOR_INVALID : CURSOR_IDLE

    const r = 6 * invScale
    const strokeW = 2 * invScale

    overlayG
      .circle(r * 2 + strokeW * 2)
      .center(state.snapPoint.x, state.snapPoint.y)
      .fill({ color: '#fff', opacity: 0.9 })
      .stroke({ width: 0 })
      .attr({ 'pointer-events': 'none' })

    overlayG
      .circle(r * 2)
      .center(state.snapPoint.x, state.snapPoint.y)
      .fill({ color, opacity: 0.95 })
      .stroke({ width: strokeW, color: '#fff', opacity: 0.9 })
      .attr({ 'pointer-events': 'none' })
  }
}



