// interaction/pointer.js
import {
    state,
    GRID_STEP_SNAP,
    CAP_W,
    NOR_W,
    OVERLAP,
    CLEAR_FROM_CAPITAL,
} from '../engine/state.js'
import { render } from '../renderer/render.js'
import { screenToWorld } from '../renderer/svg.js'
import {
    smartSnapPoint,
    isSegmentAllowed,
    isSegmentClearOfCapitals,
} from '../engine/constraints.js'
import { normalizeNormalWall } from '../engine/normalize-wall.js'

// ---------------- helpers ----------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y)

// thresholds
const TAP_THRESH_PX = 10
const CANCEL_A_PX = 14

const clearPulse = () => {
    if (state.ui) state.ui.snapPulse = null
}

// ✅ ДЛЯ РИСОВАНИЯ делаем “clear” заметно меньше, чем для select
// Если всё ещё широко — уменьши множитель: 0.2 / 0.15
const DRAW_CLEAR = Math.max(0, (Number.isFinite(CLEAR_FROM_CAPITAL) ? CLEAR_FROM_CAPITAL : 0) * 0.1)

// ---------------- trim to capitals ----------------
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

    wall.va = { ...wall.a }
    wall.vb = { ...wall.b }

    const scale = Math.max(1e-6, state.view.scale)
    const tolWorld = 22 / scale

    const trimLenVisual = CAP_W / 2 + NOR_W / 2 - OVERLAP

    const snapTrimEnd = (endKey, end, other) => {
        let best = null

        for (const c of caps) {
            const q = nearestPointOnSeg(end, c.a, c.b)
            const d = dist(end, q)
            if (d <= tolWorld && (!best || d < best.d)) best = { q, d }
        }

        if (!best) return end

        if (endKey === 'a') wall.va = { ...best.q }
        else wall.vb = { ...best.q }

        return trimPointBack(other, best.q, trimLenVisual)
    }

    wall.a = snapTrimEnd('a', wall.a, wall.b)
    wall.b = snapTrimEnd('b', wall.b, wall.a)

    return wall
}

// distance in px (screen space)
function distPx(a, b) {
    const dx = a.x - b.x
    const dy = a.y - b.y
    return Math.hypot(dx, dy)
}

// --------------------------------------------------

export function initPointer(draw, { newWallId } = {}) {
    let firstPoint = null
    let down = null
    let suppressPreview = false

    let raf = 0
    const scheduleRender = () => {
        if (raf) return
        raf = requestAnimationFrame(() => {
            raf = 0
            render(draw)
        })
    }

    const cancelAll = () => {
        firstPoint = null
        state.previewWall = null
        state.snapPoint = null
        state.cursorState = 'idle'
        suppressPreview = false
        clearPulse()
        scheduleRender()
    }

    const cancelStart = () => {
        firstPoint = null
        state.previewWall = null
        state.cursorState = 'idle'
        suppressPreview = false
        clearPulse()
        scheduleRender()
    }

    const cancelInvalidB = (p, pointerType) => {
        const aSaved = firstPoint ? { ...firstPoint } : null

        state.previewWall = null
        firstPoint = null
        state.cursorState = 'idle'
        suppressPreview = true
        clearPulse()

        if (pointerType === 'touch') {
            if (aSaved) state.snapPoint = aSaved
        } else {
            state.snapPoint = { ...p }
        }

        scheduleRender()
    }

    function snapAt(raw, fromPoint) {
        return smartSnapPoint(raw, fromPoint, {
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
    }

    function ensureCursorAtCenterIfNeeded() {
        if (state.mode !== 'draw-wall') return
        if (state.snapPoint) return

        const rect = draw.node.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2

        const raw = screenToWorld(draw, cx, cy)
        state.snapPoint = snapAt(raw, null)
        state.cursorState = 'idle'
        scheduleRender()
    }

    function updateCursorFromEvent(e) {
        const raw = screenToWorld(draw, e.clientX, e.clientY)
        const p = snapAt(raw, firstPoint)
        state.snapPoint = p
        return p
    }

    // --- MOVE: cursor + preview ---
    draw.node.addEventListener('pointermove', (e) => {
        if (state.mode !== 'draw-wall') return
        if (e.pointerType === 'touch') e.preventDefault?.()

        ensureCursorAtCenterIfNeeded()

        const p = updateCursorFromEvent(e)

        if (!firstPoint) {
            state.cursorState = 'idle'
            state.previewWall = null
            if (suppressPreview) suppressPreview = false
            scheduleRender()
            return
        }

        if (suppressPreview) {
            state.cursorState = 'idle'
            state.previewWall = null
            suppressPreview = false
            scheduleRender()
            return
        }

        const okAllowed = isSegmentAllowed(firstPoint, p)
        const okClear = isSegmentClearOfCapitals(firstPoint, p, DRAW_CLEAR)

        const ok = okAllowed && okClear
        state.cursorState = ok ? 'valid' : 'invalid'
        state.previewWall = { a: firstPoint, b: p, ok }

        scheduleRender()
    }, { passive: false })

    // --- DOWN ---
    draw.node.addEventListener('pointerdown', (e) => {
        if (state.mode !== 'draw-wall') return
        if (e.button !== 0 && e.pointerType === 'mouse') return
        if (e.pointerType === 'touch') e.preventDefault?.()

        ensureCursorAtCenterIfNeeded()

        down = { x: e.clientX, y: e.clientY, id: e.pointerId }
        draw.node.setPointerCapture?.(e.pointerId)

        updateCursorFromEvent(e)
        scheduleRender()
    }, { passive: false })

    // --- UP ---
    draw.node.addEventListener('pointerup', (e) => {
        if (state.mode !== 'draw-wall') return
        if (e.button !== 0 && e.pointerType === 'mouse') return
        if (e.pointerType === 'touch') e.preventDefault?.()

        const wasDown = down
        down = null

        const isTap =
            wasDown
                ? distPx({ x: e.clientX, y: e.clientY }, { x: wasDown.x, y: wasDown.y }) <= TAP_THRESH_PX
                : true

        const p = state.snapPoint ? { ...state.snapPoint } : updateCursorFromEvent(e)

        // 1) choose A
        if (!firstPoint) {
            if (e.pointerType === 'touch' && !isTap) {
                state.cursorState = 'idle'
                state.previewWall = null
                scheduleRender()
                return
            }

            // ✅ Не даём ставить A в зоне, где B всё равно будет запрещён
            // (проверяем “точку”, как минимальный сегмент)
            // ✅ A можно ставить везде (включая на капитальных и рядом)
            // ограничения проверяем уже на сегменте A->B
            firstPoint = p
            state.cursorState = 'valid'
            state.previewWall = { a: firstPoint, b: p, ok: true }
            suppressPreview = false
            scheduleRender()
            return


            firstPoint = p
            state.cursorState = 'valid'
            state.previewWall = { a: firstPoint, b: p, ok: true }
            suppressPreview = false
            scheduleRender()
            return
        }

        // 2) A exists

        if (isTap) {
            const tolWorld = CANCEL_A_PX / Math.max(1e-6, state.view.scale)
            const dWorld = Math.hypot(p.x - firstPoint.x, p.y - firstPoint.y)
            if (dWorld <= tolWorld) {
                cancelStart()
                return
            }
        }

        // ✅ ВАЖНО: проверяем и allowed, и clear ПЕРЕД созданием стены
        const okAllowed = isSegmentAllowed(firstPoint, p)
        const okClear = isSegmentClearOfCapitals(firstPoint, p, DRAW_CLEAR)

        if (!(okAllowed && okClear)) {
            cancelInvalidB(p, e.pointerType)
            return
        }

        const id = (typeof newWallId === 'function') ? newWallId() : `u${Date.now()}`
        const newWall = { id, a: { ...firstPoint }, b: { ...p }, kind: 'normal' }

        trimWallToCapitals(newWall)

        // ✅ после trim снова проверяем (на всякий)
        const okAllowed2 = isSegmentAllowed(newWall.a, newWall.b)
        const okClear2 = isSegmentClearOfCapitals(newWall.a, newWall.b, DRAW_CLEAR)

        if (!(okAllowed2 && okClear2)) {
            cancelInvalidB(p, e.pointerType)
            return
        }

        state.walls.push(newWall)

        firstPoint = null
        state.previewWall = null
        state.snapPoint = { ...p }
        state.cursorState = 'idle'
        suppressPreview = false
        clearPulse()
        scheduleRender()
    }, { passive: false })

    draw.node.addEventListener('pointercancel', () => cancelAll(), { passive: true })

    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return
        cancelAll()
    })

    ensureCursorAtCenterIfNeeded()
}
