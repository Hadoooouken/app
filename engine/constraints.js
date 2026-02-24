// engine/constraints.js
import { state } from './state.js'
import { config, CLEAR_FROM_CAPITAL } from './config.js'
import {
  dist,
  projectPointToSegment,
  projectPointToSegmentClamped,
  segmentIntersectionParams,
} from './geom.js'

// ---------------- SNAP ----------------

export function smartSnapPoint(p, fromPoint, opts = {}) {
  const {
    grid = config.grid.snapStep,
    snapPx = config.snap.edit.snapPx,
    axisPx = config.snap.edit.axisPx,
    toGrid = true,
    toPoints = true,
    toAxis = true,
    toCapital = true,
    toNormals = true,
    tGuard = config.snap.tGuard,
  } = opts

  const scale = Math.max(1e-6, state.view.scale)
  const snapWorld = snapPx / scale
  const axisWorld = axisPx / scale

  let best = { ...p }
  let bestDist = Infinity
  let bestKind = null
  let snapped = false

  const prioOf = (kind) => {
    switch (kind) {
      case 'point': return 5
      case 'normal': return 4
      case 'axis': return 3
      case 'grid': return 2
      case 'capital': return 1
      default: return 0
    }
  }

  const consider = (q, kind) => {
    const d = dist(p, q) // расстояние ВСЕГДА от исходной p
    if (d > snapWorld) return

    const pr = prioOf(kind)
    const bestPr = prioOf(bestKind)

    // приоритет важнее расстояния, иначе capital/normal перебивают точку стены
    if (!snapped || pr > bestPr || (pr === bestPr && d < bestDist)) {
      best = { ...q }
      bestDist = d
      bestKind = kind
      snapped = true
    }
  }

  // 1) grid
  if (toGrid && grid > 0) {
    consider({
      x: Math.round(p.x / grid) * grid,
      y: Math.round(p.y / grid) * grid,
    }, 'grid')
  }

  // 2) точки (концы всех стен) — ВАЖНО: только видимые a/b (см. collectSnapPoints ниже)
  if (toPoints) {
    for (const q of collectSnapPoints()) consider(q, 'point')
  }

  // 3) axis
  if (toAxis && fromPoint) {
    const snapY = (toGrid && grid > 0) ? (Math.round(p.y / grid) * grid) : p.y
    const snapX = (toGrid && grid > 0) ? (Math.round(p.x / grid) * grid) : p.x

    if (Math.abs(p.x - fromPoint.x) <= axisWorld) consider({ x: fromPoint.x, y: snapY }, 'axis')
    if (Math.abs(p.y - fromPoint.y) <= axisWorld) consider({ x: snapX, y: fromPoint.y }, 'axis')
  }

  // 4) T-снап к normal (квантуем по глобальной сетке 25см)
  if (toNormals) {
    const hit = snapPointToNormalSegments(p, {
      tolWorld: snapWorld,
      guardT: tGuard,
      stepWorld: (toGrid && grid > 0) ? grid : 0,
    })
    if (hit) consider(hit, 'normal')
  }

  // 5) capital — самый низкий приоритет, чтобы НЕ ломал стыки normal-normal
  if (toCapital) {
    const hit = snapPointToCapitalSegments(p, snapWorld)
    if (hit) consider(hit, 'capital')
  }

  state.ui = state.ui || {}
  if (snapped) {
    state.ui.snapPulse = {
      x: best.x,
      y: best.y,
      t: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    }
  } else {
    state.ui.snapPulse = null
  }

  return best
}

function collectSnapPoints() {
  const pts = []
  const step = config.grid.snapStep // 25см
  const seen = new Set()
  const key = (p) => `${Math.round(p.x * 1000)}:${Math.round(p.y * 1000)}`
  const push = (p) => {
    const k = key(p)
    if (seen.has(k)) return
    seen.add(k)
    pts.push({ x: p.x, y: p.y })
  }

  const EPS_AXIS = 1e-6

  const addStepPoints = (a, b) => {
    const dx = b.x - a.x
    const dy = b.y - a.y

    // горизонтальная
    if (Math.abs(dy) < EPS_AXIS) {
      const y = a.y
      const x0 = Math.min(a.x, b.x)
      const x1 = Math.max(a.x, b.x)

      // точки по ГЛОБАЛЬНОЙ сетке, которые лежат на отрезке
      const start = Math.ceil(x0 / step) * step
      const end = Math.floor(x1 / step) * step

      for (let x = start; x <= end; x += step) push({ x, y })
      return
    }

    // вертикальная
    if (Math.abs(dx) < EPS_AXIS) {
      const x = a.x
      const y0 = Math.min(a.y, b.y)
      const y1 = Math.max(a.y, b.y)

      const start = Math.ceil(y0 / step) * step
      const end = Math.floor(y1 / step) * step

      for (let y = start; y <= end; y += step) push({ x, y })
      return
    }

    // если вдруг диагональ — просто не добавляем шаговые точки
  }

  for (const w of (state.walls || [])) {
    if (!w) continue

    // capital — только концы
    if (w.kind === 'capital') {
      push(w.a); push(w.b)
      continue
    }

    // normal — ВИДИМЫЕ концы (a/b) + точки каждые 25см вдоль стены
    push(w.a); push(w.b)
    addStepPoints(w.a, w.b)
  }

  return pts
}

// ✅ normal: ТОЛЬКО ВИДИМЫЕ концы
// иначе ты липнешь к va/vb (ось ка

// ---------------- T SNAP TO NORMAL SEGMENTS ----------------

// вернуть point если в радиусе и НЕ около концов, иначе null
function snapPointToNormalSegments(p, { tolWorld, guardT = 0.08, stepWorld = 0 } = {}) {
  let best = null
  let bestD = Infinity

  for (const w of (state.walls || [])) {
    if (!w || w.kind === 'capital') continue

    const a = w.va || w.a
    const b = w.vb || w.b

    const pr = projectPointToSegment(p, a, b) // {point,t,d}
    if (pr.d > tolWorld) continue
    if (pr.t <= guardT || pr.t >= (1 - guardT)) continue

    let q = pr.point

    if (stepWorld > 0) {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const adx = Math.abs(dx)
      const ady = Math.abs(dy)

      // ✅ если почти вертикальная
      if (ady >= adx) {
        const yQ = Math.round(q.y / stepWorld) * stepWorld
        let tQ = (Math.abs(dy) < 1e-9) ? pr.t : (yQ - a.y) / dy
        tQ = Math.max(guardT, Math.min(1 - guardT, tQ))
        q = { x: a.x + dx * tQ, y: a.y + dy * tQ }
      } else {
        // ✅ почти горизонтальная
        const xQ = Math.round(q.x / stepWorld) * stepWorld
        let tQ = (Math.abs(dx) < 1e-9) ? pr.t : (xQ - a.x) / dx
        tQ = Math.max(guardT, Math.min(1 - guardT, tQ))
        q = { x: a.x + dx * tQ, y: a.y + dy * tQ }
      }
    }

    const d = dist(p, q)
    if (d < bestD) {
      bestD = d
      best = q
    }
  }

  return best
}

// ---------------- SNAP TO CAPITAL SEGMENTS (projection) ----------------

function snapPointToCapitalSegments(p, tolWorld) {
  const caps = (state.walls || []).filter(w => w && w.kind === 'capital')
  if (!caps.length) return null

  let best = null
  let bestD = Infinity

  for (const c of caps) {
    // (в будущем можно заменить на ia/ib)
    const pr = projectPointToSegmentClamped(p, c.a, c.b)
    const d = Math.hypot(p.x - pr.point.x, p.y - pr.point.y)
    if (d <= tolWorld && d < bestD) {
      bestD = d
      best = pr.point
    }
  }

  return best
}

// ---------------- LIMITS + NO X-INTERSECTIONS ----------------

let cachedKey = ''
let cachedPoly = null

/**
 * Проверка:
 * 1) сегмент внутри полигона капитальных (включая границу)
 * 2) сегмент НЕ делает X-пересечений с normal стенами
 *
 * opts:
 *  - ignoreWallId: не проверять пересечения с этой стеной (при переносе/ресайзе)
 *  - tolPx: “толщина” допуска в пикселях (переводим в world через scale)
 */
export function isSegmentAllowed(a, b, opts = {}) {
  const { ignoreWallId = null, tolPx = 2 } = opts

  const scale = Math.max(1e-6, state.view.scale)

  // 1) внутри капитального контура (если он есть) — граница тоже ок
  const poly = getCapitalPolygon()
  if (poly && poly.length >= 3) {
    const boundaryTolWorld = tolPx / scale

    if (!pointInPolyInclusive(a, poly, boundaryTolWorld)) return false
    if (!pointInPolyInclusive(b, poly, boundaryTolWorld)) return false

    // проверим несколько точек внутри сегмента
    const steps = 24
    for (let i = 1; i < steps; i++) {
      const t = i / steps
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      if (!pointInPolyInclusive(p, poly, boundaryTolWorld)) return false
    }
  }

  // 2) запрет пересечений (normal-normal)
  const tolWorld = tolPx / scale

  for (const w of (state.walls || [])) {
    if (!w) continue
    if (w.kind === 'capital') continue
    if (ignoreWallId && w.id === ignoreWallId) continue

    // ✅ для normal берём строительную ось (если есть)
    const wa = w.va || w.a
    const wb = w.vb || w.b

    const hit = segmentIntersectionParams(a, b, wa, wb)
    if (!hit) continue

    // коллинеарное наложение — запретим, если оно "заметное"
    if (hit.type === 'overlap') {
      if (hit.overlapLen > tolWorld) return false
      continue
    }

    // ✅ точечное пересечение
    const ip = hit.p

    // ✅ если пересечение рядом с концом НОВОГО сегмента — разрешаем (стык)
    const nearNewA = Math.hypot(ip.x - a.x, ip.y - a.y) <= tolWorld
    const nearNewB = Math.hypot(ip.x - b.x, ip.y - b.y) <= tolWorld
    if (nearNewA || nearNewB) continue

    // ✅ НОВОЕ: если пересечение рядом с концом СУЩЕСТВУЮЩЕЙ стены — ТОЖЕ разрешаем
    const nearOldA = Math.hypot(ip.x - wa.x, ip.y - wa.y) <= tolWorld
    const nearOldB = Math.hypot(ip.x - wb.x, ip.y - wb.y) <= tolWorld
    if (nearOldA || nearOldB) continue

    // ❌ иначе новый сегмент пересёк существующую стену "внутри себя"
    return false
  }

  return true
}

// ✅ запрет “утопить” normal в capital: проверяем, что внутренняя часть сегмента
// держится минимум на clearWorld от капитальных сегментов.
// (концы мы допускаем близко/на капитальной — там у нас trim)
export function isSegmentClearOfCapitals(a, b, clearWorld = CLEAR_FROM_CAPITAL(), opts = {}) {
  const { endGuard = 0.06, samples = 24 } = opts
  const caps = (state.walls || []).filter(w => w && w.kind === 'capital')
  if (!caps.length) return true

  // если clearWorld <= 0 — нечего проверять
  if (!Number.isFinite(clearWorld) || clearWorld <= 0) return true

  for (let i = 0; i <= samples; i++) {
    const t = i / samples

    // не проверяем около концов (иначе нельзя будет "пристыковать")
    if (t <= endGuard || t >= (1 - endGuard)) continue

    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }

    // расстояние до ближайшей capital оси
    let bestD = Infinity
    for (const c of caps) {
      const pr = projectPointToSegmentClamped(p, c.a, c.b)
      const d = Math.hypot(p.x - pr.point.x, p.y - pr.point.y)
      if (d < bestD) bestD = d
    }

    // если внутренняя часть сегмента зашла слишком близко к капитальной оси — запрещаем
    if (bestD < clearWorld) return false
  }

  return true
}

function getCapitalPolygon() {
  const caps = (state.walls || []).filter(w => w && w.kind === 'capital')
  if (caps.length < 3) return null

  const key = caps.map(w => `${w.a.x},${w.a.y}-${w.b.x},${w.b.y}`).join('|')
  if (key === cachedKey && cachedPoly) return cachedPoly
  cachedKey = key

  const poly = buildLoopFromSegments(caps)
  cachedPoly = (poly && poly.length >= 3) ? poly : fallbackBBoxPoly(caps)
  return cachedPoly
}

function buildLoopFromSegments(segments) {
  const map = new Map()
  const k = (p) => `${p.x}:${p.y}`

  const add = (p, q) => {
    const key = k(p)
    if (!map.has(key)) map.set(key, { p, n: [] })
    map.get(key).n.push(q)
  }

  for (const s of segments) {
    add(s.a, s.b)
    add(s.b, s.a)
  }

  const first = segments[0].a
  const firstK = k(first)

  const loop = [{ ...first }]
  let curr = first
  let prev = null

  for (let guard = 0; guard < 5000; guard++) {
    const node = map.get(k(curr))
    if (!node) return null

    // выбираем соседа, который не "назад"
    const next = node.n.find(x => !prev || x.x !== prev.x || x.y !== prev.y)
    if (!next) return null

    prev = curr
    curr = next

    if (k(curr) === firstK) break
    loop.push({ ...curr })
  }

  return loop
}

function fallbackBBoxPoly(segments) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const w of segments) {
    minX = Math.min(minX, w.a.x, w.b.x)
    minY = Math.min(minY, w.a.y, w.b.y)
    maxX = Math.max(maxX, w.a.x, w.b.x)
    maxY = Math.max(maxY, w.a.y, w.b.y)
  }
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
}

// ✅ IMPORTANT: "внутри" включая границу
function pointInPolyInclusive(p, poly, tolWorld) {
  const tol2 = tolWorld * tolWorld

  // 1) если точка на ребре — считаем внутри
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const pr = projectPointToSegmentClamped(p, a, b)
    const dx = p.x - pr.point.x
    const dy = p.y - pr.point.y
    if ((dx * dx + dy * dy) <= tol2) return true
  }

  // 2) ray casting
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y
    const xj = poly[j].x, yj = poly[j].y

    const intersect =
      ((yi > p.y) !== (yj > p.y)) &&
      (p.x <= ((xj - xi) * (p.y - yi)) / Math.max(1e-12, (yj - yi)) + xi)

    if (intersect) inside = !inside
  }
  return inside
}