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

// ✅ нужно для T-обрубки
import {
  segmentIntersectionParams,
  projectPointToSegment,
} from '../engine/geom.js'

// ---------------- helpers ----------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y)

// thresholds
const TAP_THRESH_PX = 10
const CANCEL_A_PX = 14
const DRAG_START_PX = 10 // порог чтобы считать drag на таче

const MIN_WALL_LEN = config.walls.MIN_LEN

const clearPulse = () => {
  if (state.ui) state.ui.snapPulse = null
}

const isCoarse = () => {
  try { return matchMedia('(pointer: coarse)').matches } catch { return false }
}

// считаем тачем всё, что не мышь, плюс любые coarse-девайсы (включая pen)
const isTouchLikePointer = (pointerType) => pointerType !== 'mouse' || isCoarse()

// ✅ для рисования clearance мягче
const DRAW_CLEAR = Math.max(0, CLEAR_FROM_CAPITAL() * 0.1)

// --------------------------------------------------
// ✅ FIX: isSegmentAllowed должен иметь tolPx >= радиуса снапа
function allowedDraw(a, b, ignoreWallId = null) {
  return isSegmentAllowed(a, b, {
    ignoreWallId,
    tolPx: config.snap.draw.snapPx,
  })
}
// --------------------------------------------------

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

    return { end: trimPointBack(other, best.q, trimLenVisual), snapped: best.q }
  }

  const aRes = snapEnd(a0, b0)
  const bRes = snapEnd(b0, a0)

  wall.a = aRes.end
  wall.b = bRes.end

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

/**
 * ✅ T-обрубка: если новый сегмент пересекает existing normal “в середине”
 * → обрубаем B в точку первого пересечения.
 */
function clampBToFirstNormalIntersection(a, b, { tolWorld, guardT = 0.08 } = {}) {
  let best = null
  let bestDist = Infinity

  for (const w of (state.walls || [])) {
    if (!w || w.kind === 'capital') continue

    const wa = w.va || w.a
    const wb = w.vb || w.b

    const hit = segmentIntersectionParams(a, b, wa, wb)
    if (!hit || hit.type !== 'point') continue

    const ip = hit.p

    // пересечение должно быть "внутри" existing сегмента (иначе это уголок)
    const pr = projectPointToSegment(ip, wa, wb)
    if (pr.t <= guardT || pr.t >= (1 - guardT)) continue

    // не обрубать прямо у A
    const dA = Math.hypot(ip.x - a.x, ip.y - a.y)
    if (dA <= tolWorld) continue

    if (dA < bestDist) {
      bestDist = dA
      best = ip
    }
  }

  return best ? { ...best } : b
}

export function initPointer(draw, { newWallId } = {}) {
  let firstPoint = null
  let down = null
  let suppressPreview = false

  // touchlike draw state
  let touchPending = null      // { sx, sy, startP }
  let touchDragging = false

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
      state.snapPoint = aSaved ? aSaved : null
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
      // пока включён toNormals, при проходе рядом со стеной курсор будет “приклеиваться” к проекции на неё 
      // (особенно на маленьком зуме, где snapWorld = snapPx/scale становится огромным).
      toNormals: false,
      tGuard: config.snap.tGuard,
    })
  }

  /**
   * ✅ Главный UX-fix:
   * - pSnap = где курсор (ходит за мышью)
   * - pFinal = куда реально встанет конец стены (после T-обрубки)
   * Раньше ты делал snapPoint=pFinal → визуально “залипало”.
   */
  function applyDrawPreview(rawB) {
    const pSnap = snapAt(rawB, firstPoint)

    const tolWorld = config.snap.draw.snapPx / Math.max(1e-6, state.view.scale)
    const pFinal = clampBToFirstNormalIntersection(firstPoint, pSnap, {
      tolWorld,
      guardT: config.snap.tGuard,
    })

    // ✅ курсор должен ходить за мышью
    state.snapPoint = { ...pSnap }

    const len = Math.hypot(pFinal.x - firstPoint.x, pFinal.y - firstPoint.y)
    const okLen = len >= MIN_WALL_LEN

    const okAllowed = allowedDraw(firstPoint, pFinal)
    const okClear = isSegmentClearOfCapitals(firstPoint, pFinal, DRAW_CLEAR)
    const ok = okLen && okAllowed && okClear

    state.cursorState = ok ? 'valid' : 'invalid'
    // ✅ а превью заканчивается там, где реально остановится стена
    state.previewWall = { a: firstPoint, b: pFinal, ok }
  }

  // --- MOVE: cursor + preview ---
  draw.node.addEventListener('pointermove', (e) => {
    if (state.mode !== 'draw-wall') return
    if (e.pointerType !== 'mouse') e.preventDefault?.()

    // TOUCH / PEN / COARSE: стартуем только после drag threshold
    if (isTouchLikePointer(e.pointerType)) {
      if (!touchPending) return

      const dx = e.clientX - touchPending.sx
      const dy = e.clientY - touchPending.sy
      const moved2 = dx * dx + dy * dy

      if (!touchDragging && moved2 < DRAG_START_PX * DRAG_START_PX) return

      if (!touchDragging) {
        touchDragging = true
        firstPoint = { ...touchPending.startP }

        state.snapPoint = { ...firstPoint }
        state.previewWall = null
        state.cursorState = 'idle'
        suppressPreview = false
        clearPulse()
      }

      const raw = screenToWorld(draw, e.clientX, e.clientY)
      applyDrawPreview(raw)
      scheduleRender()
      return
    }

    // MOUSE
    const raw = screenToWorld(draw, e.clientX, e.clientY)

    if (!firstPoint) {
      state.snapPoint = snapAt(raw, null)
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

    applyDrawPreview(raw)
    scheduleRender()
  }, { passive: false })

  // --- DOWN ---
  draw.node.addEventListener('pointerdown', (e) => {
    if (state.mode !== 'draw-wall') return
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (e.pointerType !== 'mouse') e.preventDefault?.()

    down = { x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType }
    draw.node.setPointerCapture?.(e.pointerId)

    // TOUCH / PEN / COARSE: просто запоминаем старт
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

    // MOUSE: курсор в точку клика
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

    // TOUCH / PEN / COARSE
    if (isTouchLikePointer(e.pointerType)) {
      const dragging = touchDragging && firstPoint
      const preview = state.previewWall

      touchPending = null
      touchDragging = false

      if (!dragging || !preview) {
        firstPoint = null
        state.previewWall = null
        state.snapPoint = null
        state.cursorState = 'idle'
        clearPulse()
        scheduleRender()
        return
      }

      const pFinal = { ...preview.b }

      const len = Math.hypot(pFinal.x - firstPoint.x, pFinal.y - firstPoint.y)
      if (len < MIN_WALL_LEN) {
        resetAll()
        return
      }

      const okAllowed = allowedDraw(firstPoint, pFinal)
      const okClear = isSegmentClearOfCapitals(firstPoint, pFinal, DRAW_CLEAR)
      if (!(okAllowed && okClear)) {
        resetAll()
        return
      }

      const id = (typeof newWallId === 'function') ? newWallId() : `u${Date.now()}`
      const newWall = { id, a: { ...firstPoint }, b: { ...pFinal }, kind: 'normal' }

      trimWallToCapitals(newWall)

      const okAllowed2 = allowedDraw(newWall.a, newWall.b)
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

    // MOUSE (A/B click)
    const isTap =
      wasDown
        ? distPx({ x: e.clientX, y: e.clientY }, { x: wasDown.x, y: wasDown.y }) <= TAP_THRESH_PX
        : true

    const raw = screenToWorld(draw, e.clientX, e.clientY)
    const pSnap = snapAt(raw, firstPoint)

    // 1) choose A
    if (!firstPoint) {
      firstPoint = { ...pSnap }
      state.snapPoint = { ...pSnap }
      state.cursorState = 'valid'
      state.previewWall = { a: firstPoint, b: pSnap, ok: true }
      suppressPreview = false
      scheduleRender()
      return
    }

    // 2) cancel if click near A
    if (isTap) {
      const tolWorld = CANCEL_A_PX / Math.max(1e-6, state.view.scale)
      const dWorld = Math.hypot(pSnap.x - firstPoint.x, pSnap.y - firstPoint.y)
      if (dWorld <= tolWorld) {
        cancelStart()
        return
      }
    }

    // ✅ финальная точка стены (с T-обрубкой)
    const tolWorld = config.snap.draw.snapPx / Math.max(1e-6, state.view.scale)
    const pFinal = clampBToFirstNormalIntersection(firstPoint, pSnap, {
      tolWorld,
      guardT: config.snap.tGuard,
    })

    // ✅ курсор остаётся на pSnap (не залипает)
    state.snapPoint = { ...pSnap }

    const len = Math.hypot(pFinal.x - firstPoint.x, pFinal.y - firstPoint.y)
    if (len < MIN_WALL_LEN) {
      cancelInvalidB(pSnap, e.pointerType)
      return
    }

    const okAllowed = allowedDraw(firstPoint, pFinal)
    const okClear = isSegmentClearOfCapitals(firstPoint, pFinal, DRAW_CLEAR)
    if (!(okAllowed && okClear)) {
      cancelInvalidB(pSnap, e.pointerType)
      return
    }

    const id = (typeof newWallId === 'function') ? newWallId() : `u${Date.now()}`
    const newWall = { id, a: { ...firstPoint }, b: { ...pFinal }, kind: 'normal' }

    trimWallToCapitals(newWall)

    const okAllowed2 = allowedDraw(newWall.a, newWall.b)
    const okClear2 = isSegmentClearOfCapitals(newWall.a, newWall.b, DRAW_CLEAR)
    if (!(okAllowed2 && okClear2)) {
      cancelInvalidB(pSnap, e.pointerType)
      return
    }

    historyCommit('add wall')
    state.walls.push(newWall)

    // after commit
    firstPoint = null
    state.previewWall = null
    state.snapPoint = { ...pFinal } // логично оставить последнюю “реальную” точку
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