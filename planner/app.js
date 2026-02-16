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

// -------- id generator for user walls --------
let wallAutoId = 10000
const newWallId = () => `u${Date.now()}_${wallAutoId++}`

// -------- UI refs --------
const btnSelect = document.getElementById('btn-select')
const btnWall = document.getElementById('btn-wall')
const btnTrash = document.getElementById('btn-trash')
const hint = document.getElementById('hint')
const status = document.getElementById('status')

// ---------------- status metrics ----------------
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
}

// -------- mode helpers --------
function setMode(mode) {
    state.mode = mode
    state.previewWall = null
    state.draft = null
    state.selectedWallId = null
    state.edit = null
    state.ui = state.ui || {}
    state.ui.lockPan = false

    syncUI()
    rerender()
}

function syncUI() {
    const isWall = state.mode === 'draw-wall'
    btnSelect?.classList.toggle('is-active', !isWall)
    btnWall?.classList.toggle('is-active', isWall)

    if (hint) {
        hint.textContent = isWall
            ? 'Wall: клик — первая точка, клик — вторая точка. ESC — отмена.'
            : 'Select: клик/таскай стену или ручку. Delete — удалить. Перетаскивай пустоту для панорамирования.'
    }
}

btnSelect?.addEventListener('click', () => setMode('select'))
btnWall?.addEventListener('click', () => setMode(state.mode === 'draw-wall' ? 'select' : 'draw-wall'))

// -------- delete selected --------
function deleteSelectedWall() {
    const id = state.selectedWallId
    if (!id) return

    const idx = state.walls.findIndex(w => w.id === id)
    if (idx === -1) return
    if (state.walls[idx].kind === 'capital') return

    state.walls.splice(idx, 1)
    state.selectedWallId = null
    rerender()
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
    rerender()
})
document.getElementById('zoom-out')?.addEventListener('click', () => {
    setZoomAtCenter(draw, Math.max(0.2, state.view.scale / 1.2))
    rerender()
})
document.getElementById('zoom-reset')?.addEventListener('click', () => {
    fitToWalls(draw, { padding: 240, maxScale: 1.1 })
    rerender()
})

// -------- init interactions --------
initViewport(draw)
initPointer(draw, { newWallId })

// ---------------- SELECT: move + resize ----------------
function getWallById(id) {
    return (state.walls || []).find(w => w.id === id) || null
}

function startEdit(kind, wallId, mouseWorld) {
    const w = getWallById(wallId)
    if (!w || w.kind === 'capital') return

    state.ui = state.ui || {}
    state.ui.lockPan = true

    state.edit = {
        id: wallId,
        kind, // 'move' | 'a' | 'b'
        startMouse: { ...mouseWorld },
        startA: { ...w.a },
        startB: { ...w.b },
    }
}

function stopEdit() {
    state.edit = null
    state.ui = state.ui || {}
    state.ui.lockPan = false
}

/* ------------------ SNAP + TRIM TO CAPITALS (for edit) ------------------ */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

function projectPointToSegmentClamped(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y
    const apx = p.x - a.x, apy = p.y - a.y
    const ab2 = abx * abx + aby * aby

    if (ab2 < 1e-9) {
        const d = Math.hypot(p.x - a.x, p.y - a.y)
        return { point: { ...a }, d }
    }

    let t = (apx * abx + apy * aby) / ab2
    t = clamp(t, 0, 1)
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
    return best // { point, d }
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

    let newA = { ...ed.startA }
    let newB = { ...ed.startB }

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
        // 1) грубый перенос
        let movedA = { x: ed.startA.x + dx, y: ed.startA.y + dy }
        let movedB = { x: ed.startB.x + dx, y: ed.startB.y + dy }

        // 2) перенос по сетке (без прилипания к стенам)
        movedA = smartSnapPoint(movedA, null, {
            ...snapOpts,
            toAxis: false,
            toCapital: false,
            toNormals: false,
        })
        movedB = {
            x: movedA.x + (ed.startB.x - ed.startA.x),
            y: movedA.y + (ed.startB.y - ed.startA.y),
        }

        // 3) дожим всей стены к капитальным + подрезка
        const snapped = snapWholeSegmentToCapital(movedA, movedB, 22)
        newA = snapped.a
        newB = snapped.b
    }

    if (ed.kind === 'a') {
        newA = { x: ed.startA.x + dx, y: ed.startA.y + dy }
        newA = smartSnapPoint(newA, newB, snapOpts)

        const t = snapTrimEndToCapital(newA, newB, 22)
        if (t) newA = t
    }

    if (ed.kind === 'b') {
        newB = { x: ed.startB.x + dx, y: ed.startB.y + dy }
        newB = smartSnapPoint(newB, newA, snapOpts)

        const t = snapTrimEndToCapital(newB, newA, 22)
        if (t) newB = t
    }

    // ✅ ВАЖНО: запрет “утопить” normal внутрь капитальной
    // (ставим после того, как точки посчитаны!)
    if (!isSegmentClearOfCapitals(newA, newB, CLEAR_FROM_CAPITAL)) return

    if (!isSegmentAllowed(newA, newB, { ignoreWallId: ed.id })) return

    w.a = newA
    w.b = newB
}

// pointerdown: выбираем, что делаем
draw.node.addEventListener('pointerdown', (e) => {
    if (state.mode !== 'select') return
    if (e.button !== 0 && e.pointerType === 'mouse') return

    const p = screenToWorld(draw, e.clientX, e.clientY)

    const h = typeof pickWallHandleAt === 'function'
        ? pickWallHandleAt(p, { tolPx: 14 })
        : null

    if (h) {
        state.selectedWallId = h.id
        startEdit(h.handle, h.id, p) // 'a'/'b'
        rerender()
        return
    }

    const id = pickNormalWallAt(p, { tolPx: 16 })
    if (id) {
        state.selectedWallId = id
        startEdit('move', id, p)
        rerender()
        return
    }

    state.selectedWallId = null
    rerender()
})

draw.node.addEventListener('pointermove', (e) => {
    if (state.mode !== 'select') return
    if (!state.edit) return
    const p = screenToWorld(draw, e.clientX, e.clientY)
    applyEdit(p)
    rerender()
})

draw.node.addEventListener('pointerup', () => {
    if (state.mode !== 'select') return
    if (!state.edit) return
    stopEdit()
    rerender()
})

draw.node.addEventListener('pointercancel', () => {
    if (!state.edit) return
    stopEdit()
    rerender()
})

// -------- start --------
syncUI()
loadStudioTemplate()

requestAnimationFrame(() => {
    fitToWalls(draw, { padding: 240, maxScale: 1.1 })
    rerender()
})

// resize (один)
let raf = 0
window.addEventListener('resize', () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
        fitToWalls(draw, { padding: 240, maxScale: 1.1 })
        rerender()
    })
})

// удобно для дебага в консоли
window.state = state
