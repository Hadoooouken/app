// engine/geom.js  (ЕДИНАЯ ГЕОМЕТРИЯ НА {x,y})

export const EPS = 1e-9

export function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y)
}

export function distPointToPoint(p, q) {
    return Math.hypot(p.x - q.x, p.y - q.y)
}

// Проекция точки p на отрезок a-b (с clamped t в [0..1])
export function projectPointToSegmentClamped(p, a, b) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    if (lenSq < EPS) return { point: { x: a.x, y: a.y }, t: 0 }

    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
    t = Math.max(0, Math.min(1, t))

    return {
        point: { x: a.x + t * dx, y: a.y + t * dy },
        t,
    }
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

export function snapToSegments(p, segments, tolWorld = 10) {
    // segments: [{a:{x,y}, b:{x,y}}]
    let best = p
    let bestD = Infinity

    for (const seg of segments) {
        const { point } = projectPointToSegmentClamped(p, seg.a, seg.b)
        const d = dist(p, point)
        if (d < bestD) {
            bestD = d
            best = point
        }
    }
    return bestD <= tolWorld ? best : p
}
