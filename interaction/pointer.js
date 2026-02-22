// interaction/pointer.js
import { historyCommit } from '../engine/history.js'

import { state } from '../engine/state.js'
import { config, CLEAR_FROM_CAPITAL } from '../engine/config.js'

import { render } from '../renderer/render.js'
import { screenToWorld } from '../renderer/svg.js'
import {
  smartSnapPoint,
  isSegmentAllowed,
  isSegmentClearOfCapitals,
} from '../engine/constraints.js'

// ---------------- helpers ----------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y)

// thresholds
const TAP_THRESH_PX = 10
const CANCEL_A_PX = 14
const DRAG_START_PX = 10 // порог чтобы считать drag на таче

const MIN_WALL_LEN = config.walls.MIN_LEN // ✅ из конфига

const clearPulse = () => {
  if (state.ui) state.ui.snapPulse = null
}

const isCoarse = () => {
  try { return matchMedia('(pointer: coarse)').matches } catch { return false }
}

// считаем тачем всё, что не мышь, плюс любые coarse-девайсы (включая pen на iPad)
const isTouchLikePointer = (pointerType) => pointerType !== 'mouse' || isCoarse()

// ✅ ДЛЯ РИСОВАНИЯ делаем “clear” заметно меньше, чем для select
const DRAW_CLEAR = Math.max(0, CLEAR_FROM_CAPITAL() * 0.1)

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

  const CAP_W = config.walls.CAP_W
  const NOR_W = config.walls.NOR_W
  const OVERLAP = config.walls.OVERLAP

  // ✅ сохраняем исходные точки (важно для L-стыков)
  const a0 = { ...wall.a }
  const b0 = { ...wall.b }

  // строительная геометрия (для метрик)
  wall.va = { ...a0 }
  wall.vb = { ...b0 }

  const scale = Math.max(1e-6, state.view.scale)
  const tolWorld = config.snap.draw.snapPx / scale
  const trimLenVisual = CAP_W / 2 + NOR_W / 2 - OVERLAP

  const snapEnd = (end, other) => {
    let best = null

    for (const c of caps) {
      const q = nearestPointOnSeg(end, c.a, c.b)
      const d = dist(end, q)
      if (d <= tolWorld && (!best || d < best.d)) best = { q, d }
    }

    if (!best) return { end, snapped: null }

    // end = видимый тримнутый конец
    // snapped = точка касания (для va/vb)
    return { end: trimPointBack(other, best.q, trimLenVisual), snapped: best.q }
  }

  // ✅ считаем оба конца от ОДНИХ И ТЕХ ЖЕ исходных a0/b0
  const aRes = snapEnd(a0, b0)
  const bRes = snapEnd(b0, a0)

  wall.a = aRes.end
  wall.b = bRes.end

  // ✅ va/vb — в точку касания (если была), иначе остаётся исходное
  if (aRes.snapped) wall.va = { ...aRes.snapped }
  if (bRes.snapped) wall.vb = { ...bRes.snapped }

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

  // touchlike draw state
  let touchPending = null      // { sx, sy, startP }
  let touchDragging = false    // started actual wall drawing

  // render throttle
  let raf = 0
  const scheduleRender = () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      render(draw)
    })
  }

  const resetAll = () => {
    firstPoint = null
    down = null
    suppressPreview = false
    touchPending = null
    touchDragging = false

    state.previewWall = null
    state.snapPoint = null
    state.cursorState = 'idle'

    clearPulse()
    scheduleRender()
  }

  const cancelStart = () => {
    // отмена A (клик рядом с A на десктопе)
    firstPoint = null
    suppressPreview = false
    touchPending = null
    touchDragging = false

    state.previewWall = null
    state.cursorState = 'idle'
    state.snapPoint = null

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

    // на таче возвращаем курсор в A (если он был)
    if (isTouchLikePointer(pointerType)) {
      if (aSaved) state.snapPoint = aSaved
      else state.snapPoint = null
    } else {
      state.snapPoint = { ...p }
    }

    scheduleRender()
  }

  function snapAt(raw, fromPoint) {
    return smartSnapPoint(raw, fromPoint, {
      grid: config.grid.snapStep,
      snapPx: config.snap.draw.snapPx,
      axisPx: config.snap.draw.axisPx,
      toGrid: true,
      toPoints: true,
      toAxis: true,
      toCapital: true,
      toNormals: true,
      tGuard: config.snap.tGuard,
    })
  }

  // --- MOVE: cursor + preview ---
  draw.node.addEventListener('pointermove', (e) => {
    if (state.mode !== 'draw-wall') return
    if (e.pointerType !== 'mouse') e.preventDefault?.()

    // ✅ TOUCH / PEN / COARSE: start draw only after drag threshold
    if (isTouchLikePointer(e.pointerType)) {
      if (!touchPending) return

      const dx = e.clientX - touchPending.sx
      const dy = e.clientY - touchPending.sy
      const moved2 = dx * dx + dy * dy

      // пока не drag — ничего не показываем
      if (!touchDragging && moved2 < DRAG_START_PX * DRAG_START_PX) return

      // drag начался → фиксируем A
      if (!touchDragging) {
        touchDragging = true
        firstPoint = { ...touchPending.startP }

        // кружок только в A
        state.snapPoint = { ...firstPoint }
        state.previewWall = null
        state.cursorState = 'idle'
        suppressPreview = false
        clearPulse()
      }

      // B по текущей позиции
      const raw = screenToWorld(draw, e.clientX, e.clientY)
      const p = snapAt(raw, firstPoint)

      const len = Math.hypot(p.x - firstPoint.x, p.y - firstPoint.y)
      const okLen = len >= MIN_WALL_LEN

      const okAllowed = isSegmentAllowed(firstPoint, p)
      const okClear = isSegmentClearOfCapitals(firstPoint, p, DRAW_CLEAR)
      const ok = okLen && okAllowed && okClear

      state.cursorState = ok ? 'valid' : 'invalid'
      state.previewWall = { a: firstPoint, b: p, ok }

      scheduleRender()
      return
    }

    // ✅ MOUSE: обновляем курсор всегда
    const raw = screenToWorld(draw, e.clientX, e.clientY)
    const p = snapAt(raw, firstPoint)
    state.snapPoint = p

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

    const len = Math.hypot(p.x - firstPoint.x, p.y - firstPoint.y)
    const okLen = len >= MIN_WALL_LEN

    const okAllowed = isSegmentAllowed(firstPoint, p)
    const okClear = isSegmentClearOfCapitals(firstPoint, p, DRAW_CLEAR)
    const ok = okLen && okAllowed && okClear

    state.cursorState = ok ? 'valid' : 'invalid'
    state.previewWall = { a: firstPoint, b: p, ok }

    scheduleRender()
  }, { passive: false })

  // --- DOWN ---
  draw.node.addEventListener('pointerdown', (e) => {
    if (state.mode !== 'draw-wall') return
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (e.pointerType !== 'mouse') e.preventDefault?.()

    down = { x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType }
    draw.node.setPointerCapture?.(e.pointerId)

    // ✅ TOUCH / PEN / COARSE: только запоминаем старт, ничего не рисуем
    if (isTouchLikePointer(e.pointerType)) {
      const raw0 = screenToWorld(draw, e.clientX, e.clientY)
      const p0 = snapAt(raw0, null)
      touchPending = { sx: e.clientX, sy: e.clientY, startP: { ...p0 } }
      touchDragging = false

      state.snapPoint = null
      state.previewWall = null
      state.cursorState = 'idle'
      clearPulse()
      scheduleRender()
      return
    }

    // ✅ MOUSE: ставим курсор в точку клика (а не в центр)
    const raw = screenToWorld(draw, e.clientX, e.clientY)
    state.snapPoint = snapAt(raw, null)
    state.cursorState = 'idle'
    scheduleRender()
  }, { passive: false })

  // --- UP ---
  draw.node.addEventListener('pointerup', (e) => {
    if (state.mode !== 'draw-wall') return
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (e.pointerType !== 'mouse') e.preventDefault?.()

    const wasDown = down
    down = null

    // ✅ TOUCH / PEN / COARSE
    if (isTouchLikePointer(e.pointerType)) {
      const dragging = touchDragging && firstPoint
      const preview = state.previewWall

      touchPending = null
      touchDragging = false

      // tap (drag не начался) → игнор, ничего не ставим
      if (!dragging || !preview) {
        firstPoint = null
        state.previewWall = null
        state.snapPoint = null
        state.cursorState = 'idle'
        clearPulse()
        scheduleRender()
        return
      }

      const p = { ...preview.b }

      // ✅ min length
      const len = Math.hypot(p.x - firstPoint.x, p.y - firstPoint.y)
      if (len < MIN_WALL_LEN) {
        resetAll()
        return
      }

      const okAllowed = isSegmentAllowed(firstPoint, p)
      const okClear = isSegmentClearOfCapitals(firstPoint, p, DRAW_CLEAR)
      if (!(okAllowed && okClear)) {
        resetAll()
        return
      }

      const id = (typeof newWallId === 'function') ? newWallId() : `u${Date.now()}`
      const newWall = { id, a: { ...firstPoint }, b: { ...p }, kind: 'normal' }

      trimWallToCapitals(newWall)

      const okAllowed2 = isSegmentAllowed(newWall.a, newWall.b)
      const okClear2 = isSegmentClearOfCapitals(newWall.a, newWall.b, DRAW_CLEAR)
      if (!(okAllowed2 && okClear2)) {
        resetAll()
        return
      }

      historyCommit('add wall')
      state.walls.push(newWall)
      resetAll()
      return
    }

    // ✅ MOUSE (A/B click)
    const isTap =
      wasDown
        ? distPx({ x: e.clientX, y: e.clientY }, { x: wasDown.x, y: wasDown.y }) <= TAP_THRESH_PX
        : true

    const raw = screenToWorld(draw, e.clientX, e.clientY)
    const p = snapAt(raw, firstPoint)
    state.snapPoint = p

    // 1) choose A
    if (!firstPoint) {
      firstPoint = { ...p }
      state.cursorState = 'valid'
      state.previewWall = { a: firstPoint, b: p, ok: true }
      suppressPreview = false
      scheduleRender()
      return
    }

    // 2) cancel if click near A
    if (isTap) {
      const tolWorld = CANCEL_A_PX / Math.max(1e-6, state.view.scale)
      const dWorld = Math.hypot(p.x - firstPoint.x, p.y - firstPoint.y)
      if (dWorld <= tolWorld) {
        cancelStart()
        return
      }
    }

    // ✅ min length
    const len = Math.hypot(p.x - firstPoint.x, p.y - firstPoint.y)
    if (len < MIN_WALL_LEN) {
      cancelInvalidB(p, e.pointerType)
      return
    }

    const okAllowed = isSegmentAllowed(firstPoint, p)
    const okClear = isSegmentClearOfCapitals(firstPoint, p, DRAW_CLEAR)
    if (!(okAllowed && okClear)) {
      cancelInvalidB(p, e.pointerType)
      return
    }

    const id = (typeof newWallId === 'function') ? newWallId() : `u${Date.now()}`
    const newWall = { id, a: { ...firstPoint }, b: { ...p }, kind: 'normal' }

    trimWallToCapitals(newWall)

    const okAllowed2 = isSegmentAllowed(newWall.a, newWall.b)
    const okClear2 = isSegmentClearOfCapitals(newWall.a, newWall.b, DRAW_CLEAR)
    if (!(okAllowed2 && okClear2)) {
      cancelInvalidB(p, e.pointerType)
      return
    }

    historyCommit('add wall')
    state.walls.push(newWall)

    // after commit
    firstPoint = null
    state.previewWall = null
    state.snapPoint = { ...p }
    state.cursorState = 'idle'
    suppressPreview = false
    clearPulse()
    scheduleRender()
  }, { passive: false })

  draw.node.addEventListener('pointercancel', () => resetAll(), { passive: true })

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    resetAll()
  })
}