// planner/app.js
import { state } from '../engine/state.js'
import { createSVG, setZoomAtCenter, screenToWorld } from '../renderer/svg.js'
import { render, fitToWalls } from '../renderer/render.js'
import { loadStudioTemplate } from './templates.js'
import { initViewport } from '../interaction/viewport.js'
import { initPointer } from '../interaction/pointer.js'
import { pickNormalWallAt, pickWallHandleAt } from '../engine/pick.js'
import { smartSnapPoint, isSegmentAllowed } from '../engine/constraints.js'

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
btnWall?.addEventListener('click', () =>
    setMode(state.mode === 'draw-wall' ? 'select' : 'draw-wall')
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
    state.view.scale = 1
    state.view.offsetX = 0
    state.view.offsetY = 0
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

function applyEdit(mouseWorld) {
    const ed = state.edit
    if (!ed) return
    const w = getWallById(ed.id)
    if (!w) return

    const dx = mouseWorld.x - ed.startMouse.x
    const dy = mouseWorld.y - ed.startMouse.y

    let newA = { ...ed.startA }
    let newB = { ...ed.startB }

    if (ed.kind === 'move') {
        newA = { x: ed.startA.x + dx, y: ed.startA.y + dy }
        newB = { x: ed.startB.x + dx, y: ed.startB.y + dy }
    } else if (ed.kind === 'a') {
        newA = { x: ed.startA.x + dx, y: ed.startA.y + dy }
    } else if (ed.kind === 'b') {
        newB = { x: ed.startB.x + dx, y: ed.startB.y + dy }
    }

    const snapOpts = {
        grid: 50,
        snapPx: 14,
        axisPx: 10,
        toGrid: true,
        toPoints: true,
        toAxis: true,
        toCapital: true,
        toNormals: true,
    }

    if (ed.kind === 'a') newA = smartSnapPoint(newA, newB, snapOpts)
    if (ed.kind === 'b') newB = smartSnapPoint(newB, newA, snapOpts)

    if (ed.kind === 'move') {
        newA = smartSnapPoint(newA, null, {
            ...snapOpts,
            toAxis: false,
            toCapital: false,
            toNormals: false,
        })
        newB = {
            x: newA.x + (ed.startB.x - ed.startA.x),
            y: newA.y + (ed.startB.y - ed.startA.y),
        }
    }

    if (!isSegmentAllowed(newA, newB, { ignoreWallId: ed.id })) return

    w.a = newA
    w.b = newB
}

// pointerdown: выбираем, что делаем
draw.node.addEventListener('pointerdown', (e) => {
    if (state.mode !== 'select') return
    if (e.button !== 0 && e.pointerType === 'mouse') return

    const p = screenToWorld(draw, e.clientX, e.clientY)

    const h = typeof pickWallHandleAt === 'function' ? pickWallHandleAt(p, { tolPx: 14 }) : null
    if (h) {
        state.selectedWallId = h.id
        startEdit(h.handle, h.id, p)
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
