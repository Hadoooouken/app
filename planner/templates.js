// planner/templates.js
import { state } from '../engine/state.js'

let id = 1
const W = (ax, ay, bx, by, kind = 'capital') => ({
    id: `w${id++}`,
    a: { x: ax, y: ay },
    b: { x: bx, y: by },
    kind,
})

// --- НАСТРОЙКИ “геометрии стыка” ---
const CAP_W = 28
const NOR_W = 10
const SNAP_DIST = 40 // насколько близко считаем “упёрся” (в твоих world units)

// --- геом. хелперы ---
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y)

function nearestPointOnSeg(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y
    const apx = p.x - a.x, apy = p.y - a.y
    const ab2 = abx * abx + aby * aby || 1
    const t = clamp((apx * abx + apy * aby) / ab2, 0, 1)
    return { x: a.x + abx * t, y: a.y + aby * t }
}

function trimPointBack(from, to, trimLen) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    return { x: to.x - ux * trimLen, y: to.y - uy * trimLen }
}

function snapAndTrimEndpoint(endpoint, otherEnd, capitals) {
    // ищем ближайшую точку на капитальных к endpoint
    let best = null
    for (const c of capitals) {
        const q = nearestPointOnSeg(endpoint, c.a, c.b)
        const d = dist(endpoint, q)
        if (d <= SNAP_DIST && (!best || d < best.d)) best = { q, d }
    }
    if (!best) return endpoint

    // конец “прибиваем” на капитальную и обрезаем назад
 const OVERLAP = 5; // 2..8 подбери
const trim = CAP_W / 2 + NOR_W / 2 - OVERLAP
    const snapped = best.q
    return trimPointBack(otherEnd, snapped, trim)
}

function snapAndTrimNormalsToCapitals() {
    const caps = state.walls.filter(w => w.kind === 'capital')
    if (!caps.length) return

    for (const w of state.walls) {
        if (w.kind !== 'normal') continue

        // пробуем обработать оба конца
        const newA = snapAndTrimEndpoint(w.a, w.b, caps)
        const newB = snapAndTrimEndpoint(w.b, w.a, caps)

        w.a = newA
        w.b = newB
    }
}

export function loadStudioTemplate() {
    id = 1

    const x0 = 0
    const y0 = 0
    const x1 = 1200
    const y1 = 760

    const notchX = 980
    const notchY = 620

    const balcW = 320
    const balcH = 220

    const bedLeft = 760
    const bedTop = 0
    const bedBottom = 360

    const bathTop = 520
    const bathLeft = 520
    const bathRight = 820

    const hallLineY = 420

    state.walls = [
        // capital outer
        W(x0, y0, x1, y0, 'capital'),
        W(x1, y0, x1, notchY, 'capital'),
        W(x1, notchY, notchX, notchY, 'capital'),
        W(notchX, notchY, notchX, y1, 'capital'),
        W(notchX, y1, x0, y1, 'capital'),
        W(x0, y1, x0, y0, 'capital'),

        // capital balcony
        W(x0, 80, x0 + balcW, 80, 'capital'),
        W(x0 + balcW, 80, x0 + balcW, 80 + balcH, 'capital'),
        W(x0 + balcW, 80 + balcH, x0, 80 + balcH, 'capital'),

        // normals
        W(bedLeft, bedTop, bedLeft, bedBottom, 'normal'),
        W(bedLeft, bedBottom, x1, bedBottom, 'normal'),

        W(260, hallLineY, 900, hallLineY, 'normal'),

        W(bathLeft, bathTop, bathRight, bathTop, 'normal'),
        W(bathLeft, bathTop, bathLeft, y1, 'normal'),
        W(bathRight, bathTop, bathRight, y1, 'normal'),

        W(680, bathTop, 680, y1, 'normal'),
    ]

    // <-- ВОТ ЭТО ТЕБЕ И НУЖНО: подрезать нормалы к капитальным
    snapAndTrimNormalsToCapitals()

    state.draft = null
}
