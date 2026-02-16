// interaction/pointer.js
import { state, GRID_STEP_SNAP } from '../engine/state.js'
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

export function initPointer(draw, { newWallId } = {}) {
    let firstPoint = null

    const cancelDrawing = () => {
        firstPoint = null
        state.previewWall = null
        state.snapPoint = null
        render(draw)
    }

    function snappedFromEvent(e) {
        const raw = screenToWorld(draw, e.clientX, e.clientY)

        const p = smartSnapPoint(raw, firstPoint, {
            grid: GRID_STEP_SNAP,
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

    // ✅ pointermove — работает и для mouse, и для touch
    draw.node.addEventListener('pointermove', (e) => {
        if (state.mode !== 'draw-wall') return
        if (e.pointerType === 'touch') e.preventDefault?.()

        const p = snappedFromEvent(e)

        if (!firstPoint) {
            // просто показываем снап-точку/пульс, без пунктирки
            state.previewWall = null
            render(draw)
            return
        }

        const ok = isSegmentAllowed(firstPoint, p)
        state.previewWall = { a: firstPoint, b: p, ok }
        render(draw)
    }, { passive: false })

    // ✅ pointerdown вместо click, чтобы на мобилке работало одинаково
    draw.node.addEventListener('pointerdown', (e) => {
        if (state.mode !== 'draw-wall') return
        if (e.button !== 0 && e.pointerType === 'mouse') return
        if (e.pointerType === 'touch') e.preventDefault?.()

        const p = snappedFromEvent(e)

        // 1-я точка
        if (!firstPoint) {
            // если стартовая точка уже "нельзя" — просто не начинаем
            if (!isSegmentAllowed(p, p)) {
                cancelDrawing()
                return
            }

            firstPoint = p
            state.previewWall = { a: firstPoint, b: p, ok: true }
            render(draw)
            return
        }

        // 2-я точка: если нельзя — ОТМЕНЯЕМ рисование как Esc ✅
        if (!isSegmentAllowed(firstPoint, p)) {
            cancelDrawing()
            return
        }

        // можно — создаём стену
        const id = (typeof newWallId === 'function') ? newWallId() : `u${Date.now()}`
        const newWall = { id, a: { ...firstPoint }, b: { ...p }, kind: 'normal' }

        // подрезка к капитальным
        trimWallToCapitals(newWall)

        // финальная проверка после подрезки (на всякий)
        if (!isSegmentAllowed(newWall.a, newWall.b)) {
            cancelDrawing()
            return
        }

        state.walls.push(newWall)
        window.dispatchEvent(new Event('planner:changed'))

        // сброс состояния рисования
        firstPoint = null
        state.previewWall = null
        state.snapPoint = null
        render(draw)
    }, { passive: false })

    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return
        cancelDrawing()
    })
}
