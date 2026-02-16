// renderer/render.js
import { state, UNITS_PER_M } from '../engine/state.js'
import { wallLengthUnits } from '../engine/metrics.js'

const CAP_W = 28
const NOR_W = 10

const CAP_COLOR = '#111'
const NOR_COLOR = '#343938'
const SELECT_COLOR = '#0a84ff'

// размеры
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

// чтобы текст НЕ был вверх ногами
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

function getCapitalBBox(walls) {
  const caps = walls.filter(w => w.kind === 'capital')
  if (!caps.length) return null

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity

  for (const w of caps) {
    minX = Math.min(minX, w.a.x, w.b.x)
    minY = Math.min(minY, w.a.y, w.b.y)
    maxX = Math.max(maxX, w.a.x, w.b.x)
    maxY = Math.max(maxY, w.a.y, w.b.y)
  }

  return { minX, minY, maxX, maxY }
}

export function fitToWalls(draw, opts = {}) {
  const { padding = 180, maxScale = 1.4, minScale = 0.15 } = opts

  const walls = state.walls || []
  if (!draw || walls.length === 0) return

  const caps = walls.filter(w => w.kind === 'capital')
  const list = caps.length ? caps : walls

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity

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

export function render(draw) {
  draw.clear()

  const scene = draw.group().id('scene')
  scene.transform({
    translateX: state.view.offsetX,
    translateY: state.view.offsetY,
    scale: state.view.scale,
  })

  // GRID
  const grid = scene.group().id('grid')
  const step = 100
  const size = 8000
  for (let x = -size; x <= size; x += step) {
    grid.line(x, -size, x, size).stroke({ width: 1, color: '#e3dfd7' })
  }
  for (let y = -size; y <= size; y += step) {
    grid.line(-size, y, size, y).stroke({ width: 1, color: '#e3dfd7' })
  }

  const wallsG = scene.group().id('walls')

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

  // 2) NORMAL + hit lines
  for (const w of normals) {
    // visible
    wallsG
      .line(w.a.x, w.a.y, w.b.x, w.b.y)
      .stroke({
        width: NOR_W,
        color: NOR_COLOR,
        linecap: 'butt',
        linejoin: 'round',
      })
      .attr({ 'pointer-events': 'none' })

    // hit (только если есть id)
    if (w.id) {
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

      // circle(size) — ДИАМЕТР
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

  // ---------- SNAP PULSE (кружок "магнит") ----------
  {
    const sp = state.ui?.snapPulse
    if (sp && Number.isFinite(sp.x) && Number.isFinite(sp.y)) {
      const invScale = 1 / Math.max(1e-6, state.view.scale)
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const t0 = sp.t ?? now
      const dt = now - t0

      // живет ~350мс
      if (dt < 350) {
        const k = dt / 350
        const r = (6 + 10 * k) * invScale
        const opacity = 0.55 * (1 - k)

        wallsG
          .circle(r * 2)
          .center(sp.x, sp.y)
          .fill({ color: '#000', opacity: 0 })
          .stroke({ width: 2 * invScale, color: SELECT_COLOR, opacity })
          .attr({ 'pointer-events': 'none' })

        wallsG
          .circle(3 * invScale * 2)
          .center(sp.x, sp.y)
          .fill({ color: SELECT_COLOR, opacity: 0.9 })
          .attr({ 'pointer-events': 'none' })
      }
    }
  }

  // ---------- DIMENSIONS ----------
  const dimsG = scene.group().id('dims')
  dimsG.attr({ 'pointer-events': 'none' })

  const invScale = 1 / Math.max(1e-6, state.view.scale)
  const fontSize = 12 * invScale
  const pad = 3 * invScale

  // 1) подписи длины каждой стены
  for (const w of walls) {
    // (если не хочешь размеры для всех — можно ограничить: if (w.kind==='capital') continue
    const lenM = unitsToMeters(wallLengthUnits(w))
    const txt = formatMeters(lenM)

    const mid = midPoint(w.a, w.b)
    const ang = readableRotation(angleDeg(w.a, w.b))
    const { nx, ny } = unitNormal(w.a, w.b)

    // для capital дальше от линии
    const offsetFromWall = (w.kind === 'capital' ? 24 : 14) * invScale

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

  // 2) габариты коробки (bbox по capital)
  const capBB = getCapitalBBox(walls)
  if (capBB) {
    const Wm = unitsToMeters(capBB.maxX - capBB.minX)
    const Hm = unitsToMeters(capBB.maxY - capBB.minY)

    const label = `Коробка: ${Wm.toFixed(2)} × ${Hm.toFixed(2)} м`
    const x = (capBB.minX + capBB.maxX) / 2
    const y = capBB.minY - 28 * invScale

    const t = dimsG.text(label)
    t.font({
      size: 13 * invScale,
      family: 'system-ui, -apple-system, Segoe UI, Roboto, Arial',
      weight: 600,
    })
    t.fill(DIM_COLOR)

    const bb = t.bbox()
    const bg = dimsG
      .rect(bb.width + pad * 2, bb.height + pad * 2)
      .fill({ color: DIM_BG, opacity: 0.9 })
      .radius(4 * invScale)

    const g = dimsG.group()
    g.add(bg)
    g.add(t)

    bg.move(x - bb.width / 2 - pad, y - bb.height / 2 - pad)
    t.center(x, y)
  }

  // ---------- draft / preview ----------
  if (state.draft) {
    const { a, b } = state.draft
    scene.line(a.x, a.y, b.x, b.y).stroke({
      width: 6,
      color: '#0a84ff',
      dasharray: '10 8',
      linecap: 'round',
    })
  }

  if (state.previewWall) {
    const { a, b, ok } = state.previewWall
    scene.line(a.x, a.y, b.x, b.y).stroke({
      width: 6,
      color: ok ? '#0a84ff' : '#ff3b30',
      dasharray: '10 8',
      linecap: 'round',
    })
  }
}
