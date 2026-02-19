// planner/app.js
import {
    state,
    GRID_STEP_SNAP,
    CLEAR_FROM_CAPITAL,
    CAP_W,
    NOR_W,
    OVERLAP,
} from '../engine/state.js'

import { createSVG, setZoomAtCenter, screenToWorld } from '../renderer/svg.js'
import { render, fitToWalls } from '../renderer/render.js'
import { loadStudioTemplate } from './templates.js'
import { initViewport } from '../interaction/viewport.js'
import { initPointer } from '../interaction/pointer.js'
import { pickNormalWallAt, pickWallHandleAt } from '../engine/pick.js'
import {
    smartSnapPoint,
    isSegmentAllowed,
    isSegmentClearOfCapitals,
} from '../engine/constraints.js'
import { normalizeNormalWall } from '../engine/normalize-wall.js'

// ✅ метрики
import {
    getSelectedWall,
    wallLengthM,
    totalNormalLengthM,
    capitalAreaM2,
    fmtM,
    fmtM2,
} from '../engine/metrics.js'

const workspace = document.getElementById('workspace')
const draw = createSVG(workspace)

// coarse = мобилки/планшеты (hover не нужен)
const isTouchLike = matchMedia('(pointer: coarse)').matches

// -------- id generator for user walls --------
let wallAutoId = 10000
const newWallId = () => `u${Date.now()}_${wallAutoId++}`

// -------- UI refs --------
const btnWall = document.getElementById('btn-wall')
const btnTrash = document.getElementById('btn-trash')
const hint = document.getElementById('hint')
const status = document.getElementById('status')

// ---------------- render throttle ----------------
let raf = 0
function scheduleRerender() {
    if (raf) return
    raf = requestAnimationFrame(() => {
        raf = 0
        rerender()
    })
}

// ---------------- status / delete btn ----------------
function updateDeleteButtonState() {
    if (!btnTrash) return

    const sel = state.selectedWallId

    // во время рисования стен — удаление отключаем
    if (state.mode === 'draw-wall' || !sel) {
        btnTrash.classList.add('is-disabled')
        btnTrash.classList.remove('is-danger')
        return
    }

    const w = state.walls.find(w => w.id === sel)

    // нельзя удалять capital или если стену не нашли
    if (!w || w.kind === 'capital') {
        btnTrash.classList.add('is-disabled')
        btnTrash.classList.remove('is-danger')
        return
    }

    // можно удалять normal
    btnTrash.classList.remove('is-disabled')
    btnTrash.classList.add('is-danger')
}

function updateStatus() {
    if (!status) return

    const area = capitalAreaM2()
    const sum = totalNormalLengthM()
    const sel = getSelectedWall()

    if (state.mode === 'draw-wall') {
        status.textContent = `Режим: Wall | Сумма стен: ${fmtM(sum)} м | Площадь: ${fmtM2(area)} м²`
        return
    }

    if (sel) {
        const len = wallLengthM(sel)
        status.textContent = `Select | ${sel.id}: ${fmtM(len)} м | Сумма normal: ${fmtM(sum)} м | Площадь: ${fmtM2(area)} м²`
    } else {
        status.textContent = `Select | Сумма normal: ${fmtM(sum)} м | Площадь: ${fmtM2(area)} м²`
    }
}

function rerender() {
    render(draw)
    updateStatus()
    updateDeleteButtonState()
}

// ---------------- pan / dpad ----------------
function panBy(dx, dy) {
    state.view.offsetX += dx
    state.view.offsetY += dy
    rerender()
}

function initDPad() {
    const root = document.getElementById('dpad')
    if (!root) return

    const STEP = 40 // px за тик
    const FIRST_DELAY = 140
    const REPEAT_MS = 30

    let timer = null
    let repeater = null

    const dirToDelta = (dir) => {
        switch (dir) {
            case 'up': return { dx: 0, dy: STEP }
            case 'down': return { dx: 0, dy: -STEP }
            case 'left': return { dx: STEP, dy: 0 }
            case 'right': return { dx: -STEP, dy: 0 }
            default: return { dx: 0, dy: 0 }
        }
    }

    const stop = () => {
        if (timer) clearTimeout(timer)
        if (repeater) clearInterval(repeater)
        timer = null
        repeater = null
        root.querySelectorAll('.dpad__btn.is-pressed').forEach(b => b.classList.remove('is-pressed'))
    }

    const startRepeat = (btn, dir) => {
        stop()
        btn.classList.add('is-pressed')

        if (dir === 'center') {
            fitToWalls(draw, { padding: 240, maxScale: 1.1 })
            rerender()
            setTimeout(stop, 0)
            return
        }

        const { dx, dy } = dirToDelta(dir)
        panBy(dx, dy)

        timer = setTimeout(() => {
            repeater = setInterval(() => panBy(dx, dy), REPEAT_MS)
        }, FIRST_DELAY)
    }

    root.addEventListener('pointerdown', (e) => {
        const btn = e.target.closest('.dpad__btn')
        if (!btn) return
        e.preventDefault?.()
        btn.setPointerCapture?.(e.pointerId)
        startRepeat(btn, btn.dataset.pan)
    }, { passive: false })

    root.addEventListener('pointerup', stop)
    root.addEventListener('pointercancel', stop)
    root.addEventListener('pointerleave', stop)

    window.addEventListener('blur', stop)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stop()
    })
}

// ---------------- cursor center (desktop only) ----------------
function placeCursorAtViewportCenter() {
    const rect = draw.node.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const raw = screenToWorld(draw, cx, cy)

    state.snapPoint = smartSnapPoint(raw, null, {
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

    state.cursorState = 'idle'
}

// -------- mode helpers --------
function setMode(mode) {
    state.mode = mode
    state.previewWall = null
    state.draft = null
    state.edit = null

    state.ui = state.ui || {}
    state.ui.lockPan = false

    if (mode === 'draw-wall') {
        state.selectedWallId = null
        state.hoverWallId = null

        // ✅ и на мобиле, и на десктопе — НЕ ставим точку в центр
        state.snapPoint = null
        state.cursorState = 'idle'
    }
    else {
        state.cursorState = 'idle'
        state.snapPoint = null
    }

    syncUI()
    rerender()
}

function syncUI() {
    const isWall = state.mode === 'draw-wall'
    btnWall?.classList.toggle('is-active', isWall)

    if (hint) {
        hint.textContent = isWall
            ? 'Wall: на мобиле — только drag. На десктопе — клик A, клик B. ESC — отмена.'
            : 'Клик по стене — выделить. Drag по стене/хэндлам — редактировать. Drag по пустому — панорамирование.'
    }
}

btnWall?.addEventListener('click', () =>
    setMode(state.mode === 'draw-wall' ? 'idle' : 'draw-wall')
)

// -------- delete selected --------
function deleteSelectedWall() {
    const id = state.selectedWallId
    if (!id) return

    const idx = state.walls.findIndex(w => w.id === id)
    if (idx === -1) return
    if (state.walls[idx].kind === 'capital') return

    state.walls.splice(idx, 1)
    state.selectedWallId = null
    scheduleRerender()
}

window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    const tag = document.activeElement?.tagName?.toLowerCase()
    if (tag === 'input' || tag === 'textarea') return
    deleteSelectedWall()
})

btnTrash?.addEventListener('click', deleteSelectedWall)

// -------- zoom UI --------
document.getElementById('zoom-in')?.addEventListener('click', () => {
    setZoomAtCenter(draw, Math.min(5, state.view.scale * 1.2))
    scheduleRerender()
})
document.getElementById('zoom-out')?.addEventListener('click', () => {
    setZoomAtCenter(draw, Math.max(0.2, state.view.scale / 1.2))
    scheduleRerender()
})
document.getElementById('zoom-reset')?.addEventListener('click', () => {
    fitToWalls(draw, { padding: 240, maxScale: 1.1 })
    scheduleRerender()
})

// -------- init interactions --------
initViewport(draw)
initPointer(draw, { newWallId })
initDPad()
window.addEventListener('planner:changed', scheduleRerender)

// -------- hover highlight (mouse only, throttled, disabled while edit/pan) --------

function findWallIdFromEventTarget(target) {
    let el = target
    while (el && el !== draw.node) {
        if (el.getAttribute) {
            const id = el.getAttribute('data-wall-id')
            if (id) return id
        }
        el = el.parentNode
    }
    return null
}

draw.node.addEventListener('pointermove', (e) => {
    if (isTouchLike) return

    // hover выключаем в draw
    if (state.mode === 'draw-wall') {
        if (state.hoverWallId) {
            state.hoverWallId = null
            scheduleRerender()
        }
        return
    }

    // ✅ когда редактируем стену/хэндл или панорамируем — hover отключаем
    if (state.edit || state.ui?.lockPan || state.ui?.dragged) {
        if (state.hoverWallId) {
            state.hoverWallId = null
            scheduleRerender()
        }
        return
    }

    const id = findWallIdFromEventTarget(e.target)
    if (id !== state.hoverWallId) {
        state.hoverWallId = id
        scheduleRerender()
    }
})

draw.node.addEventListener('pointerleave', () => {
    if (state.hoverWallId) {
        state.hoverWallId = null
        scheduleRerender()
    }
})

// ---------------- SELECT: move + resize ----------------
function getWallById(id) {
    return (state.walls || []).find(w => w.id === id) || null
}

function startEdit(kind, wallId, mouseWorld) {
    const w = getWallById(wallId)
    if (!w || w.kind === 'capital') return

    state.ui = state.ui || {}
    state.ui.lockPan = true

    // ✅ пока тащим — hover отключаем, чтобы не подсвечивать другие стены
    state.hoverWallId = null

    state.edit = {
        id: wallId,
        kind, // 'move' | 'a' | 'b'
        startMouse: { ...mouseWorld },

        // видимые
        startA: { ...w.a },
        startB: { ...w.b },

        // строительные
        startVA: { ...(w.va || w.a) },
        startVB: { ...(w.vb || w.b) },
    }
}

function stopEdit() {
    state.edit = null
    state.ui = state.ui || {}
    state.ui.lockPan = false
}

/* ------------------ SNAP + TRIM TO CAPITALS (for edit) ------------------ */

const clamp2 = (v, a, b) => Math.max(a, Math.min(b, v))

function projectPointToSegmentClamped(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y
    const apx = p.x - a.x, apy = p.y - a.y
    const ab2 = abx * abx + aby * aby

    if (ab2 < 1e-9) {
        const d = Math.hypot(p.x - a.x, p.y - a.y)
        return { point: { ...a }, d }
    }

    let t = (apx * abx + apy * aby) / ab2
    t = clamp2(t, 0, 1)
    const q = { x: a.x + abx * t, y: a.y + aby * t }
    const d = Math.hypot(p.x - q.x, p.y - q.y)
    return { point: q, d }
}

function trimPointBack(from, to, trimLen) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    return { x: to.x - ux * trimLen, y: to.y - uy * trimLen }
}

function nearestPointOnCapitals(p) {
    const caps = (state.walls || []).filter(w => w && w.kind === 'capital')
    if (!caps.length) return null

    let best = null
    for (const c of caps) {
        const pr = projectPointToSegmentClamped(p, c.a, c.b)
        if (!best || pr.d < best.d) best = pr
    }
    return best
}

function snapTrimEndToCapital(end, otherEnd, snapPx = 22) {
    const scale = Math.max(1e-6, state.view.scale)
    const tolWorld = snapPx / scale

    const hit = nearestPointOnCapitals(end)
    if (!hit || hit.d > tolWorld) return null

    const trimLen = (CAP_W / 2) + (NOR_W / 2) - OVERLAP
    return trimPointBack(otherEnd, hit.point, trimLen)
}

function snapWholeSegmentToCapital(a, b, snapPx = 22) {
    const aTrim = snapTrimEndToCapital(a, b, snapPx)
    const bTrim = snapTrimEndToCapital(b, a, snapPx)
    if (!aTrim && !bTrim) return { a, b }

    const da = aTrim ? Math.hypot(aTrim.x - a.x, aTrim.y - a.y) : Infinity
    const db = bTrim ? Math.hypot(bTrim.x - b.x, bTrim.y - b.y) : Infinity

    const useA = da <= db
    const target = useA ? aTrim : bTrim
    const src = useA ? a : b

    const dx = target.x - src.x
    const dy = target.y - src.y

    return {
        a: { x: a.x + dx, y: a.y + dy },
        b: { x: b.x + dx, y: b.y + dy },
    }
}

function applyEdit(mouseWorld) {
    const ed = state.edit
    if (!ed) return
    const w = getWallById(ed.id)
    if (!w) return

    const dx = mouseWorld.x - ed.startMouse.x
    const dy = mouseWorld.y - ed.startMouse.y

    let newVA = { ...ed.startVA }
    let newVB = { ...ed.startVB }

    const snapOpts = {
        grid: GRID_STEP_SNAP,
        snapPx: 14,
        axisPx: 10,
        toGrid: true,
        toPoints: true,
        toAxis: true,
        toCapital: true,
        toNormals: true,
    }

    if (ed.kind === 'move') {
        let movedA = { x: ed.startVA.x + dx, y: ed.startVA.y + dy }

        movedA = smartSnapPoint(movedA, null, {
            ...snapOpts,
            toAxis: false,
            toCapital: false,
            toNormals: false,
        })

        const offX = ed.startVB.x - ed.startVA.x
        const offY = ed.startVB.y - ed.startVA.y

        newVA = movedA
        newVB = { x: movedA.x + offX, y: movedA.y + offY }
    }

    if (ed.kind === 'a') {
        newVA = { x: ed.startVA.x + dx, y: ed.startVA.y + dy }
        newVA = smartSnapPoint(newVA, newVB, snapOpts)
    }

    if (ed.kind === 'b') {
        newVB = { x: ed.startVB.x + dx, y: ed.startVB.y + dy }
        newVB = smartSnapPoint(newVB, newVA, snapOpts)
    }

    // ✅ сначала базовая проверка по строительной геометрии (пересечения и т.п.)
    if (!isSegmentAllowed(newVA, newVB, { ignoreWallId: ed.id })) return

    // ✅ сохраняем текущее состояние стены для отката
    const old = {
        a: { ...w.a },
        b: { ...w.b },
        va: { ...(w.va || w.a) },
        vb: { ...(w.vb || w.b) },
    }

    // ✅ применяем строительную геометрию
    w.va = newVA
    w.vb = newVB

    // ✅ нормализуем (тут появляется визуальный trim a/b)
    normalizeNormalWall(w, { snapPx: 22, doTrim: true })

    // ✅ clear проверяем ПОСЛЕ normalize по ВИДИМОЙ геометрии
    const clearOpts =
        (ed.kind === 'move')
            ? { endGuard: 0, samples: 32 }      // при переносе проверяем даже концы
            : { endGuard: 0.06, samples: 32 }   // при ресайзе оставляем “пристыковку”

    if (!isSegmentClearOfCapitals(w.a, w.b, CLEAR_FROM_CAPITAL, clearOpts)) {
        // ❌ нельзя — откатываем
        w.a = old.a
        w.b = old.b
        w.va = old.va
        w.vb = old.vb
        return
    }

    // ✅ всё ок — фиксируем: va/vb должны соответствовать newVA/newVB
    w.va = newVA
    w.vb = newVB
}


// pointerdown: выбираем, что делаем
draw.node.addEventListener('pointerdown', (e) => {
    if (state.mode === 'draw-wall') return
    if (e.button !== 0 && e.pointerType === 'mouse') return

    // если уже идёт пан — не стартуем edit
    if (state.ui?.dragged) return

    const p = screenToWorld(draw, e.clientX, e.clientY)

    const h = typeof pickWallHandleAt === 'function'
        ? pickWallHandleAt(p, { tolPx: 14 })
        : null

    if (h) {
        state.selectedWallId = h.id
        startEdit(h.handle, h.id, p)
        scheduleRerender()
        return
    }

    const id = pickNormalWallAt(p, { tolPx: 16 })
    if (id) {
        state.selectedWallId = id
        startEdit('move', id, p)
        scheduleRerender()
        return
    }

    state.selectedWallId = null
    scheduleRerender()
})

draw.node.addEventListener('pointermove', (e) => {
    if (state.mode === 'draw-wall') return
    if (!state.edit) return
    const p = screenToWorld(draw, e.clientX, e.clientY)
    applyEdit(p)
    scheduleRerender()
})

draw.node.addEventListener('pointerup', () => {
    if (state.mode === 'draw-wall') return
    if (!state.edit) return
    stopEdit()
    scheduleRerender()
})

draw.node.addEventListener('pointercancel', () => {
    if (!state.edit) return
    stopEdit()
    scheduleRerender()
})

// -------- start --------
syncUI()
loadStudioTemplate()

requestAnimationFrame(() => {
    fitToWalls(draw, { padding: 240, maxScale: 1.1 })
    rerender()
})

// resize (один)
let rafResize = 0
window.addEventListener('resize', () => {
    cancelAnimationFrame(rafResize)
    rafResize = requestAnimationFrame(() => {
        fitToWalls(draw, { padding: 240, maxScale: 1.1 })
        rerender()
    })
})

// удобно для дебага в консоли
window.state = state
