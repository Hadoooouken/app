// interaction/pointer.js
import { state } from '../engine/state.js'
import { render } from '../renderer/render.js'
import { screenToWorld } from '../renderer/svg.js'
import { smartSnapPoint, isSegmentAllowed } from '../engine/constraints.js'

const CAP_W = 28
const NOR_W = 10
const OVERLAP = 5

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

function trimWallToCapitals(wall) {
    const caps = (state.walls || []).filter(w => w.kind === 'capital')
    if (!caps.length) return wall

    const scale = Math.max(1e-6, state.view.scale)
    const tolWorld = 22 / scale
    const trimLen = CAP_W / 2 + NOR_W / 2 - OVERLAP

    const snapTrimEnd = (end, other) => {
        let best = null
        for (const c of caps) {
            const q = nearestPointOnSeg(end, c.a, c.b)
            const d = dist(end, q)
            if (d <= tolWorld && (!best || d < best.d)) best = { q, d }
        }
        if (!best) return end
        return trimPointBack(other, best.q, trimLen)
    }

    wall.a = snapTrimEnd(wall.a, wall.b)
    wall.b = snapTrimEnd(wall.b, wall.a)
    return wall
}

export function initPointer(draw, { newWallId } = {}) {
    let firstPoint = null
    let activePointerId = null

    // ✅ КЛЮЧЕВО для мобилки: полностью выключаем системные жесты на svg
    // иначе pointermove может не приходить.
    draw.node.style.touchAction = 'none'

    function snappedFromEvent(e) {
        const raw = screenToWorld(draw, e.clientX, e.clientY)

        const p = smartSnapPoint(raw, firstPoint, {
            grid: 50,
            snapPx: 22,
            axisPx: 14,
            toGrid: true,
            toPoints: true,
            toAxis: true,
            toCapital: true,
            toNormals: true,
            tGuard: 0.08,
        })

        state.snapPoint = p
        return p
    }

    draw.node.addEventListener('pointermove', (e) => {
        if (state.mode !== 'draw-wall') return
        if (activePointerId !== null && e.pointerId !== activePointerId) return

        const p = snappedFromEvent(e)

        if (!firstPoint) {
            state.previewWall = null
            render(draw)
            return
        }

        const ok = isSegmentAllowed(firstPoint, p)
        state.previewWall = { a: firstPoint, b: p, ok }
        render(draw)
    }, { passive: false })

    draw.node.addEventListener('pointerdown', (e) => {
        if (state.mode !== 'draw-wall') return
        if (e.button !== 0 && e.pointerType === 'mouse') return

        // ✅ захватываем указатель -> move будет приходить стабильно
        activePointerId = e.pointerId
        draw.node.setPointerCapture?.(e.pointerId)

        const p = snappedFromEvent(e)

        // 1-я точка
        if (!firstPoint) {
            firstPoint = p
            state.previewWall = { a: firstPoint, b: p, ok: true }
            render(draw)
            return
        }

        // 2-я точка
        if (!isSegmentAllowed(firstPoint, p)) {
            state.previewWall = { a: firstPoint, b: p, ok: false }
            render(draw)
            return
        }

        const id = (typeof newWallId === 'function') ? newWallId() : `u${Date.now()}`
        const newWall = { id, a: { ...firstPoint }, b: { ...p }, kind: 'normal' }

        // ✅ подрезка к капитальным
        trimWallToCapitals(newWall)

        state.walls.push(newWall)

        firstPoint = null
        state.previewWall = null
        state.snapPoint = null
        render(draw)
    }, { passive: false })

    const stop = (e) => {
        if (activePointerId !== null) {
            try { draw.node.releasePointerCapture?.(activePointerId) } catch { }
        }
        activePointerId = null
    }

    draw.node.addEventListener('pointerup', stop, { passive: true })
    draw.node.addEventListener('pointercancel', stop, { passive: true })

    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return
        firstPoint = null
        state.previewWall = null
        state.snapPoint = null
        render(draw)
    })
}
