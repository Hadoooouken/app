// engine/rooms.js
import { state, UNITS_PER_M } from './state.js'

// ---------------- utils ----------------
const EPS = 0.5 // world units (подстрой: 0.25..2)

const keyOf = (p) => `${Math.round(p.x / EPS)}:${Math.round(p.y / EPS)}`
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

function samePoint(a, b, eps = EPS) {
    return dist(a, b) <= eps
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)) }

function projectPointToSegmentClamped(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y
    const apx = p.x - a.x, apy = p.y - a.y
    const ab2 = abx * abx + aby * aby
    if (ab2 < 1e-9) return { point: { ...a }, t: 0, d: dist(p, a) }
    let t = (apx * abx + apy * aby) / ab2
    t = clamp(t, 0, 1)
    const q = { x: a.x + abx * t, y: a.y + aby * t }
    return { point: q, t, d: dist(p, q) }
}

// point on segment (inclusive)
function pointOnSegment(p, a, b, eps = EPS) {
    const pr = projectPointToSegmentClamped(p, a, b)
    return pr.d <= eps && pr.t >= -1e-6 && pr.t <= 1 + 1e-6
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

function pointInPoly(p, poly) {
    // ray casting
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j]
        const intersect =
            ((a.y > p.y) !== (b.y > p.y)) &&
            (p.x < (b.x - a.x) * (p.y - a.y) / ((b.y - a.y) || 1e-9) + a.x)
        if (intersect) inside = !inside
    }
    return inside
}

// ---------------- polylabel (упрощенная, но рабочая) ----------------
// Ищет точку внутри полигона, максимально удалённую от границы.
// Это даёт “центр комнаты” визуально правильно.
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

function pointToPolyDist(p, poly) {
    // positive if inside, negative if outside
    let inside = pointInPoly(p, poly)
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
// важное: intersections у тебя запрещены, но end-to-segment стыки есть всегда
function splitSegments(segs) {
    // для каждого сегмента соберем точки-разрезы
    const splits = segs.map(() => [])

    for (let i = 0; i < segs.length; i++) {
        const si = segs[i]
        // endpoints всегда
        splits[i].push(si.a, si.b)
    }

    // добавляем проекции концов на чужие сегменты
    for (let i = 0; i < segs.length; i++) {
        const si = segs[i]
        for (let j = 0; j < segs.length; j++) {
            if (i === j) continue
            const sj = segs[j]

            for (const p of [si.a, si.b]) {
                if (pointOnSegment(p, sj.a, sj.b, EPS)) {
                    // p лежит на sj -> это вершина разреза для sj
                    splits[j].push({ ...p })
                } else {
                    // иногда у тебя конец near, но не идеально => подстрахуемся проекцией
                    const pr = projectPointToSegmentClamped(p, sj.a, sj.b)
                    // только если попали "внутрь" сегмента и очень близко
                    if (pr.t > 1e-4 && pr.t < 1 - 1e-4 && pr.d <= EPS) {
                        splits[j].push({ ...pr.point })
                    }
                }
            }
        }
    }

    // превращаем каждый сегмент в набор маленьких
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
    // nodeId by snapped key
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

    // найти ребро, которое идет обратно (to -> from)
    const backIndex = out.findIndex(e => e.to === edge.from)
    if (backIndex === -1) return null

    // берем “предыдущее” в CCW списке => это поворот вправо
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

        // защита от зацикливания
        if (poly.length > 2000) return null
    }
    return poly
}

function dedupeFace(poly) {
    // убираем подряд одинаковые точки
    const out = []
    for (const p of poly) {
        if (!out.length || !samePoint(out[out.length - 1], p)) out.push(p)
    }
    // если замкнулось дублем в конце
    if (out.length >= 2 && samePoint(out[0], out[out.length - 1])) out.pop()
    return out
}

function uniqFaces(faces) {
    // грубая уникализация по строке ключей
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

export function computeRooms({ minAreaM2 = 0.5 } = {}) {
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

        const areaW = shoelaceArea(poly) // world^2
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

    const rooms = []
    for (let i = 0; i < uniq.length; i++) {
        if (i === maxIdx) continue // внешняя

        const poly = uniq[i]
        const areaW = Math.abs(areas[i])
        const areaM2 = areaW / (UNITS_PER_M * UNITS_PER_M)

        if (areaM2 < minAreaM2) continue

        const label = polylabel(poly, 2.0) // точность в world units
        rooms.push({ poly, areaM2, label })
    }

    return rooms
}
