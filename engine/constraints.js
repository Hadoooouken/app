// engine/constraints.js
import { state } from './state.js'

const EPS = 1e-9

// ---------------- SNAP ----------------

export function smartSnapPoint(p, fromPoint, opts = {}) {
    const {
        grid = 50,
        snapPx = 14,
        axisPx = 10,
        toGrid = true,
        toPoints = true,
        toAxis = true,
        toCapital = true,
        toNormals = true, // T-стык к normal сегментам
        tGuard = 0.08,    // не липнуть к самым концам normal
    } = opts

    const scale = Math.max(0.0001, state.view.scale)
    const snapWorld = snapPx / scale
    const axisWorld = axisPx / scale

    let best = { ...p }
    let bestDist = Infinity

    // отметим, что реально "прилипли"
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
        if (Math.abs(p.x - fromPoint.x) <= axisWorld) consider({ x: fromPoint.x, y: p.y })
        if (Math.abs(p.y - fromPoint.y) <= axisWorld) consider({ x: p.x, y: fromPoint.y })
    }

    // 4) T-стык: проекция на normal сегменты
    if (toNormals) {
        const hit = snapPointToNormalSegments(best, {
            tolWorld: snapWorld,
            guardT: tGuard,
        })
        if (hit) {
            best = hit
            snapped = true
        }
    }

    // 5) дотяжка к капитальным (пересечение отрезка fromPoint->best с кап. стенами)
// 5) дотяжка к капитальным (проекция на ближайший капитальный сегмент)
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
        pts.push(w.a, w.b)
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

        const pr = projectPointToSegment(p, w.a, w.b)
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

// ---------------- LIMITS + NO X-INTERSECTIONS ----------------

let cachedKey = ''
let cachedPoly = null

/**
 * Проверка:
 * 1) сегмент внутри полигона капитальных
 * 2) сегмент НЕ делает X-пересечений с normal стенами
 *
 * opts:
 *  - ignoreWallId: не проверять пересечения с этой стеной (при переносе/ресайзе)
 *  - tolPx: “толщина” допуска в пикселях (переводим в world через scale)
 */
export function isSegmentAllowed(a, b, opts = {}) {
    const { ignoreWallId = null, tolPx = 2 } = opts

    // 1) внутри капитального контура (если он есть)
    const poly = getCapitalPolygon()
    if (poly && poly.length >= 3) {
        if (!pointInPoly(a, poly) || !pointInPoly(b, poly)) return false

        const steps = 24
        for (let i = 1; i < steps; i++) {
            const t = i / steps
            const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
            if (!pointInPoly(p, poly)) return false
        }
    }

    // 2) запрет X-пересечений (normal-normal)
    const tolWorld = tolPx / Math.max(1e-6, state.view.scale)

    for (const w of (state.walls || [])) {
        if (!w) continue
        if (w.kind === 'capital') continue
        if (ignoreWallId && w.id === ignoreWallId) continue

        const hit = segmentIntersectionParams(a, b, w.a, w.b)
        if (!hit) continue

        // коллинеарное наложение — запретим, если оно "заметное"
        if (hit.type === 'overlap') {
            if (hit.overlapLen > tolWorld) return false
            continue
        }

        const { t, u } = hit

        const tIsEnd = (t <= tolT(tolWorld, a, b) || t >= 1 - tolT(tolWorld, a, b))
        const uIsEnd = (u <= tolT(tolWorld, w.a, w.b) || u >= 1 - tolT(tolWorld, w.a, w.b))

        // если пересеклись “внутри-внутри” => X (запрещаем)
        if (!tIsEnd && !uIsEnd) return false
    }

    return true
}

function tolT(tolWorld, a, b) {
    const L = Math.hypot(b.x - a.x, b.y - a.y)
    if (L < EPS) return 1
    return Math.min(0.25, tolWorld / L)
}

function getCapitalPolygon() {
    const caps = (state.walls || []).filter(w => w.kind === 'capital')
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
    for (const s of segments) { add(s.a, s.b); add(s.b, s.a) }

    const first = segments[0].a
    const firstK = k(first)
    const loop = [first]
    let curr = first
    let prev = null

    for (let guard = 0; guard < 5000; guard++) {
        const node = map.get(k(curr))
        if (!node) return null
        const next = node.n.find(x => !prev || x.x !== prev.x || x.y !== prev.y)
        if (!next) return null
        prev = curr
        curr = next
        if (k(curr) === firstK) break
        loop.push(curr)
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

function pointInPoly(p, poly) {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y
        const xj = poly[j].x, yj = poly[j].y
        const intersect =
            ((yi > p.y) !== (yj > p.y)) &&
            (p.x < (xj - xi) * (p.y - yi) / (Math.max(1e-9, (yj - yi))) + xi)
        if (intersect) inside = !inside
    }
    return inside
}

// ---------------- SNAP TO CAPITAL (segment end) ----------------

function snapSegmentEndToCapital(a, b, tolWorld) {
    const caps = (state.walls || []).filter(w => w.kind === 'capital')
    if (!caps.length) return null

    let best = null
    let bestDist = Infinity

    for (const w of caps) {
        const p = segmentIntersectionPoint(a, b, w.a, w.b)
        if (!p) continue
        const d = dist(b, p)
        if (d <= tolWorld && d < bestDist) {
            best = p
            bestDist = d
        }
    }
    return best
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

function segmentIntersectionPoint(a, b, c, d) {
    const hit = segmentIntersectionParams(a, b, c, d)
    return hit && hit.type === 'point' ? hit.p : null
}

function cross(v, w) {
    return v.x * w.y - v.y * w.x
}
function dot(ax, ay, bx, by) {
    return ax * bx + ay * by
}

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
  const caps = (state.walls || []).filter(w => w.kind === 'capital')
  if (!caps.length) return null

  let best = null
  let bestD = Infinity

  for (const c of caps) {
    const pr = projectPointToSegmentClamped(p, c.a, c.b)
    const d = Math.hypot(p.x - pr.point.x, p.y - pr.point.y)
    if (d <= tolWorld && d < bestD) {
      bestD = d
      best = pr.point
    }
  }

  return best
}

export function minDistPointToCapitals(p) {
  const caps = (state.walls || []).filter(w => w && w.kind === 'capital')
  if (!caps.length) return Infinity

  let best = Infinity
  for (const c of caps) {
    const pr = projectPointToSegmentClamped(p, c.a, c.b)
    const d = Math.hypot(p.x - pr.point.x, p.y - pr.point.y)
    if (d < best) best = d
  }
  return best
}

// true если сегмент НЕ залезает в толщину капитальных стен
export function isSegmentClearOfCapitals(a, b, clearWorld, samples = 16) {
  // проверяем несколько точек по сегменту
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    if (minDistPointToCapitals(p) < clearWorld) return false
  }
  return true
}
