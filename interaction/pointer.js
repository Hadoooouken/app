// interaction/pointer.js
import { state, GRID_STEP_SNAP, CAP_W, NOR_W, OVERLAP } from '../engine/state.js'
import { render } from '../renderer/render.js'
import { screenToWorld } from '../renderer/svg.js'
import { smartSnapPoint, isSegmentAllowed } from '../engine/constraints.js'

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y)

// ---------------- trim to capitals (как раньше) ----------------
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
    const tolWorld = 22 / scale // примерно как snapPx
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

// --------------------------------------------------------------

export function initPointer(draw, { newWallId } = {}) {
    let firstPoint = null

    // чтобы различать тап/драг на мобилке
    let down = null
    const TAP_THRESH_PX = 10

    const cancelDrawing = () => {
        firstPoint = null
        state.previewWall = null
        state.snapPoint = null
        render(draw)
    }

    function snappedFromEvent(e) {
        const raw = screenToWorld(draw, e.clientX, e.clientY)

        const p = smartSnapPoint(raw, firstPoint, {
            grid: GRID_STEP_SNAP, // ✅ 25см
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

    // ✅ превью линия (пунктир)
    draw.node.addEventListener('pointermove', (e) => {
        if (state.mode !== 'draw-wall') return
        if (e.pointerType === 'touch') e.preventDefault?.()

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

    // ✅ фикс: на мобилке “клик” делаем по pointerup
    draw.node.addEventListener('pointerdown', (e) => {
        if (state.mode !== 'draw-wall') return
        if (e.button !== 0 && e.pointerType === 'mouse') return
        if (e.pointerType === 'touch') e.preventDefault?.()

        down = { x: e.clientX, y: e.clientY, id: e.pointerId }
        draw.node.setPointerCapture?.(e.pointerId)
    }, { passive: false })

    draw.node.addEventListener('pointerup', (e) => {
        if (state.mode !== 'draw-wall') return
        if (e.button !== 0 && e.pointerType === 'mouse') return
        if (e.pointerType === 'touch') e.preventDefault?.()

        // если это был драг, а не тап — не ставим точки
        if (down) {
            const dx = e.clientX - down.x
            const dy = e.clientY - down.y
            if (Math.hypot(dx, dy) > TAP_THRESH_PX) {
                down = null
                return
            }
        }
        down = null

        const p = snappedFromEvent(e)

        // 1-я точка
        if (!firstPoint) {
            if (!isSegmentAllowed(p, p)) {
                cancelDrawing()
                return
            }
            firstPoint = p
            state.previewWall = { a: firstPoint, b: p, ok: true }
            render(draw)
            return
        }

        // 2-я точка: если нельзя — отменяем как Esc ✅
        if (!isSegmentAllowed(firstPoint, p)) {
            cancelDrawing()
            return
        }

        // можно — создаём стену
        const id = (typeof newWallId === 'function') ? newWallId() : `u${Date.now()}`
        const newWall = { id, a: { ...firstPoint }, b: { ...p }, kind: 'normal' }

        trimWallToCapitals(newWall)

        // финальная проверка
        if (!isSegmentAllowed(newWall.a, newWall.b)) {
            cancelDrawing()
            return
        }

        state.walls.push(newWall)

        firstPoint = null
        state.previewWall = null
        state.snapPoint = null
        render(draw)
    }, { passive: false })

    draw.node.addEventListener('pointercancel', () => cancelDrawing(), { passive: true })

    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return
        cancelDrawing()
    })
}
