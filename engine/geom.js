// engine/geom.js  (ЕДИНАЯ ГЕОМЕТРИЯ НА {x,y})

export const EPS = 1e-9

export function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y)
}

export function distPointToPoint(p, q) {
    return Math.hypot(p.x - q.x, p.y - q.y)
}

export function dot(ax, ay, bx, by) {
    return ax * bx + ay * by
}

export function cross(v, w) {
    return v.x * w.y - v.y * w.x
}

// Проекция точки p на отрезок a-b (с clamped t в [0..1])
// Возвращает { point, t, d }
export function projectPointToSegmentClamped(p, a, b) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lenSq = dx * dx + dy * dy

    if (lenSq < EPS) {
        const point = { x: a.x, y: a.y }
        return { point, t: 0, d: dist(p, point) }
    }

    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
    t = Math.max(0, Math.min(1, t))

    const point = { x: a.x + t * dx, y: a.y + t * dy }
    return { point, t, d: dist(p, point) }
}

export function distPointToSegment(p, a, b) {
    const { point } = projectPointToSegmentClamped(p, a, b)
    return dist(p, point)
}

export function isPointInPolygon(p, poly) {
    // poly: Array<{x,y}>
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y
        const xj = poly[j].x, yj = poly[j].y

        const intersect =
            ((yi > p.y) !== (yj > p.y)) &&
            (p.x < (xj - xi) * (p.y - yi) / (Math.max(EPS, (yj - yi))) + xi)

        if (intersect) inside = !inside
    }
    return inside
}

// Магнит к контуру (ближайшая точка на ребре полигона)
export function snapToContour(p, poly, tolWorld = 8) {
    let best = { x: p.x, y: p.y }
    let bestD = Infinity

    for (let i = 0; i < poly.length; i++) {
        const a = poly[i]
        const b = poly[(i + 1) % poly.length]
        const { point } = projectPointToSegmentClamped(p, a, b)
        const d = dist(p, point)
        if (d < bestD) {
            bestD = d
            best = point
        }
    }

    return bestD <= tolWorld ? best : p
}

export function snapToPoints(p, points, tolWorld = 10) {
    let best = p
    let bestD = Infinity
    for (const q of points) {
        const d = dist(p, q)
        if (d < bestD) {
            bestD = d
            best = q
        }
    }
    return bestD <= tolWorld ? { x: best.x, y: best.y } : p
}

// Магнит к сегментам (проекция на отрезки)
// opts.guardT — защита от прилипания к концам (например 0.08)
export function snapToSegments(p, segments, tolWorld = 10, opts = {}) {
    const { guardT = 0 } = opts

    let best = p
    let bestD = Infinity

    for (const seg of segments) {
        const pr = projectPointToSegmentClamped(p, seg.a, seg.b)

        if (guardT && (pr.t <= guardT || pr.t >= (1 - guardT))) continue

        const d = pr.d
        if (d < bestD) {
            bestD = d
            best = pr.point
        }
    }
    return bestD <= tolWorld ? best : p
}

// Пересечение сегментов (параметры)
// Возвращает:
// - null (нет пересечения)
// - { type:'point', t, u, p } (пересеклись в точке)
// - { type:'overlap', overlapLen } (коллинеарное наложение)
export function segmentIntersectionParams(a, b, c, d) {
    const r = { x: b.x - a.x, y: b.y - a.y }
    const s = { x: d.x - c.x, y: d.y - c.y }
    const denom = cross(r, s)
    const ca = { x: c.x - a.x, y: c.y - a.y }

    // параллельны
    if (Math.abs(denom) < 1e-12) {
        // не коллинеарны
        if (Math.abs(cross(ca, r)) > 1e-9) return null

        // коллинеарны -> наложение
        const rr = r.x * r.x + r.y * r.y
        if (rr < EPS) return null

        const t0 = dot(c.x - a.x, c.y - a.y, r.x, r.y) / rr
        const t1 = dot(d.x - a.x, d.y - a.y, r.x, r.y) / rr
        const lo = Math.max(0, Math.min(t0, t1))
        const hi = Math.min(1, Math.max(t0, t1))
        if (hi < lo) return null

        const overlapLen = Math.hypot(r.x, r.y) * (hi - lo)
        if (overlapLen < 1e-9) return null // касание концами

        return { type: 'overlap', overlapLen }
    }

    const t = cross(ca, s) / denom
    const u = cross(ca, r) / denom

    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        return { type: 'point', t, u, p: { x: a.x + t * r.x, y: a.y + t * r.y } }
    }

    return null
}

export function segmentIntersectionPoint(a, b, c, d) {
    const hit = segmentIntersectionParams(a, b, c, d)
    return hit && hit.type === 'point' ? hit.p : null
}

// Алиас для удобства (в других модулях может называться без "Clamped")
// Возвращает { point, t, d }
export function projectPointToSegment(p, a, b) {
    return projectPointToSegmentClamped(p, a, b)
}

// engine/geom.js additions

export function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v))
}

// обычный ray casting (без "inclusive")
export function pointInPoly(p, poly) {
    return isPointInPolygon(p, poly)
}

// точка на отрезке (inclusive) через проекцию
export function pointOnSegment(p, a, b, tol = 0.5) {
    const pr = projectPointToSegmentClamped(p, a, b)
    return pr.d <= tol && pr.t >= -1e-6 && pr.t <= 1 + 1e-6
}