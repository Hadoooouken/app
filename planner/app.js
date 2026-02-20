// planner/app.js
import {
  state,
  GRID_STEP_SNAP,
  CLEAR_FROM_CAPITAL,
  CAP_W,
  NOR_W,
  OVERLAP,
} from '../engine/state.js'

import { historyCommit, historyBegin, historyEnd, undo, redo } from '../engine/history.js'

import { createSVG, setZoomAtCenter, screenToWorld } from '../renderer/svg.js'
import { render, fitToWalls } from '../renderer/render.js'
import { loadStudioTemplate } from './templates.js'
import { initViewport } from '../interaction/viewport.js'
import { initPointer } from '../interaction/pointer.js'
import { pickNormalWallAt, pickWallHandleAt } from '../engine/pick.js'
import { smartSnapPoint, isSegmentAllowed, isSegmentClearOfCapitals } from '../engine/constraints.js'
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

function setPlannerCursor(cursor) {
  draw.node.style.cursor = cursor
}

// coarse = мобилки/планшеты (для допусков/UX), НЕ ДЛЯ отключения hover
const isTouchLike = matchMedia('(pointer: coarse)').matches

// -------- id generator for user walls --------
let wallAutoId = 10000
const newWallId = () => `u${Date.now()}_${wallAutoId++}`

// -------- id generator for doors --------
const newDoorId = () => `d${Date.now()}_${Math.random().toString(16).slice(2)}`

// -------- UI refs --------
const btnWall = document.getElementById('btn-wall')
const btnTrash = document.getElementById('btn-trash')
const btnDoor = document.getElementById('btn-door')
const hint = document.getElementById('hint')
const status = document.getElementById('status')

function panBy(dx, dy) {
  state.view.offsetX += dx
  state.view.offsetY += dy
  rerender()
}

function initDPad() {
  const root = document.getElementById('dpad')
  if (!root) return

  const STEP = 40
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
    root.querySelectorAll('.dpad__btn.is-pressed')
      .forEach(b => b.classList.remove('is-pressed'))
  }

  const startRepeat = (btn, dir) => {
    stop()
    btn.classList.add('is-pressed')

    if (dir === 'center') {
      fitPlannerToWalls()
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
    e.preventDefault()
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

// ---------------- render throttle ----------------
let raf = 0
function scheduleRerender() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    rerender()
  })
}

function rerender() {
  render(draw)
  updateStatus()
  updateDeleteButtonState()
  updateDoorButtonState()
}

// ---------------- helpers: find ids from SVG target ----------------
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

function findDoorIdFromEventTarget(target) {
  let el = target
  while (el && el !== draw.node) {
    if (el.getAttribute) {
      const id = el.getAttribute('data-door-id')
      if (id) return id
    }
    el = el.parentNode
  }
  return null
}

// ---------------- fit helpers (padding via CSS vars) ----------------
function getFitPaddingPx() {
  const rect = draw.node.getBoundingClientRect()
  const css = getComputedStyle(document.documentElement)

  const padInlinePct = parseFloat(css.getPropertyValue('--planner-pad-inline')) || 10
  const padBlockPct = parseFloat(css.getPropertyValue('--planner-pad-block')) || 10

  const padMin = parseFloat(css.getPropertyValue('--planner-pad-min')) || 24
  const padMax = parseFloat(css.getPropertyValue('--planner-pad-max')) || 320

  const mult = parseFloat(css.getPropertyValue('--planner-fit-mult')) || 1

  const pxX = (rect.width * padInlinePct) / 100
  const pxY = (rect.height * padBlockPct) / 100

  let padding = Math.min(pxX, pxY) * mult
  padding = Math.max(padMin, Math.min(padMax, padding))
  return padding
}

function getPlannerMaxScale() {
  const css = getComputedStyle(document.documentElement)
  return parseFloat(css.getPropertyValue('--planner-max-scale')) || 1.1
}

function fitPlannerToWalls() {
  fitToWalls(draw, { padding: getFitPaddingPx(), maxScale: getPlannerMaxScale() })
}

// ---------------- status / delete btn ----------------
function updateDeleteButtonState() {
  if (!btnTrash) return

  // Во время рисования стен/дверей — удаление отключаем
  if (state.mode === 'draw-wall' || state.mode === 'draw-door') {
    btnTrash.classList.add('is-disabled')
    btnTrash.classList.remove('is-danger')
    return
  }

  // 1) Если выбрана дверь — можно удалить только interior
  if (state.selectedDoorId) {
    const d = (state.doors || []).find(x => x.id === state.selectedDoorId)
    const ok = !!d && d.kind === 'interior' && !d.locked
    btnTrash.classList.toggle('is-disabled', !ok)
    btnTrash.classList.toggle('is-danger', ok)
    return
  }

  // 2) Если выбрана стена — можно удалить только normal
  const wallId = state.selectedWallId
  if (!wallId) {
    btnTrash.classList.add('is-disabled')
    btnTrash.classList.remove('is-danger')
    return
  }

  const w = (state.walls || []).find(w => w.id === wallId)
  const ok = !!w && w.kind === 'normal'
  btnTrash.classList.toggle('is-disabled', !ok)
  btnTrash.classList.toggle('is-danger', ok)
}

function updateDoorButtonState() {
  if (!btnDoor) return
  // в режиме draw-wall запрещаем, в остальном — всегда можно включить режим двери
  const ok = state.mode !== 'draw-wall'
  btnDoor.classList.toggle('is-disabled', !ok)
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

  if (state.selectedDoorId) {
    status.textContent = `Select | Door: ${state.selectedDoorId} | Сумма normal: ${fmtM(sum)} м | Площадь: ${fmtM2(area)} м²`
    return
  }

  if (sel) {
    const len = wallLengthM(sel)
    status.textContent = `Select | ${sel.id}: ${fmtM(len)} м | Сумма normal: ${fmtM(sum)} м | Площадь: ${fmtM2(area)} м²`
  } else {
    status.textContent = `Select | Сумма normal: ${fmtM(sum)} м | Площадь: ${fmtM2(area)} м²`
  }
}

// ---------------- mode helpers ----------------
function setMode(mode) {
  state.mode = mode
  state.previewWall = null
  state.draft = null
  state.edit = null

  state.ui = state.ui || {}
  state.ui.lockPan = false
  

  if (mode === 'draw-wall') {
    state.selectedWallId = null
    state.selectedDoorId = null
    state.hoverWallId = null
    state.snapPoint = null
    state.cursorState = 'idle'
  } else {
    state.cursorState = 'idle'
    state.snapPoint = null
  }

  if (mode === 'draw-door') {
    state.selectedWallId = null
    state.selectedDoorId = null
    state.hoverWallId = null
    state.previewDoor = null
  }
  if (mode !== 'draw-door') {
    state.previewDoor = null
  }
setPlannerCursor('default')
  syncUI()
  rerender()
}

function syncUI() {
  const isWall = state.mode === 'draw-wall'
  const isDoor = state.mode === 'draw-door'
  btnWall?.classList.toggle('is-active', isWall)
  btnDoor?.classList.toggle('is-active', isDoor)

  if (hint) {
    hint.textContent = isWall
      ? 'Wall: на мобиле — только drag. На десктопе — клик A, клик B. ESC — отмена.'
      : 'Клик по стене — выделить. Drag по стене/хэндлам — редактировать. Drag по пустому — панорамирование.'
  }
}

btnWall?.addEventListener('click', () =>
  setMode(state.mode === 'draw-wall' ? 'idle' : 'draw-wall')
)

btnDoor?.addEventListener('click', (e) => {
  e.preventDefault()
  setMode(state.mode === 'draw-door' ? 'idle' : 'draw-door')
})

// ---------------- delete selected wall/door ----------------
function deleteSelectedElement() {
  // 0) Не удаляем во время рисования
  if (state.mode === 'draw-wall' || state.mode === 'draw-door') return

  // 1) Если выбрана дверь — удаляем её (только interior)
  if (state.selectedDoorId) {
    const id = state.selectedDoorId
    const d = (state.doors || []).find(x => x.id === id)
    if (!d || d.kind !== 'interior' || d.locked) return

    const idx = (state.doors || []).findIndex(x => x.id === id)
    if (idx === -1) return

    historyCommit('delete-door')
    state.doors.splice(idx, 1)
    state.selectedDoorId = null
    scheduleRerender()
    return
  }

  // 2) Иначе — удаляем стену (только normal)
  const wallId = state.selectedWallId
  if (!wallId) return

  const wIdx = (state.walls || []).findIndex(w => w.id === wallId)
  if (wIdx === -1) return
  if (state.walls[wIdx].kind !== 'normal') return

  historyCommit('delete-wall')
  state.walls.splice(wIdx, 1)

  // двери на этой стене — удалить тоже (и entry, и interior)
  state.doors = (state.doors || []).filter(d => d.wallId !== wallId)

  state.selectedWallId = null
  scheduleRerender()
}

btnTrash?.addEventListener('click', deleteSelectedElement)

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return
  const tag = document.activeElement?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea') return
  deleteSelectedElement()
})

// ---------------- undo/redo hotkeys ----------------
window.addEventListener('keydown', (e) => {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (!mod) return

  if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault()
    if (undo()) rerender()
    return
  }

  if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
    e.preventDefault()
    if (redo()) rerender()
    return
  }
})

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
  fitPlannerToWalls()
  scheduleRerender()
})

// -------- init interactions --------
initViewport(draw)
initPointer(draw, { newWallId })
initDPad()
window.addEventListener('planner:changed', scheduleRerender)

// -------- undo/redo buttons --------
const btnUndo = document.getElementById('undo')
const btnRedo = document.getElementById('redo')

function resetInteractionState() {
  // выйти из wall drag / door drag / preview
  state.edit = null
  state.previewWall = null
  state.ui = state.ui || {}
  state.ui.lockPan = false

  // важное: дверь тоже может быть в drag
  if (typeof stopDoorDrag === 'function') stopDoorDrag()
}

function applyUndo() {
  resetInteractionState()
  state.selectedWallId = null
  state.selectedDoorId = null
  if (undo()) rerender()
}

function applyRedo() {
  resetInteractionState()
  state.selectedWallId = null
  state.selectedDoorId = null
  if (redo()) rerender()
}

btnUndo?.addEventListener('click', (e) => {
  e.preventDefault()
  applyUndo()
})

btnRedo?.addEventListener('click', (e) => {
  e.preventDefault()
  applyRedo()
})

// ---------------- DOORS: add + select + drag ----------------
function getDoorById(id) {
  return (state.doors || []).find(d => d.id === id) || null
}

function clampDoorTToWall(door, wall) {
  const a = wall.a, b = wall.b
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const half = (door.w ?? 75) / 2
  const marginT = Math.min(0.49, half / len)
  door.t = Math.max(marginT, Math.min(1 - marginT, door.t ?? 0.5))
}

function projectPointToWallT(p, a, b) {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const apx = p.x - a.x
  const apy = p.y - a.y
  const ab2 = abx * abx + aby * aby
  if (ab2 < 1e-9) return 0.5
  return (apx * abx + apy * aby) / ab2
}

function clampDoorTToWallParams(t, doorW, wall) {
  const a = wall.a, b = wall.b
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const half = doorW / 2
  const marginT = Math.min(0.49, half / len)
  return Math.max(marginT, Math.min(1 - marginT, t))
}

function updateDoorPreviewAtPoint(p) {
  // курсор по умолчанию, дальше можем переключить на crosshair
  setPlannerCursor('default')

  const wallId = pickNormalWallAt(p, { tolPx: isTouchLike ? 22 : 18 })
  if (!wallId) {
    if (state.previewDoor) {
      state.previewDoor = null
      scheduleRerender()
    }
    return
  }

  const w = (state.walls || []).find(x => x.id === wallId)
  if (!w || w.kind !== 'normal') {
    if (state.previewDoor) {
      state.previewDoor = null
      scheduleRerender()
    }
    return
  }

  // ✅ если на этой стене уже есть interior-дверь — preview не показываем
  const hasDoor = (state.doors || []).some(d =>
    d.wallId === wallId && d.kind === 'interior' && !d.locked
  )
  if (hasDoor) {
    if (state.previewDoor) {
      state.previewDoor = null
      scheduleRerender()
    }
    return
  }

  // ✅ сюда дошли значит можно ставить дверь → курсор crosshair
  setPlannerCursor('pointer')

  let t = projectPointToWallT(p, w.a, w.b)
  t = clampDoorTToWallParams(t, 75, w)

  const next = { wallId, t, w: 75, thick: NOR_W }
  const prev = state.previewDoor
  const changed =
    !prev ||
    prev.wallId !== next.wallId ||
    Math.abs((prev.t ?? 0) - next.t) > 1e-4

  if (changed) {
    state.previewDoor = next
    scheduleRerender()
  }
}

let doorEdit = null
let doorPlace = null // режим "ставим дверь": pointerId

function startDoorDrag(doorId) {
  const d = getDoorById(doorId)
  if (!d || d.kind !== 'interior' || d.locked) return

  const w = (state.walls || []).find(x => x.id === d.wallId)
  if (!w) return

  historyBegin('move-door')

  state.ui = state.ui || {}
  state.ui.lockPan = true
  state.hoverWallId = null

  doorEdit = { id: doorId }
}

function applyDoorDrag(mouseWorld) {
  if (!doorEdit) return
  const d = getDoorById(doorEdit.id)
  if (!d) return

  const w = (state.walls || []).find(x => x.id === d.wallId)
  if (!w) return

  d.t = projectPointToWallT(mouseWorld, w.a, w.b)
  clampDoorTToWall(d, w)
}

function stopDoorDrag() {
  if (!doorEdit) return
  doorEdit = null

  state.ui = state.ui || {}
  state.ui.lockPan = false

  historyEnd()
}

function nudgeSelectedDoorByArrow(key) {
  const id = state.selectedDoorId
  if (!id) return

  const d = getDoorById(id)
  if (!d || d.kind !== 'interior' || d.locked) return

  const w = (state.walls || []).find(x => x.id === d.wallId)
  if (!w) return

  const dx = w.b.x - w.a.x
  const dy = w.b.y - w.a.y
  const horizontal = Math.abs(dx) >= Math.abs(dy)

  const STEP_WORLD = 25 // 25 см
  const len = Math.hypot(dx, dy) || 1
  const dt = STEP_WORLD / len

  let dir = 0
  if (horizontal) {
    if (key === 'ArrowLeft') dir = -1
    if (key === 'ArrowRight') dir = +1
  } else {
    if (key === 'ArrowUp') dir = -1
    if (key === 'ArrowDown') dir = +1
  }
  if (!dir) return

  historyCommit('move-door')
  d.t = (d.t ?? 0.5) + dir * dt
  clampDoorTToWall(d, w)
  scheduleRerender()
}

window.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
  const tag = document.activeElement?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea') return
  nudgeSelectedDoorByArrow(e.key)
})

// ---------------- hover highlight (mouse only) ----------------
draw.node.addEventListener('pointerleave', () => {
  let changed = false
  if (state.hoverWallId) { state.hoverWallId = null; changed = true }
  if (state.hoverDoorId) { state.hoverDoorId = null; changed = true }
  if (changed) scheduleRerender()
})

// ---------------- SELECT: move + resize walls ----------------
function getWallById(id) {
  return (state.walls || []).find(w => w.id === id) || null
}

function startEdit(kind, wallId, mouseWorld) {
  const w = getWallById(wallId)
  if (!w || w.kind === 'capital') return

  historyBegin(kind)

  state.ui = state.ui || {}
  state.ui.lockPan = true
  state.hoverWallId = null

  state.edit = {
    id: wallId,
    kind, // 'move' | 'a' | 'b'
    startMouse: { ...mouseWorld },

    // строительные
    startVA: { ...(w.va || w.a) },
    startVB: { ...(w.vb || w.b) },
  }
}

function stopEdit() {
  state.edit = null
  state.ui = state.ui || {}
  state.ui.lockPan = false
  historyEnd()
}

const clamp2 = (v, a, b) => Math.max(a, Math.min(b, v))

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

  // ✅ минимальная длина стены (см)
  const MIN_WALL_LEN = 50
  if (Math.hypot(newVB.x - newVA.x, newVB.y - newVA.y) < MIN_WALL_LEN) return

  if (!isSegmentAllowed(newVA, newVB, { ignoreWallId: ed.id })) return

  const old = {
    a: { ...w.a },
    b: { ...w.b },
    va: { ...(w.va || w.a) },
    vb: { ...(w.vb || w.b) },
  }

  w.va = newVA
  w.vb = newVB

  normalizeNormalWall(w, { snapPx: 22, doTrim: true })

  const clearOpts =
    (ed.kind === 'move')
      ? { endGuard: 0, samples: 32 }
      : { endGuard: 0.06, samples: 32 }

  if (!isSegmentClearOfCapitals(w.a, w.b, CLEAR_FROM_CAPITAL, clearOpts)) {
    w.a = old.a
    w.b = old.b
    w.va = old.va
    w.vb = old.vb
    return
  }

  w.va = newVA
  w.vb = newVB
}

// ---------------- POINTER: select door / wall / empty ----------------
draw.node.addEventListener('pointerdown', (e) => {
  if (state.mode === 'draw-door') {
    const p = screenToWorld(draw, e.clientX, e.clientY)

    doorPlace = { pointerId: e.pointerId }
    draw.node.setPointerCapture?.(e.pointerId)

    // обновляем preview прямо сейчас
    updateDoorPreviewAtPoint(p)

    const pd = state.previewDoor
    if (pd && pd.wallId) {
      state.doors = state.doors || []

      // ✅ только одна interior-дверь на стену
      const existsOnWall = (state.doors || []).some(d =>
        d.wallId === pd.wallId && d.kind === 'interior' && !d.locked
      )
      if (existsOnWall) {
        hint && (hint.textContent = 'На этой стене уже есть дверь. Можно только одну.')
        state.previewDoor = null
        scheduleRerender()
        return
      }

      historyCommit('add-door') // ✅ только если реально добавляем
      state.doors.push({
        id: newDoorId(),
        kind: 'interior',
        wallId: pd.wallId,
        t: pd.t,
        w: 75,
        thick: NOR_W,
      })
      setPlannerCursor('default')

      state.selectedDoorId = null
      state.selectedWallId = null

      state.previewDoor = null
      scheduleRerender()
    }
    return
  }

  if (state.mode === 'draw-wall') return
  if (e.button !== 0 && e.pointerType === 'mouse') return
  if (state.ui?.dragged) return

  const p = screenToWorld(draw, e.clientX, e.clientY)

  // 0) door hit first
  const doorId = findDoorIdFromEventTarget(e.target)
  if (doorId) {
    const d = getDoorById(doorId)
    if (d && d.kind === 'interior' && !d.locked) {
      state.selectedDoorId = doorId
      state.selectedWallId = null
      startDoorDrag(doorId)
      scheduleRerender()
      return
    }
  }

  // 1) wall handle
  const h = typeof pickWallHandleAt === 'function'
    ? pickWallHandleAt(p, { tolPx: 14 })
    : null

  if (h) {
    state.selectedWallId = h.id
    state.selectedDoorId = null
    startEdit(h.handle, h.id, p)
    scheduleRerender()
    return
  }

  // 2) wall body
  const id = pickNormalWallAt(p, { tolPx: 16 })
  if (id) {
    state.selectedWallId = id
    state.selectedDoorId = null
    startEdit('move', id, p)
    scheduleRerender()
    return
  }

  // 3) empty
  state.selectedWallId = null
  state.selectedDoorId = null
  scheduleRerender()
})

draw.node.addEventListener('pointermove', (e) => {
  const p = screenToWorld(draw, e.clientX, e.clientY)

  // 1) установка двери
  if (state.mode === 'draw-door') {
    updateDoorPreviewAtPoint(p)
    return
  }

  // 2) drag двери
  if (doorEdit) {
    applyDoorDrag(p)
    scheduleRerender()
    return
  }

  // 3) drag стены
  if (state.mode !== 'draw-wall' && state.edit) {
    applyEdit(p)
    scheduleRerender()
    return
  }

  // 4) hover (ТОЛЬКО мышь)
  if (e.pointerType !== 'mouse') return
  if (state.mode === 'draw-wall' || state.mode === 'draw-door') return
  if (state.ui?.lockPan || state.ui?.dragged || state.edit || doorEdit) return

  const doorHover = findDoorIdFromEventTarget(e.target)
  if (doorHover !== state.hoverDoorId) {
    state.hoverDoorId = doorHover
    if (doorHover) state.hoverWallId = null
    scheduleRerender()
    return
  }

  const wallHover = findWallIdFromEventTarget(e.target)
  if (wallHover !== state.hoverWallId) {
    state.hoverWallId = wallHover
    if (wallHover) state.hoverDoorId = null
    scheduleRerender()
  }
})

draw.node.addEventListener('pointerup', (e) => {
  // если ставили дверь — отпускаем capture
  if (doorPlace && doorPlace.pointerId === e.pointerId) {
    draw.node.releasePointerCapture?.(e.pointerId)
    doorPlace = null
  }

  if (state.mode === 'draw-wall') return

  if (doorEdit) {
    stopDoorDrag()
    scheduleRerender()
    return
  }

  if (!state.edit) return
  stopEdit()
  scheduleRerender()
})

draw.node.addEventListener('pointercancel', () => {
  if (doorEdit) {
    stopDoorDrag()
    scheduleRerender()
    return
  }
  if (!state.edit) return
  stopEdit()
  scheduleRerender()
})

// -------- start --------
syncUI()
loadStudioTemplate()

requestAnimationFrame(() => {
  fitPlannerToWalls()
  rerender()
})

// resize (один)
let rafResize = 0
window.addEventListener('resize', () => {
  cancelAnimationFrame(rafResize)
  rafResize = requestAnimationFrame(() => {
    fitPlannerToWalls()
    rerender()
  })
})

// удобно для дебага в консоли
window.state = state