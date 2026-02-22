// engine/rooms.js
import { state } from './state.js'
import { config } from './config.js'
import {
    dist,
    clamp,
    projectPointToSegmentClamped,
    pointInPoly,
    pointOnSegment,
} from './geom.js'
import { getCapitalPolygon as getCapPoly } from './metrics.js'

// ---------------- utils ----------------

// ⚠️ это НЕ "численный EPS", это допуск склейки вершин/стыков в топологии.
// Сделаем чуть больше, чтобы микрозазоры/почти-стыки не плодили мусорные грани.
const NODE_EPS = Math.max(1.0, (config.grid?.snapStep ?? 25) * 0.08) // при 25см => 2см

const keyOf = (p) => `${Math.round(p.x / NODE_EPS)}:${Math.round(p.y / NODE_EPS)}`

function samePoint(a, b, eps = NODE_EPS) {
    return dist(a, b) <= eps
}

function shoelaceArea(poly) {
    // signed area
    let s = 0
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i]
        const b = poly[(i + 1) % poly.length]
        s += a.x * b.y - b.x * a.y
    }
    return s / 2
}

function polygonCentroid(poly) {
    // centroid of polygon (может быть вне для concave)
    const A = shoelaceArea(poly)
    if (Math.abs(A) < 1e-9) {
        // fallback: average
        let x = 0, y = 0
        for (const p of poly) { x += p.x; y += p.y }
        return { x: x / poly.length, y: y / poly.length }
    }
    let cx = 0, cy = 0
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i]
        const q = poly[(i + 1) % poly.length]
        const f = (p.x * q.y - q.x * p.y)
        cx += (p.x + q.x) * f
        cy += (p.y + q.y) * f
    }
    const k = 1 / (6 * A)
    return { x: cx * k, y: cy * k }
}

// bbox — нужен и для polylabel, и для fallback
function getBBox(poly) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of poly) {
        minX = Math.min(minX, p.x)
        minY = Math.min(minY, p.y)
        maxX = Math.max(maxX, p.x)
        maxY = Math.max(maxY, p.y)
    }
    return { minX, minY, maxX, maxY }
}

// ---------------- polylabel (упрощенная, но рабочая) ----------------
// Ищет точку внутри полигона, максимально удалённую от границы.
function pointToPolyDist(p, poly) {
    const inside = pointInPoly(p, poly)
    let minDist = Infinity

    for (let i = 0; i < poly.length; i++) {
        const a = poly[i]
        const b = poly[(i + 1) % poly.length]
        const pr = projectPointToSegmentClamped(p, a, b)
        minDist = Math.min(minDist, pr.d)
    }

    return (inside ? 1 : -1) * minDist
}

class TinyPQ {
    constructor() { this.a = [] }
    push(x) { this.a.push(x); this.a.sort((p, q) => q.max - p.max) }
    pop() { return this.a.shift() }
    get length() { return this.a.length }
}

function polylabel(poly, precision = 1.0) {
    const { minX, minY, maxX, maxY } = getBBox(poly)
    const width = maxX - minX
    const height = maxY - minY
    const cellSize = Math.min(width, height)
    if (cellSize <= 0) return polygonCentroid(poly)

    const h = cellSize / 2
    const pq = new TinyPQ()

    function makeCell(x, y, h) {
        const c = { x, y, h }
        c.d = pointToPolyDist({ x, y }, poly)
        c.max = c.d + c.h * Math.SQRT2
        return c
    }

    // initial grid
    for (let x = minX; x < maxX; x += cellSize) {
        for (let y = minY; y < maxY; y += cellSize) {
            pq.push(makeCell(x + h, y + h, h))
        }
    }

    // start from centroid
    let best = makeCell(polygonCentroid(poly).x, polygonCentroid(poly).y, 0)
    // also bbox center
    const boxCell = makeCell(minX + width / 2, minY + height / 2, 0)
    if (boxCell.d > best.d) best = boxCell

    while (pq.length) {
        const cell = pq.pop()
        if (cell.d > best.d) best = cell
        if (cell.max - best.d <= precision) continue

        const h2 = cell.h / 2
        pq.push(makeCell(cell.x - h2, cell.y - h2, h2))
        pq.push(makeCell(cell.x + h2, cell.y - h2, h2))
        pq.push(makeCell(cell.x - h2, cell.y + h2, h2))
        pq.push(makeCell(cell.x + h2, cell.y + h2, h2))
    }

    return { x: best.x, y: best.y }
}

// ---------------- building planar faces ----------------

// 1) берем исходные сегменты
function collectRawSegments() {
    const segs = []
    for (const w of (state.walls || [])) {
        if (!w) continue
        if (w.kind === 'capital') {
            segs.push({ a: { ...w.a }, b: { ...w.b }, kind: 'capital' })
        } else {
            // для топологии лучше брать "строительные" точки, если есть
            const a = w.va || w.a
            const b = w.vb || w.b
            segs.push({ a: { ...a }, b: { ...b }, kind: 'normal' })
        }
    }
    return segs
}

// 2) нарезаем сегменты в точках “стыков”
function splitSegments(segs) {
    const splits = segs.map(() => [])

    for (let i = 0; i < segs.length; i++) {
        const si = segs[i]
        splits[i].push(si.a, si.b)
    }

    // добавляем проекции концов на чужие сегменты
    for (let i = 0; i < segs.length; i++) {
        const si = segs[i]
        for (let j = 0; j < segs.length; j++) {
            if (i === j) continue
            const sj = segs[j]

            for (const p of [si.a, si.b]) {
                if (pointOnSegment(p, sj.a, sj.b, NODE_EPS)) {
                    splits[j].push({ ...p })
                } else {
                    const pr = projectPointToSegmentClamped(p, sj.a, sj.b)
                    if (pr.t > 1e-4 && pr.t < 1 - 1e-4 && pr.d <= NODE_EPS) {
                        splits[j].push({ ...pr.point })
                    }
                }
            }
        }
    }

    const out = []
    for (let i = 0; i < segs.length; i++) {
        const s = segs[i]

        // уникализация точек на сегменте
        const pts = []
        for (const p of splits[i]) {
            const k = keyOf(p)
            if (!pts.some(q => keyOf(q) === k)) pts.push(p)
        }

        // сортируем по параметру t
        const list = pts
            .map(p => ({ p, t: projectPointToSegmentClamped(p, s.a, s.b).t }))
            .sort((u, v) => u.t - v.t)

        for (let k = 0; k < list.length - 1; k++) {
            const a = list[k].p
            const b = list[k + 1].p
            if (!samePoint(a, b)) out.push({ a: { ...a }, b: { ...b } })
        }
    }

    return out
}

// 3) граф: вершины + ориентированные ребра
function buildHalfEdges(segments) {
    const nodes = new Map() // key -> {id, p, out: []}
    const getNode = (p) => {
        const k = keyOf(p)
        if (!nodes.has(k)) nodes.set(k, { id: k, p: { ...p }, out: [] })
        return nodes.get(k)
    }

    const halfEdges = [] // {fromId,toId,angle,used}
    const addDir = (a, b) => {
        const na = getNode(a)
        const nb = getNode(b)
        const ang = Math.atan2(nb.p.y - na.p.y, nb.p.x - na.p.x)
        const he = { from: na.id, to: nb.id, angle: ang, used: false }
        halfEdges.push(he)
        na.out.push(he)
        return he
    }

    for (const s of segments) {
        addDir(s.a, s.b)
        addDir(s.b, s.a)
    }

    // сортировка исходящих по углу (CCW)
    for (const n of nodes.values()) {
        n.out.sort((e1, e2) => e1.angle - e2.angle)
    }

    return { nodes, halfEdges }
}

// 4) обход граней “по правой руке”
function nextEdge(nodes, edge) {
    const v = nodes.get(edge.to)
    const out = v.out
    if (!out.length) return null

    const backIndex = out.findIndex(e => e.to === edge.from)
    if (backIndex === -1) return null

    const nextIndex = (backIndex - 1 + out.length) % out.length
    return out[nextIndex]
}

function traceFace(nodes, startEdge) {
    const poly = []
    let e = startEdge
    while (true) {
        e.used = true
        const a = nodes.get(e.from).p
        poly.push(a)

        const ne = nextEdge(nodes, e)
        if (!ne) return null

        e = ne
        if (e.from === startEdge.from && e.to === startEdge.to) break

        if (poly.length > 2000) return null
    }
    return poly
}

function dedupeFace(poly) {
    const out = []
    for (const p of poly) {
        if (!out.length || !samePoint(out[out.length - 1], p)) out.push(p)
    }
    if (out.length >= 2 && samePoint(out[0], out[out.length - 1])) out.pop()
    return out
}

function uniqFaces(faces) {
    const seen = new Set()
    const out = []
    for (const f of faces) {
        const keys = f.map(keyOf).sort().join('|')
        if (seen.has(keys)) continue
        seen.add(keys)
        out.push(f)
    }
    return out
}

// ---------------- public API ----------------

export function computeRooms({
    minAreaM2 = config.rooms?.minAreaM2 ?? 0.5,
} = {}) {
    const capPoly = getCapPoly() // может быть null

    const segs0 = collectRawSegments()
    const segs = splitSegments(segs0)
    const { nodes, halfEdges } = buildHalfEdges(segs)

    const faces = []

    for (const e of halfEdges) {
        if (e.used) continue
        const poly0 = traceFace(nodes, e)
        if (!poly0 || poly0.length < 3) continue
        const poly = dedupeFace(poly0)
        if (poly.length < 3) continue

        const areaW = shoelaceArea(poly)
        if (!Number.isFinite(areaW) || Math.abs(areaW) < 1) continue
        faces.push(poly)
    }

    const uniq = uniqFaces(faces)
    if (!uniq.length) return []

    // убрать внешнюю грань: обычно самая большая по |area|
    let maxIdx = 0
    let maxAbs = 0
    const areas = uniq.map((p, i) => {
        const a = shoelaceArea(p)
        const abs = Math.abs(a)
        if (abs > maxAbs) { maxAbs = abs; maxIdx = i }
        return a
    })

    const UNITS_PER_M = config.units.UNITS_PER_M
    const precision = config.rooms?.polylabelPrecisionWorld ?? 2.0

    const rooms = []
    for (let i = 0; i < uniq.length; i++) {
        if (i === maxIdx) continue // внешняя

        const poly = uniq[i]
        const areaW = Math.abs(areas[i])
        const areaM2 = areaW / (UNITS_PER_M * UNITS_PER_M)
        if (areaM2 < minAreaM2) continue

        // --- label ---
        let label = polylabel(poly, precision)

        // ✅ защита: точка должна быть внутри
        if (!pointInPoly(label, poly)) {
            label = polygonCentroid(poly)
            if (!pointInPoly(label, poly)) {
                const bb = getBBox(poly)
                label = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 }
            }
        }

        // ✅ защита: комната должна быть внутри капитального контура
        if (capPoly && capPoly.length >= 3) {
            if (!pointInPoly(label, capPoly)) continue
        }

        rooms.push({ poly, areaM2, label })
    }

    return rooms
}