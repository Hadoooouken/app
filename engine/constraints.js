// engine/constraints.js
import { state } from './state.js'
import { config, CLEAR_FROM_CAPITAL } from './config.js'

const EPS = 1e-9

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
    toNormals = true, // T-стык к normal сегментам
    tGuard = config.snap.tGuard, // не липнуть к самым концам normal
  } = opts

  const scale = Math.max(1e-6, state.view.scale)
  const snapWorld = snapPx / scale
  const axisWorld = axisPx / scale

  let best = { ...p }
  let bestDist = Infinity
  let snapped = false

  const consider = (q) => {
    const d = dist(p, q)
    if (d < bestDist && d <= snapWorld) {
      best = { ...q }
      bestDist = d
      snapped = true
    }
  }

  // 1) grid
  if (toGrid && grid > 0) {
    consider({
      x: Math.round(p.x / grid) * grid,
      y: Math.round(p.y / grid) * grid,
    })
  }

  // 2) точки (концы всех стен)
  if (toPoints) {
    for (const q of collectSnapPoints()) consider(q)
  }

  // 3) axis (если есть fromPoint)
  if (toAxis && fromPoint) {
    // если включена сетка — свободную координату тоже к сетке
    const snapY = (toGrid && grid > 0) ? (Math.round(p.y / grid) * grid) : p.y
    const snapX = (toGrid && grid > 0) ? (Math.round(p.x / grid) * grid) : p.x

    if (Math.abs(p.x - fromPoint.x) <= axisWorld) consider({ x: fromPoint.x, y: snapY })
    if (Math.abs(p.y - fromPoint.y) <= axisWorld) consider({ x: snapX, y: fromPoint.y })
  }

  // 4) T-стык: проекция на normal сегменты (только внутренняя часть)
  if (toNormals) {
    const hit = snapPointToNormalSegments(best, { tolWorld: snapWorld, guardT: tGuard })
    if (hit) {
      best = hit
      snapped = true
    }
  }

  // 5) прилипаем к капитальным — ПРОЕКЦИЯ на ближайший capital сегмент
  if (toCapital) {
    const hit = snapPointToCapitalSegments(best, snapWorld)
    if (hit) {
      best = hit
      snapped = true
    }
  }

  // snap pulse для рендера
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
  for (const w of (state.walls || [])) {
    if (!w) continue

    // capital — как есть (в будущем можно заменить на ia/ib)
    if (w.kind === 'capital') {
      pts.push(w.a, w.b)
      continue
    }

    // normal — добавляем и видимые, и строительные точки
    const a = w.a
    const b = w.b
    const va = w.va || w.a
    const vb = w.vb || w.b

    pts.push(a, b, va, vb)
  }
  return pts
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// ---------------- T SNAP TO NORMAL SEGMENTS ----------------

// проекция точки p на отрезок a-b: {point, t, d}
function projectPointToSegment(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y
  const apx = p.x - a.x, apy = p.y - a.y
  const ab2 = abx * abx + aby * aby
  if (ab2 < EPS) {
    const d = Math.hypot(p.x - a.x, p.y - a.y)
    return { point: { ...a }, t: 0, d }
  }
  let t = (apx * abx + apy * aby) / ab2
  t = Math.max(0, Math.min(1, t))
  const q = { x: a.x + abx * t, y: a.y + aby * t }
  const d = Math.hypot(p.x - q.x, p.y - q.y)
  return { point: q, t, d }
}

// вернуть point если в радиусе и НЕ около концов, иначе null
function snapPointToNormalSegments(p, { tolWorld, guardT = 0.08 } = {}) {
  let best = null
  let bestD = Infinity

  for (const w of (state.walls || [])) {
    if (!w || w.kind === 'capital') continue

    // ✅ лучше брать строительную ось
    const a = w.va || w.a
    const b = w.vb || w.b

    const pr = projectPointToSegment(p, a, b)
    if (pr.d > tolWorld) continue

    // если почти у конца — это не T, а узел (пусть toPoints решает)
    if (pr.t <= guardT || pr.t >= (1 - guardT)) continue

    if (pr.d < bestD) {
      bestD = pr.d
      best = pr.point
    }
  }

  return best
}

// ---------------- SNAP TO CAPITAL SEGMENTS (projection) ----------------

function projectPointToSegmentClamped(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y
  const apx = p.x - a.x, apy = p.y - a.y
  const ab2 = abx * abx + aby * aby
  if (ab2 < EPS) return { point: { ...a }, t: 0 }

  let t = (apx * abx + apy * aby) / ab2
  t = Math.max(0, Math.min(1, t))
  return { point: { x: a.x + abx * t, y: a.y + aby * t }, t }
}

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

// ---------------- SEGMENT INTERSECTION HELPERS ----------------

// null | {type:'point', t,u,p} | {type:'overlap', overlapLen}
function segmentIntersectionParams(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y }
  const s = { x: d.x - c.x, y: d.y - c.y }
  const denom = cross(r, s)

  const ca = { x: c.x - a.x, y: c.y - a.y }

  // параллельны
  if (Math.abs(denom) < 1e-12) {
    // не коллинеарны
    if (Math.abs(cross(ca, r)) > 1e-9) return null

    const rr = r.x * r.x + r.y * r.y
    if (rr < EPS) return null

    const t0 = dot(c.x - a.x, c.y - a.y, r.x, r.y) / rr
    const t1 = dot(d.x - a.x, d.y - a.y, r.x, r.y) / rr
    const lo = Math.max(0, Math.min(t0, t1))
    const hi = Math.min(1, Math.max(t0, t1))

    if (hi < lo) return null

    const overlapLen = Math.hypot(r.x, r.y) * (hi - lo)
    if (overlapLen < 1e-9) return null

    return { type: 'overlap', overlapLen }
  }

  const t = cross(ca, s) / denom
  const u = cross(ca, r) / denom

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    const p = { x: a.x + t * r.x, y: a.y + t * r.y }
    return { type: 'point', t, u, p }
  }

  return null
}

function cross(v, w) {
  return v.x * w.y - v.y * w.x
}
function dot(ax, ay, bx, by) {
  return ax * bx + ay * by
}