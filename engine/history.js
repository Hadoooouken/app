// engine/history.js
import { state } from './state.js'
import { config } from './config.js'

const MAX = config?.history?.MAX ?? 80

const past = []
const future = []

let tx = null // { before, label }

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj))
}

function snapshot() {
  return deepClone({
    walls: state.walls || [],
    doors: state.doors || [],
    windows: state.windows || [],

    // ✅ мебель + выделение мебели
    furniture: state.furniture || [],
    selectedFurnitureId: state.selectedFurnitureId ?? null,
  })
}

function applySnapshot(snap) {
  state.walls = deepClone(snap?.walls || [])
  state.doors = deepClone(snap?.doors || [])
  state.windows = deepClone(snap?.windows || [])

  // ✅ мебель
  state.furniture = deepClone(snap?.furniture || [])
  state.selectedFurnitureId = snap?.selectedFurnitureId ?? null

  // ✅ сброс transient UI
  state.hoverFurnitureId = null
  state.previewFurniture = null
  state.draftFurnitureTypeId = null
}
function sameSnap(a, b) {
    return JSON.stringify(a) === JSON.stringify(b)
}

export function historyClear() {
    past.length = 0
    future.length = 0
    tx = null
}

export function historyCanUndo() {
    return past.length > 0
}

export function historyCanRedo() {
    return future.length > 0
}

export function historyCommit(label = '') {
    const snap = snapshot()
    const prev = past.length ? past[past.length - 1] : null
    if (prev && sameSnap(prev, snap)) return

    past.push(snap)
    if (past.length > MAX) past.shift()
    future.length = 0
}

export function historyBegin(label = '') {
    if (tx) return
    tx = { before: snapshot(), label }
}

export function historyEnd() {
    if (!tx) return
    const after = snapshot()

    if (!sameSnap(tx.before, after)) {
        past.push(tx.before) // кладём BEFORE
        if (past.length > MAX) past.shift()
        future.length = 0
    }
    tx = null
}

export function historyCancel() {
    tx = null
}

export function undo() {
    if (!past.length) return false
    const prev = past.pop()
    future.push(snapshot())
    applySnapshot(prev)
    return true
}

export function redo() {
    if (!future.length) return false
    const next = future.pop()
    past.push(snapshot())
    applySnapshot(next)
    return true
}