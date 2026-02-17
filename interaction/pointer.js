// interaction/pointer.js
import { state, GRID_STEP_SNAP, CAP_W, NOR_W, OVERLAP } from '../engine/state.js'
import { render } from '../renderer/render.js'
import { screenToWorld } from '../renderer/svg.js'
import { smartSnapPoint, isSegmentAllowed } from '../engine/constraints.js'

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y)

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
// --------------------------------------------------

export function initPointer(draw, { newWallId } = {}) {
    let firstPoint = null

    // “курсор” — последняя snapPoint
    let down = null
    const TAP_THRESH_PX = 10

    // ✅ новое: тап по стартовой точке отменяет A
    const CANCEL_A_PX = 14

    const cancelAll = () => {
        firstPoint = null
        state.previewWall = null
        state.snapPoint = null
        render(draw)
    }

    // ✅ новое: отменить только стартовую точку (A) + превью
    // курсор (snapPoint) оставляем как есть
    const cancelStart = () => {
        firstPoint = null
        state.previewWall = null
        render(draw)
    }

    function snapAt(raw, fromPoint) {
        return smartSnapPoint(raw, fromPoint, {
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
    }

    // если мы вошли в режим wall и у нас нет “курсора” — ставим в центр экрана
    function ensureCursorAtCenterIfNeeded() {
        if (state.mode !== 'draw-wall') return
        if (state.snapPoint) return

        const rect = draw.node.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2

        const raw = screenToWorld(draw, cx, cy)
        const p = snapAt(raw, null)
        state.snapPoint = p
    }

    // обновить курсор по событию (мышь/палец)
    function updateCursorFromEvent(e) {
        const raw = screenToWorld(draw, e.clientX, e.clientY)
        const p = snapAt(raw, firstPoint)
        state.snapPoint = p
        return p
    }

    // --- PREVIEW (пунктир) ---
    draw.node.addEventListener(
        'pointermove',
        (e) => {
            if (state.mode !== 'draw-wall') return
            if (e.pointerType === 'touch') e.preventDefault?.()

            ensureCursorAtCenterIfNeeded()

            const p = updateCursorFromEvent(e)

            if (!firstPoint) {
                state.previewWall = null
                render(draw)
                return
            }

            const ok = isSegmentAllowed(firstPoint, p)
            state.previewWall = { a: firstPoint, b: p, ok }
            render(draw)
        },
        { passive: false }
    )

    // --- DOWN: начинаем "двигать курсор" ---
    draw.node.addEventListener(
        'pointerdown',
        (e) => {
            if (state.mode !== 'draw-wall') return
            if (e.button !== 0 && e.pointerType === 'mouse') return
            if (e.pointerType === 'touch') e.preventDefault?.()

            ensureCursorAtCenterIfNeeded()

            down = { x: e.clientX, y: e.clientY, id: e.pointerId }
            draw.node.setPointerCapture?.(e.pointerId)

            // на down тоже обновим курсор
            updateCursorFromEvent(e)
            render(draw)
        },
        { passive: false }
    )

    // --- UP: подтверждаем точку (как клик) ---
    draw.node.addEventListener(
        'pointerup',
        (e) => {
            if (state.mode !== 'draw-wall') return
            if (e.button !== 0 && e.pointerType === 'mouse') return
            if (e.pointerType === 'touch') e.preventDefault?.()

            // если хочешь строгий “тап” — можно отфильтровать драг
            if (down) {
                const dx = e.clientX - down.x
                const dy = e.clientY - down.y
                // если сильно утащили — не подтверждаем точку (опционально)
                // if (Math.hypot(dx, dy) > TAP_THRESH_PX) { down = null; return }
                void dx; void dy
            }
            down = null

            // подтверждаем текущую позицию курсора
            const p = state.snapPoint ? { ...state.snapPoint } : updateCursorFromEvent(e)

            // ✅ если A уже стоит и пользователь тапнул рядом с A — отменяем A
            if (firstPoint) {
                const tolWorld = CANCEL_A_PX / Math.max(1e-6, state.view.scale)
                const d = Math.hypot(p.x - firstPoint.x, p.y - firstPoint.y)
                if (d <= tolWorld) {
                    cancelStart()
                    return
                }
            }

            // 1-я точка (ставится ТОЛЬКО по тапу/клику)
            if (!firstPoint) {
                if (!isSegmentAllowed(p, p)) {
                    // старт в запрещённом месте — просто не начинаем
                    state.previewWall = null
                    render(draw)
                    return
                }
                firstPoint = p
                state.previewWall = { a: firstPoint, b: p, ok: true }
                render(draw)
                return
            }

            // 2-я точка: если нельзя — сбрасываем И линию, И A ✅
            if (!isSegmentAllowed(firstPoint, p)) {
                cancelStart()
                return
            }

            const id = typeof newWallId === 'function' ? newWallId() : `u${Date.now()}`
            const newWall = { id, a: { ...firstPoint }, b: { ...p }, kind: 'normal' }

            // подрезка к капитальным
            trimWallToCapitals(newWall)

            if (!isSegmentAllowed(newWall.a, newWall.b)) {
                // если после подрезки стало нельзя — тоже сбрасываем A
                cancelStart()
                return
            }

            state.walls.push(newWall)

            // после успешного добавления — сбрасываем A (как раньше)
            firstPoint = null
            state.previewWall = null

            // курсор оставляем там же (удобно)
            state.snapPoint = { ...p }

            render(draw)
        },
        { passive: false }
    )

    draw.node.addEventListener('pointercancel', () => cancelAll(), { passive: true })

    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return
        cancelAll()
    })

    // на старт модуля — если пользователь уже в wall, покажем курсор
    ensureCursorAtCenterIfNeeded()
}
