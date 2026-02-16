// interaction/pointer.js
import { state } from '../engine/state.js'
import { render } from '../renderer/render.js'
import { screenToWorld } from '../renderer/svg.js'
import { smartSnapPoint, isSegmentAllowed } from '../engine/constraints.js'

export function initPointer(draw, { newWallId } = {}) {
    let firstPoint = null

    function snapped(e) {
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

        // ✅ показываем, куда примагнитило
        state.snapPoint = p
        return p
    }

    draw.on('mousemove', (e) => {
        if (state.mode !== 'draw-wall') return

        // обновляем snapPoint даже когда firstPoint ещё нет
        const p = snapped(e)

        if (!firstPoint) {
            render(draw)
            return
        }

        const ok = isSegmentAllowed(firstPoint, p)
        state.previewWall = { a: firstPoint, b: p, ok }
        render(draw)
    })

    draw.on('click', (e) => {
        if (state.mode !== 'draw-wall') return

        const p = snapped(e)

        if (!firstPoint) {
            if (!isSegmentAllowed(p, p)) return
            firstPoint = p
            state.previewWall = { a: firstPoint, b: p, ok: true }
            render(draw)
            return
        }

        if (!isSegmentAllowed(firstPoint, p)) {
            state.previewWall = { a: firstPoint, b: p, ok: false }
            render(draw)
            return
        }

        const id = (typeof newWallId === 'function') ? newWallId() : `u${Date.now()}`
        state.walls.push({ id, a: firstPoint, b: p, kind: 'normal' })

        firstPoint = null
        state.previewWall = null
        state.snapPoint = null // ✅ убираем точку после завершения
        render(draw)
    })

    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return
        firstPoint = null
        state.previewWall = null
        state.snapPoint = null // ✅
        render(draw)
    })
}
