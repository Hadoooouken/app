// engine/history.js
import { state } from './state.js'

const MAX = 80

// stack: past snapshots, future snapshots
const past = []
const future = []

let tx = null // { before, label }

function deepCloneWalls(walls) {
    // стены у тебя плоские объекты с вложенными точками — JSON норм
    return JSON.parse(JSON.stringify(walls || []))
}

function sameWalls(a, b) {
    // простая защита от пустых коммитов
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

// Коммит “снаружи” (для одиночных операций типа delete/add)
export function historyCommit(label = '') {
    const snap = deepCloneWalls(state.walls)
    const prev = past.length ? past[past.length - 1] : null

    // если последний снапшот такой же — не пушим
    if (prev && sameWalls(prev, snap)) return

    past.push(snap)
    if (past.length > MAX) past.shift()
    future.length = 0
}

// Транзакция (для drag: один undo за весь перенос)
export function historyBegin(label = '') {
    if (tx) return
    tx = {
        before: deepCloneWalls(state.walls),
        label,
    }
}

export function historyEnd() {
    if (!tx) return

    const after = deepCloneWalls(state.walls)
    if (!sameWalls(tx.before, after)) {
        past.push(tx.before)     // важно: кладём BEFORE, чтобы undo вернул назад
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
    future.push(deepCloneWalls(state.walls))
    state.walls = deepCloneWalls(prev)
    return true
}

export function redo() {
    if (!future.length) return false
    const next = future.pop()
    past.push(deepCloneWalls(state.walls))
    state.walls = deepCloneWalls(next)
    return true
}
