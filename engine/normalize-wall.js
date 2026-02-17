// engine/normalize-wall.js
import { state, CAP_W, NOR_W, OVERLAP } from './state.js'
import { projectPointToSegmentClamped, dist } from './geom.js'

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

function trimPointBack(from, to, trimLen) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    return { x: to.x - ux * trimLen, y: to.y - uy * trimLen }
}

function nearestPointOnCapitals(p, caps) {
    let best = null
    for (const c of caps) {
        const pr = projectPointToSegmentClamped(p, c.a, c.b) // {point,t,d}
        if (!best || pr.d < best.d) best = pr
    }
    return best // { point, t, d }
}

/**
 * Нормализует normal-стену:
 * - строит "строительные" va/vb (могут лежать ровно на оси капитальной)
 * - строит "видимые" a/b (trim внутрь, чтобы стык выглядел красиво)
 *
 * ВАЖНО: функция НЕ решает "можно/нельзя" — это проверяет constraints.
 */
export function normalizeNormalWall(wall, opts = {}) {
    if (!wall || wall.kind === 'capital') return wall

    const {
        snapPx = 22,   // радиус прилипания к капитальным (в пикселях)
        doTrim = true, // делать ли видимую подрезку
    } = opts

    const caps = (state.walls || []).filter(w => w && w.kind === 'capital')
    if (!caps.length) {
        // если капитальных нет — просто гарантируем va/vb
        wall.va = wall.va ? { ...wall.va } : { ...wall.a }
        wall.vb = wall.vb ? { ...wall.vb } : { ...wall.b }
        return wall
    }

    // исходная "строительная" геометрия (если есть — берём её)
    let va = wall.va ? { ...wall.va } : { ...wall.a }
    let vb = wall.vb ? { ...wall.vb } : { ...wall.b }

    const scale = Math.max(1e-6, state.view.scale)
    const tolWorld = snapPx / scale

    // 1) snap строительных концов к ОСИ капитальных (проекция на сегмент)
    //    (это даёт точные 12.00 и т.п.)
    const hitA = nearestPointOnCapitals(va, caps)
    if (hitA && hitA.d <= tolWorld) va = { ...hitA.point }

    const hitB = nearestPointOnCapitals(vb, caps)
    if (hitB && hitB.d <= tolWorld) vb = { ...hitB.point }

    wall.va = va
    wall.vb = vb

    // 2) видимая геометрия
    if (!doTrim) {
        wall.a = { ...va }
        wall.b = { ...vb }
        return wall
    }

    const trimLenVisual = (CAP_W / 2) + (NOR_W / 2) - OVERLAP

    let a = { ...va }
    let b = { ...vb }

    // trim только если конец реально "прилип" к капитальным
    const hitA2 = nearestPointOnCapitals(va, caps)
    if (hitA2 && hitA2.d <= tolWorld) a = trimPointBack(vb, va, trimLenVisual)

    const hitB2 = nearestPointOnCapitals(vb, caps)
    if (hitB2 && hitB2.d <= tolWorld) b = trimPointBack(va, vb, trimLenVisual)

    wall.a = a
    wall.b = b

    return wall
}
