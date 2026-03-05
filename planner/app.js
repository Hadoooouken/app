// planner/app.js
import { state } from '../engine/state.js'
import { config, CLEAR_FROM_CAPITAL } from '../engine/config.js'
import { historyCommit, historyBegin, historyEnd, undo, redo } from '../engine/history.js'

import { createSVG, setZoomAtCenter, screenToWorld } from '../renderer/svg.js'
import { render, fitToWalls } from '../renderer/render.js'
import { loadStudioTemplate, studioWindows } from './templates.js'
import { initViewport } from '../interaction/viewport.js'
import { initPointer } from '../interaction/pointer.js'
import { pickNormalWallAt, pickWallHandleAt } from '../engine/pick.js'
import { smartSnapPoint, isSegmentAllowed, isSegmentClearOfCapitals } from '../engine/constraints.js'
import { normalizeNormalWall } from '../engine/normalize-wall.js'
import { FURN_CATEGORIES, FURN_BY_TYPE, loadFurnitureSpriteIntoDefs } from './furniture-catalog.js'
import { ensureCapitalInnerFaces } from '../engine/capitals-inner.js'

// ✅ метрики
import {
  getSelectedWall,
  wallLengthM,
  totalNormalLengthM,
  capitalAreaM2,
  fmtM,
  fmtM2,
  getCapitalPolygon as getOuterCapPolygon
} from '../engine/metrics.js'



const GRID_STEP_SNAP = config.grid.snapStep
const NOR_W = config.walls.NOR_W
const CLEAR_CAP = CLEAR_FROM_CAPITAL() // ✅ важно: это число

// --- config aliases (чтобы не было магических чисел) ---
const PICK_WALL_PX = config.snap?.pick?.wallPx ?? 16
const PICK_HANDLE_PX = config.snap?.pick?.handlePx ?? 14
const PICK_DOOR_PX = config.snap?.pick?.doorPx ?? 18

const DOOR_W_INTERIOR = config.doors?.defaultInteriorW ?? 75
const DOOR_W_ENTRY = config.doors?.defaultEntryW ?? 90

const DOOR_NUDGE_WORLD = config.doors?.nudgeStepWorld ?? config.grid.snapStep



const workspace = document.getElementById('workspace')
const draw = createSVG(workspace)

// ---------------- FURNITURE: init state ----------------
state.furniture = state.furniture || []
state.selectedFurnitureId = state.selectedFurnitureId ?? null
state.hoverFurnitureId = state.hoverFurnitureId ?? null
state.previewFurniture = state.previewFurniture ?? null
state.draftFurnitureTypeId = state.draftFurnitureTypeId ?? null

function unitNormal(a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return { nx: -dy / len, ny: dx / len }
}

function getCapitalsCentroid(caps) {
  if (!caps.length) return { x: 0, y: 0 }
  let sx = 0, sy = 0, n = 0
  for (const w of caps) { sx += w.a.x; sy += w.a.y; n++ }
  return { x: sx / n, y: sy / n }
}

// наружная нормаль относительно центра
function outwardNormal(a, b, centroid) {
  const { nx, ny } = unitNormal(a, b)
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const eps = 1
  const p1 = { x: mid.x + nx * eps, y: mid.y + ny * eps }
  const p2 = { x: mid.x - nx * eps, y: mid.y - ny * eps }
  const d1 = Math.hypot(p1.x - centroid.x, p1.y - centroid.y)
  const d2 = Math.hypot(p2.x - centroid.x, p2.y - centroid.y)
  return d1 < d2 ? { nx: -nx, ny: -ny } : { nx, ny }
}

function rotatePoint(px, py, angRad) {
  const c = Math.cos(angRad), s = Math.sin(angRad)
  return { x: px * c - py * s, y: px * s + py * c }
}

function furnitureCorners({ x, y, w, h, rot }) {
  const hw = w / 2, hh = h / 2
  const ang = ((rot || 0) * Math.PI) / 180
  const pts = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ]
  return pts.map(p => {
    const r = rotatePoint(p.x, p.y, ang)
    return { x: x + r.x, y: y + r.y }
  })
}

function getViewportCenterWorld() {
  const r = draw.node.getBoundingClientRect()
  return screenToWorld(draw, r.left + r.width / 2, r.top + r.height / 2)
}

function spawnFurniturePreviewAtPoint(worldPoint) {
  const typeId = state.draftFurnitureTypeId
  const meta = typeId ? FURN_BY_TYPE.get(typeId) : null
  if (!meta) return

  const sp = snapFurniturePoint(worldPoint, { toGrid: false }) // свободно

  const next = {
    typeId,
    symbolId: meta.symbolId,
    w: meta.w,
    h: meta.h,
    x: sp.x,
    y: sp.y,
    rot: 0,
  }
  next.ok = furnitureAllowed(next)

  state.previewFurniture = next
  scheduleRerender()
}


function setPlannerCursor(cursor) {
  draw.node.style.cursor = cursor
}

// coarse = мобилки/планшеты (для допусков/UX), НЕ ДЛЯ отключения hover
const isTouchLike = matchMedia('(pointer: coarse)').matches
// толерансы под мобилку (coarse pointer) — увеличиваем "попадание"
const WALL_TOL_PX = isTouchLike ? Math.round(PICK_WALL_PX * 2.5) : PICK_WALL_PX
const HANDLE_TOL_PX = isTouchLike ? Math.round(PICK_HANDLE_PX * 2.5) : PICK_HANDLE_PX

// -------- id generator for user walls --------
let wallAutoId = 10000
const newWallId = () => `u${Date.now()}_${wallAutoId++}`

// -------- id generator for doors --------
const newDoorId = () => `d${Date.now()}_${Math.random().toString(16).slice(2)}`

let furnAutoId = 1
const newFurnitureId = () => `f${Date.now()}_${furnAutoId++}`

let furnitureEdit = null
let furniturePlace = null // { pointerId }
// { id, kind:'move'|'rotate', startMouse, startX, startY, startRot, startAngle }
let lastPointerWorld = null

function snapAngleDeg(deg, {
  step = 45,     // шаг якорей: 45 => 0,45,90...
  eps = 4,       // допуск в градусах: 4 => 86..94 прилипнет к 90
  only = null,   // массив якорей, если хочешь только [0,135,...]
} = {}) {
  const norm = ((deg % 360) + 360) % 360

  // режим "только к конкретным"
  if (Array.isArray(only) && only.length) {
    let best = null
    let bestD = Infinity
    for (const a of only) {
      const aa = ((a % 360) + 360) % 360
      // расстояние по окружности
      const d = Math.min(Math.abs(norm - aa), 360 - Math.abs(norm - aa))
      if (d < bestD) { bestD = d; best = aa }
    }
    return bestD <= eps ? best : norm
  }

  // режим "кратно step"
  const nearest = Math.round(norm / step) * step
  const snapped = ((nearest % 360) + 360) % 360
  const d = Math.min(Math.abs(norm - snapped), 360 - Math.abs(norm - snapped))
  return d <= eps ? snapped : norm
}

function snapFurniturePoint(raw, { toGrid = true } = {}) {
  return smartSnapPoint(raw, null, {
    grid: config.grid.snapStep,
    snapPx: config.snap.draw.snapPx,
    axisPx: config.snap.draw.axisPx,
    toGrid,              // ✅ управляем
    toPoints: false,
    toAxis: false,
    toCapital: false,
    toNormals: false,
  })
}

function updateFurniturePreviewAtPoint(p) {
  if (state.mode !== 'draw-furniture') return

  const typeId = state.draftFurnitureTypeId
  if (!typeId) {
    if (state.previewFurniture) {
      state.previewFurniture = null
      scheduleRerender()
    }
    return
  }

  const meta = FURN_BY_TYPE.get(typeId)
  if (!meta) return

  const sp = snapFurniturePoint(p, { toGrid: false }) // ✅ ВОТ ТУТ

  const next = {
    typeId,
    symbolId: meta.symbolId,
    w: meta.w,
    h: meta.h,
    x: sp.x,
    y: sp.y,
    rot: 0,
  }

  next.ok = furnitureAllowed(next)
  setPlannerCursor(next.ok ? 'pointer' : 'not-allowed')

  const prev = state.previewFurniture
  const changed =
    !prev ||
    prev.typeId !== next.typeId ||
    Math.abs(prev.x - next.x) > 1e-6 ||
    Math.abs(prev.y - next.y) > 1e-6 ||
    (prev.ok ?? true) !== next.ok

  if (changed) {
    state.previewFurniture = next
    scheduleRerender()
  }
}
const btnWall = document.getElementById('btn-wall')
const btnTrash = document.getElementById('btn-trash')
const btnDoor = document.getElementById('btn-door')
const hint = document.getElementById('hint')
const status = document.getElementById('status')
// -------- UI refs --------
const btnFurniture = document.getElementById('btn-furniture')
const furnMenu = document.getElementById('furniture-menu')

let furnitureSpriteReady = false

function hideFurnitureMenu() {
  furnMenu?.classList.add('is-hidden')
}
function toggleFurnitureMenu() {
  furnMenu?.classList.toggle('is-hidden')
}

loadFurnitureSpriteIntoDefs(draw).then(() => {
  furnitureSpriteReady = true
  scheduleRerender()
})

// стартово меню скрыто
hideFurnitureMenu()

function buildFurnitureMenu() {
  if (!furnMenu) return
  furnMenu.innerHTML = ''

  for (const cat of FURN_CATEGORIES) {
    const h = document.createElement('div')
    h.className = 'fmenu__cat'
    h.textContent = cat.label
    furnMenu.appendChild(h)

    for (const it of cat.items) {
      const row = document.createElement('div')
      row.className = 'fmenu__item'
      row.innerHTML = `<span>${it.label}</span><span>${(it.w / 100).toFixed(2)}×${(it.h / 100).toFixed(2)}м</span>`

      row.addEventListener('click', () => {
        state.draftFurnitureTypeId = it.typeId
        setMode('draw-furniture')
        hideFurnitureMenu()
        const p0 = lastPointerWorld || getViewportCenterWorld()
        spawnFurniturePreviewAtPoint(p0) // ✅ сразу под курсором (или центр если курсора нет)
      })

      furnMenu.appendChild(row)
    }
  }
}
buildFurnitureMenu()

btnFurniture?.addEventListener('click', (e) => {
  e.preventDefault()

  // если мы уже в режиме постановки мебели — кнопка выключает режим
  if (state.mode === 'draw-furniture') {
    state.draftFurnitureTypeId = null
    setMode('idle')
    hideFurnitureMenu()
    return
  }

  // если мы сейчас рисуем стену/дверь — сначала выходим в idle
  if (state.mode === 'draw-wall' || state.mode === 'draw-door') {
    setMode('idle')
  }

  // если спрайт ещё не подгрузился — просто сообщим
  if (!furnitureSpriteReady) {
    if (hint) hint.textContent = 'Загружаю мебель…'
    return
  }

  toggleFurnitureMenu()
})

// клик вне меню — закрыть
document.addEventListener('pointerdown', (e) => {
  if (!furnMenu || furnMenu.classList.contains('is-hidden')) return
  const t = e.target
  if (t === btnFurniture || btnFurniture?.contains(t)) return
  if (furnMenu.contains(t)) return
  hideFurnitureMenu()
}, { passive: true })

function panBy(dx, dy) {
  state.view.offsetX += dx
  state.view.offsetY += dy
  rerender()
}

function clampTToSegment(t, segLen, wWorld) {
  const half = wWorld / 2
  const marginT = Math.min(0.49, half / Math.max(1e-6, segLen))
  return Math.max(marginT, Math.min(1 - marginT, t))
}

function initWindowsFromTemplate() {
  const walls = state.walls || []
  const byId = new Map(walls.filter(w => w?.id).map(w => [w.id, w]))

  state.windows = []

  for (const wdef of (studioWindows || [])) {
    const wall = byId.get(wdef.wallId)
    if (!wall) continue
    if (wall.kind !== 'capital') continue

    const wWorld =
      (typeof wdef.w === 'number')
        ? wdef.w
        : (wdef.kind === 'balcony'
          ? (config.windows.balconyW ?? 180)
          : (config.windows.defaultW ?? 100))

    const dx = wall.b.x - wall.a.x
    const dy = wall.b.y - wall.a.y
    const len = Math.hypot(dx, dy) || 1

    const t = clampTToSegment(wdef.t ?? 0.5, len, wWorld)

    state.windows.push({
      id: `win_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      kind: wdef.kind || 'std',
      wallId: wdef.wallId,
      t,
      w: wWorld,
    })
  }
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

// ---------------- FURNITURE: bounds & collision ----------------


function getInnerCapsPolygon() {
  ensureCapitalInnerFaces()

  const caps = (state.walls || []).filter(w => w.kind === 'capital')
  if (!caps.length) return null

  // bbox по капитальным (для fallback и для проверки "внешности")
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const w of caps) {
    const a = w.ia || w.a
    const b = w.ib || w.b
    minX = Math.min(minX, a.x, b.x)
    minY = Math.min(minY, a.y, b.y)
    maxX = Math.max(maxX, a.x, b.x)
    maxY = Math.max(maxY, a.y, b.y)
  }

  // ✅ пробуем внешний контур
  const poly = getOuterCapPolygon()
  if (poly && poly.length >= 3) {
    // проверка: внешний контур обязан содержать "экстремальные" точки bbox
    const tol = 1e-6
    const hasMinX = poly.some(p => Math.abs(p.x - minX) <= tol)
    const hasMaxX = poly.some(p => Math.abs(p.x - maxX) <= tol)
    const hasMinY = poly.some(p => Math.abs(p.y - minY) <= tol)
    const hasMaxY = poly.some(p => Math.abs(p.y - maxY) <= tol)

    if (hasMinX && hasMaxX && hasMinY && hasMaxY) return poly
    // иначе это “не внешний” цикл (ушли по внутренней ветке) → fallback bbox
  }

  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
}
function pointInPoly(pt, poly) {
  // ray casting
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    const xi = a.x, yi = a.y
    const xj = b.x, yj = b.y

    const intersect =
      ((yi > pt.y) !== (yj > pt.y)) &&
      (pt.x < ((xj - xi) * (pt.y - yi)) / ((yj - yi) || 1e-9) + xi)

    if (intersect) inside = !inside
  }
  return inside
}

function rectCorners(x, y, w, h, rotDeg = 0) {
  const hw = w / 2, hh = h / 2
  const rad = (rotDeg * Math.PI) / 180
  const c = Math.cos(rad), s = Math.sin(rad)

  const pts = [
    { x: -hw, y: -hh },
    { x: +hw, y: -hh },
    { x: +hw, y: +hh },
    { x: -hw, y: +hh },
  ]

  return pts.map(p => ({
    x: x + p.x * c - p.y * s,
    y: y + p.x * s + p.y * c,
  }))
}

function pointInRotRect(p, pose) {
  const ang = -((pose.rot || 0) * Math.PI) / 180
  const c = Math.cos(ang), s = Math.sin(ang)
  const dx = p.x - pose.x
  const dy = p.y - pose.y
  const lx = dx * c - dy * s
  const ly = dx * s + dy * c
  return Math.abs(lx) <= pose.w / 2 && Math.abs(ly) <= pose.h / 2
}

function segmentInsideRotRect(a, b, pose) {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  return (
    pointInRotRect(a, pose) ||
    pointInRotRect(b, pose) ||
    pointInRotRect(mid, pose)
  )
}

function segIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const onSeg = (p, q, r) =>
    Math.min(p.x, r.x) <= q.x && q.x <= Math.max(p.x, r.x) &&
    Math.min(p.y, r.y) <= q.y && q.y <= Math.max(p.y, r.y)

  const o1 = cross(a, b, c)
  const o2 = cross(a, b, d)
  const o3 = cross(c, d, a)
  const o4 = cross(c, d, b)

  if ((o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)) return true
  if (Math.abs(o1) < 1e-9 && onSeg(a, c, b)) return true
  if (Math.abs(o2) < 1e-9 && onSeg(a, d, b)) return true
  if (Math.abs(o3) < 1e-9 && onSeg(c, a, d)) return true
  if (Math.abs(o4) < 1e-9 && onSeg(c, b, d)) return true
  return false
}

function distPointToSeg(p, a, b) {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const apx = p.x - a.x
  const apy = p.y - a.y
  const ab2 = abx * abx + aby * aby
  const t = ab2 < 1e-9 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2))
  const x = a.x + abx * t
  const y = a.y + aby * t
  return Math.hypot(p.x - x, p.y - y)
}

function segMinDistance(a, b, c, d) {
  if (segIntersect(a, b, c, d)) return 0
  return Math.min(
    distPointToSeg(a, c, d),
    distPointToSeg(b, c, d),
    distPointToSeg(c, a, b),
    distPointToSeg(d, a, b),
  )
}

// function furnitureAllowed(pose) {
//   const poly = getInnerCapsPolygon()
//   if (!poly) return true

//   const corners = rectCorners(pose.x, pose.y, pose.w, pose.h, pose.rot || 0)
//   for (const p of corners) if (!pointInPoly(p, poly)) return false

//   // ✅ берём правила мебели в одном месте (и совместимо со старым theme.furniture)
//   const furnCfg = config.furniture || config.theme?.furniture || {}
//   const clearCap = furnCfg.clearToCapWorld ?? 0
//   const clearNor = furnCfg.clearToNorWorld ?? 0
//   const sinkCap = furnCfg.sinkIntoCapWorld ?? 0
//   const sinkNor = furnCfg.sinkIntoNorWorld ?? 0

//   const walls = state.walls || []
//   const rectEdges = [
//     [corners[0], corners[1]],
//     [corners[1], corners[2]],
//     [corners[2], corners[3]],
//     [corners[3], corners[0]],
//   ]

//   const NOR_R = config.walls.NOR_W / 2

//   for (const w of walls) {
//     const a = (w.kind === 'capital') ? (w.ia || w.a) : (w.va || w.a)
//     const b = (w.kind === 'capital') ? (w.ib || w.b) : (w.vb || w.b)
//     if (!a || !b) continue

//     // ✅ capital: ia/ib — это внутренняя грань, поэтому CAP_R тут НЕ нужен
//     const wallR =
//       (w.kind === 'capital')
//         ? Math.max(0, clearCap - sinkCap)
//         : Math.max(0, NOR_R + clearNor - sinkNor)

//     // ✅ запрет “проталкивания” всегда, даже если wallR = 0
//     // стенка внутри прямоугольника мебели
//     if (pointInRotRect(a, pose) || pointInRotRect(b, pose) || segmentInsideRotRect(a, b, pose)) return false
//     // пересечение стенки с ребром мебели
//     for (const [p1, p2] of rectEdges) {
//       if (segIntersect(p1, p2, a, b)) return false
//     }

//     // ✅ зазор только если он реально задан
//     if (wallR > 0) {
//       for (const [p1, p2] of rectEdges) {
//         if (segMinDistance(p1, p2, a, b) < wallR) return false
//       }
//     }
//   }

//   return true
// }

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

function furnitureAllowed(pose) {
  const poly = getInnerCapsPolygon()
  if (!poly) return true

  // углы мебели
  const corners = rectCorners(
    pose.x,
    pose.y,
    pose.w,
    pose.h,
    pose.rot || 0
  )

  // ❗ единственное ограничение:
  // все углы должны быть внутри полигона капитальных стен
  for (const p of corners) {
    if (!pointInPoly(p, poly)) return false
  }

  return true
}

function findFurnitureIdFromEventTarget(target) {
  let el = target
  while (el && el !== draw.node) {
    if (el.getAttribute) {
      const id = el.getAttribute('data-furniture-id')
      if (id) return id
    }
    el = el.parentNode
  }
  return null
}

function findFurnitureRotateIdFromEventTarget(target) {
  let el = target
  while (el && el !== draw.node) {
    if (el.getAttribute) {
      const id = el.getAttribute('data-furniture-rotate')
      if (id) return id
    }
    el = el.parentNode
  }
  return null
}

function getFurnitureById(id) {
  return (state.furniture || []).find(f => f.id === id) || null
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
  if (state.mode === 'draw-wall' || state.mode === 'draw-door' || state.mode === 'draw-furniture') {
    btnTrash.classList.add('is-disabled')
    btnTrash.classList.remove('is-danger')
    return
  }

  // 0.5) Если выбрана мебель — можно удалить
  if (state.selectedFurnitureId) {
    const ok = (state.furniture || []).some(f => f.id === state.selectedFurnitureId)
    btnTrash.classList.toggle('is-disabled', !ok)
    btnTrash.classList.toggle('is-danger', ok)
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
  const ok = state.mode !== 'draw-wall' && state.mode !== 'draw-furniture'
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
  const prev = state.mode

  // ui всегда должен существовать
  state.ui ??= {}

  // ✅ КРИТИЧНО: если dragged остался true после панорамирования —
  // pointerdown в idle будет игнориться (у тебя стоит guard).
  state.ui.dragged = false

  // ✅ при смене режима — сбрасываем выделения/ховер, чтобы не "залипало"
  if (mode !== prev) {
    state.selectedWallId = null
    state.selectedDoorId = null
    state.selectedFurnitureId = null

    state.hoverWallId = null
    state.hoverDoorId = null
    state.hoverFurnitureId = null
  }

  // ✅ если выходим из режима постановки мебели — отменяем touch placement
  if (prev === 'draw-furniture' && mode !== 'draw-furniture') {
    furniturePlace = null
  }

  // ✅ общий сброс интеракций/превью
  state.mode = mode
  state.previewWall = null
  state.previewDoor = null
  state.previewFurniture = null
  state.draft = null
  state.edit = null
  state.snapPoint = null
  state.cursorState = 'idle'

  // ✅ по умолчанию панорамирование разрешено (lockPan = false)
  state.ui.lockPan = false

  // ✅ режимы рисования: чистим несовместимые штуки
  if (mode === 'draw-wall') {
    // стены рисуем — двери/мебель не выделяем
    state.selectedDoorId = null
    state.selectedFurnitureId = null
  }

  if (mode === 'draw-door') {
    state.selectedWallId = null
    state.selectedFurnitureId = null
  }

  if (mode === 'draw-furniture') {
    state.selectedWallId = null
    state.selectedDoorId = null
    // draftFurnitureTypeId НЕ трогаем — он задаётся меню
  } else {
    // ✅ выходим из мебели — убираем меню и сбрасываем выбор типа
    hideFurnitureMenu()
    state.draftFurnitureTypeId = null
  }

  setPlannerCursor('default')
  syncUI()
  rerender()
}
function syncUI() {
  const isWall = state.mode === 'draw-wall'
  const isDoor = state.mode === 'draw-door'
  const isFurn = state.mode === 'draw-furniture'

  btnWall?.classList.toggle('is-active', isWall)
  btnDoor?.classList.toggle('is-active', isDoor)
  btnFurniture?.classList.toggle('is-active', isFurn)

  if (!hint) return

  if (isWall) {
    hint.textContent = 'Wall: на мобиле — только drag. На десктопе — клик A, клик B. ESC — отмена.'
    return
  }

  if (isDoor) {
    hint.textContent = 'Door: наведи на normal стену → клик чтобы поставить. ESC — отмена.'
    return
  }

  if (isFurn) {
    hint.textContent = 'Furniture: клик — поставить. ESC — отмена. (перетаскивание/поворот добавим следующим шагом)'
    return
  }

  hint.textContent = 'Клик по стене — выделить. Drag по стене/хэндлам — редактировать. Drag по пустому — панорамирование.'
}

btnWall?.addEventListener('click', () =>
  setMode(state.mode === 'draw-wall' ? 'idle' : 'draw-wall')
)

btnDoor?.addEventListener('click', (e) => {
  e.preventDefault()

  if (state.mode === 'draw-door') {
    setMode('idle')
    return
  }

  setMode('draw-door')

  const p0 = lastPointerWorld || getViewportCenterWorld()

  // ✅ превью как у мебели — всегда есть, даже без стены
  state.previewDoor = {
    x: p0.x,
    y: p0.y,
    kind: 'interior',
    w: DOOR_W_INTERIOR,
    thick: NOR_W,
    ok: false,
    wallId: null,
    t: null,
    side: +1,
  }

  scheduleRerender()
})
// ---------------- delete selected wall/door ----------------
function deleteSelectedElement() {
  // 0) Не удаляем во время рисования
  if (state.mode === 'draw-wall' || state.mode === 'draw-door' || state.mode === 'draw-furniture') return
  // 0.5) Если выбрана мебель — удаляем её
  if (state.selectedFurnitureId) {
    const id = state.selectedFurnitureId
    const idx = (state.furniture || []).findIndex(f => f.id === id)
    if (idx === -1) return

    historyCommit('delete-furniture')
    state.furniture.splice(idx, 1)
    state.selectedFurnitureId = null
    scheduleRerender()
    return
  }

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

function startFurnitureMove(id, mouseWorld) {
  const f = getFurnitureById(id)
  if (!f) return

  historyBegin('move-furniture')
  state.ui = state.ui || {}
  state.ui.lockPan = true

  furnitureEdit = {
    id,
    kind: 'move',
    startMouse: { ...mouseWorld },
    startX: f.x,
    startY: f.y,
  }
}

function startFurnitureRotate(id, mouseWorld) {
  const f = getFurnitureById(id)
  if (!f) return

  historyBegin('rotate-furniture')
  state.ui ||= {}
  state.ui.lockPan = true

  const ang = Math.atan2(mouseWorld.y - f.y, mouseWorld.x - f.x)

  furnitureEdit = {
    id,
    kind: 'rotate',
    lastAngle: ang,        // ✅ угол прошлого кадра
    rotRaw: f.rot || 0,    // ✅ “сырое” вращение, которое копим
  }
}


function wrapRadPi(x) {
  while (x > Math.PI) x -= 2 * Math.PI
  while (x < -Math.PI) x += 2 * Math.PI
  return x
}

function applyFurnitureEdit(mouseWorld) {
  if (!furnitureEdit) return
  const f = getFurnitureById(furnitureEdit.id)
  if (!f) return

  if (furnitureEdit.kind === 'move') {
    const dx = mouseWorld.x - furnitureEdit.startMouse.x
    const dy = mouseWorld.y - furnitureEdit.startMouse.y

    const cand = {
      ...f,
      x: furnitureEdit.startX + dx,
      y: furnitureEdit.startY + dy,
    }

    if (furnitureAllowed(cand)) {
      f.x = cand.x
      f.y = cand.y
    }
    return
  }

  // --- ROTATE ---
  if (furnitureEdit.kind === 'rotate') {
    const dx = mouseWorld.x - f.x
    const dy = mouseWorld.y - f.y

    const r = Math.hypot(dx, dy)
    const MIN_R = 40
    if (r < MIN_R) return

    const a = Math.atan2(dy, dx)

    let dA = a - furnitureEdit.lastAngle
    dA = wrapRadPi(dA)
    furnitureEdit.lastAngle = a

    furnitureEdit.rotRaw += (dA * 180) / Math.PI

    const norm = ((furnitureEdit.rotRaw % 360) + 360) % 360
    //сила магнита при прокрутке мебели
    const snapped = snapAngleDeg(norm, { step: 45, eps: 6 })

    const cand = { ...f, rot: snapped }
    if (furnitureAllowed(cand)) f.rot = snapped
    return
  }
}

function stopFurnitureEdit() {
  if (!furnitureEdit) return

  // если хочешь вообще без снапа — этот блок можно убрать целиком
  const f = getFurnitureById(furnitureEdit.id)
  if (f) {
    const sp = snapFurniturePoint({ x: f.x, y: f.y }, { toGrid: false })
    const cand = { ...f, x: sp.x, y: sp.y }
    if (furnitureAllowed(cand)) {
      f.x = sp.x
      f.y = sp.y
    }
  }

  furnitureEdit = null
  state.ui ??= {}
  state.ui.lockPan = false
  historyEnd()
}

btnTrash?.addEventListener('click', deleteSelectedElement)

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return
  const tag = document.activeElement?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea') return
  deleteSelectedElement()
})

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return

  if (state.mode === 'draw-furniture') {
    state.draftFurnitureTypeId = null
    setMode('idle')
    hideFurnitureMenu()
    return
  }

  // просто закрыть меню, если оно открыто
  if (furnMenu && !furnMenu.classList.contains('is-hidden')) {
    hideFurnitureMenu()
  }
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

  // ✅ сброс выделений/ховера/превью (после undo могли стать “битые” id)
  state.selectedWallId = null
  state.selectedDoorId = null
  state.hoverWallId = null
  state.hoverDoorId = null
  state.previewDoor = null
  state.previewWall = null
  state.selectedFurnitureId = null
  state.hoverFurnitureId = null
  state.previewFurniture = null
  state.draftFurnitureTypeId = null

  if (undo()) rerender()
}

function applyRedo() {
  resetInteractionState()

  // ✅ то же самое для redo
  state.selectedWallId = null
  state.selectedDoorId = null
  state.hoverWallId = null
  state.hoverDoorId = null
  state.previewDoor = null
  state.previewWall = null
  state.selectedFurnitureId = null
  state.hoverFurnitureId = null
  state.previewFurniture = null
  state.draftFurnitureTypeId = null

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

function doorSideFromClick(p, a, b) {
  // cross(AB, AP) = dx*(py) - dy*(px)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const px = p.x - a.x
  const py = p.y - a.y
  const cr = dx * py - dy * px

  // +1 = "слева" от направления A->B (в сторону unitNormal(a,b))
  // -1 = "справа"
  return (cr >= 0) ? +1 : -1
}

function clampDoorTToWallParams(t, doorW, wall) {
  const a = wall.a, b = wall.b
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const half = doorW / 2
  const marginT = Math.min(0.49, half / len)
  return Math.max(marginT, Math.min(1 - marginT, t))
}

function updateDoorPreviewAtPoint(p) {
  if (state.mode !== 'draw-door') return

  // ✅ база превью всегда существует
  const pd = state.previewDoor || {
    x: p.x,
    y: p.y,
    kind: 'interior',
    w: DOOR_W_INTERIOR,
    thick: NOR_W,
    ok: false,
    wallId: null,
    t: null,
    side: +1,
  }

  // всегда следуем за курсором
  pd.x = p.x
  pd.y = p.y
  pd.kind = 'interior'
  pd.w = DOOR_W_INTERIOR
  pd.thick = NOR_W

  // по умолчанию — “нельзя”
  pd.ok = false
  pd.wallId = null
  pd.t = null
  pd.side = +1

  // пытаемся найти normal-стену рядом с курсором
  const wallId = pickNormalWallAt(p, { tolPx: PICK_DOOR_PX })
  if (!wallId) {
    state.previewDoor = pd
    setPlannerCursor('not-allowed')
    scheduleRerender()
    return
  }

  const w = (state.walls || []).find(x => x.id === wallId)
  if (!w || w.kind !== 'normal') {
    state.previewDoor = pd
    setPlannerCursor('not-allowed')
    scheduleRerender()
    return
  }

  // ось для t — строительная (как ты и делал)
  const A = w.va || w.a
  const B = w.vb || w.b

  let t = projectPointToWallT(p, A, B)
  t = clampDoorTToWallParams(t, pd.w, { a: A, b: B })

  // проверка на “подрезанные” концы (как в render.js)
  const dx = B.x - A.x
  const dy = B.y - A.y
  const len = Math.hypot(dx, dy) || 1
  const half = (pd.w || DOOR_W_INTERIOR) / 2
  const trimA = Math.hypot((w.a.x - A.x), (w.a.y - A.y))
  const trimB = Math.hypot((w.b.x - B.x), (w.b.y - B.y))
  const s = t * len
  const sMin = trimA + half
  const sMax = len - trimB - half

  // side (если нужно)
  const side = doorSideFromClick(p, A, B)

  // ✅ фиксируем привязку
  pd.wallId = wallId
  pd.t = t
  pd.side = side
  pd.ok = (s >= sMin && s <= sMax)

  // опционально: чтобы визуально “прилипало” к стене (а не в воздухе возле стены)
  const ux = dx / len
  const uy = dy / len
  pd.x = A.x + ux * s
  pd.y = A.y + uy * s

  state.previewDoor = pd
  setPlannerCursor(pd.ok ? 'pointer' : 'not-allowed')
  scheduleRerender()
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

  const A = w.va || w.a
  const B = w.vb || w.b

  d.t = projectPointToWallT(mouseWorld, A, B)
  d.t = clampDoorTToWallParams(d.t, (d.w ?? DOOR_W_INTERIOR), { a: A, b: B })
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

  const STEP_WORLD = DOOR_NUDGE_WORLD
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
  if (state.hoverFurnitureId) { state.hoverFurnitureId = null; changed = true }
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

// ✅ FIX: для EDIT/MOVE пересечения надо проверять тем же допуском,
// что и snap в edit-режиме, иначе возникает "невидимый зазор".
function allowedEdit(a, b, ignoreWallId) {
  return isSegmentAllowed(a, b, {
    ignoreWallId,
    tolPx: config.snap.edit.snapPx, // ✅ вместо дефолтных 2px
  })
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
    snapPx: config.snap.edit.snapPx,
    axisPx: config.snap.edit.axisPx,
    toGrid: true,
    toPoints: true,
    toAxis: true,
    toCapital: true,
    toNormals: true,
    tGuard: config.snap.tGuard,
  }

  // ✅ helper: snapped? (если точка реально сместилась)
  const isSnapped = (p0, p1) => Math.hypot(p1.x - p0.x, p1.y - p0.y) > 1e-6

  if (ed.kind === 'move') {
    // 1) базовая трансляция (без снапа)
    const a0 = { x: ed.startVA.x + dx, y: ed.startVA.y + dy }
    const b0 = { x: ed.startVB.x + dx, y: ed.startVB.y + dy }

    // 2) пробуем снапнуть A и снапнуть B (каждый даёт delta, применяем ко всей стене)
    const aSnap = smartSnapPoint(a0, null, { ...snapOpts, toAxis: false })
    const bSnap = smartSnapPoint(b0, null, { ...snapOpts, toAxis: false })

    const cand = []

    if (isSnapped(a0, aSnap)) {
      const dax = aSnap.x - a0.x
      const day = aSnap.y - a0.y
      cand.push({
        a: { x: a0.x + dax, y: a0.y + day },
        b: { x: b0.x + dax, y: b0.y + day },
        d2: dax * dax + day * day,
      })
    }

    if (isSnapped(b0, bSnap)) {
      const dbx = bSnap.x - b0.x
      const dby = bSnap.y - b0.y
      cand.push({
        a: { x: a0.x + dbx, y: a0.y + dby },
        b: { x: b0.x + dbx, y: b0.y + dby },
        d2: dbx * dbx + dby * dby,
      })
    }

    // 3) если ничего не снапнулось — просто переносим
    if (!cand.length) {
      newVA = a0
      newVB = b0
    } else {
      // берём минимальный сдвиг (обычно это тот конец, к которому реально “липли”)
      cand.sort((x, y) => x.d2 - y.d2)
      newVA = cand[0].a
      newVB = cand[0].b
    }
  }

  if (ed.kind === 'a') {
    newVA = { x: ed.startVA.x + dx, y: ed.startVA.y + dy }
    newVA = smartSnapPoint(newVA, newVB, snapOpts)
  }

  if (ed.kind === 'b') {
    newVB = { x: ed.startVB.x + dx, y: ed.startVB.y + dy }
    newVB = smartSnapPoint(newVB, newVA, snapOpts)
  }

  // ✅ минимальная длина
  const MIN_WALL_LEN = config.walls.MIN_LEN
  if (Math.hypot(newVB.x - newVA.x, newVB.y - newVA.y) < MIN_WALL_LEN) return

  // ✅ allowed с большим tolPx
  if (!allowedEdit(newVA, newVB, ed.id)) return

  const old = {
    a: { ...w.a },
    b: { ...w.b },
    va: { ...(w.va || w.a) },
    vb: { ...(w.vb || w.b) },
  }

  w.va = newVA
  w.vb = newVB

  normalizeNormalWall(w, { snapPx: config.snap.draw.snapPx, doTrim: true })

  const clearOpts =
    (ed.kind === 'move')
      ? { endGuard: 0, samples: 32 }
      : { endGuard: 0.06, samples: 32 }

  if (!isSegmentClearOfCapitals(w.a, w.b, CLEAR_CAP, clearOpts)) {
    w.a = old.a
    w.b = old.b
    w.va = old.va
    w.vb = old.vb
    return
  }

  // финально
  w.va = newVA
  w.vb = newVB
}
draw.node.addEventListener('pointerdown', (e) => {
  // --- DOOR: place mode ---
  if (state.mode === 'draw-door') {
    // только ЛКМ для мыши
    if (e.button !== 0 && e.pointerType === 'mouse') return
    // на таче не даём браузеру делать своё
    if (e.pointerType !== 'mouse') e.preventDefault?.()

    const p = screenToWorld(draw, e.clientX, e.clientY)

    doorPlace = { pointerId: e.pointerId }
    draw.node.setPointerCapture?.(e.pointerId)

    // Shift = большая дверь (см updateDoorPreviewAtPoint)
    updateDoorPreviewAtPoint(p, { big: !!e.shiftKey })

    const pd = state.previewDoor

    // ✅ ставим только если ok (иначе у краёв подрезки будет ставиться "криво")
    if (pd?.ok && pd.wallId) {
      state.doors = state.doors || []

      // ✅ одна дверь на стену (и маленькая, и большая — всё равно 1)
      if (config.doors.oneInteriorPerWall) {
        const existsOnWall = (state.doors || []).some(d =>
          d.wallId === pd.wallId && d.kind === 'interior' && !d.locked
        )
        if (existsOnWall) {
          hint && (hint.textContent = 'На этой стене уже есть дверь. Можно только одну.')
          // можно оставить превью (пусть будет not-allowed), но не ставим
          scheduleRerender()
          return
        }
      }

      const newId = newDoorId()

      historyCommit('add-door')
      state.doors.push({
        id: newId,
        kind: 'interior',
        wallId: pd.wallId,
        t: pd.t,
        w: pd.w ?? DOOR_W_INTERIOR,      // ✅ важное: берём ширину из превью (big/small)
        thick: pd.thick ?? NOR_W,
        side: (pd.side === -1) ? -1 : +1,
        locked: false,
      })

      // ✅ авто-выход как у мебели + выделяем установленную дверь
      setMode('idle')

      // ✅ mobile: оставляем выделение, desktop: нет
      if (e.pointerType !== 'mouse') {
        state.selectedDoorId = newId
      }

      setPlannerCursor('default')
      scheduleRerender()
    } else {
      // мягкий фидбек "нельзя"
      setPlannerCursor('not-allowed')
      scheduleRerender()
    }

    return
  }

  // --- walls draw tool is handled in interaction/pointer.js ---
  if (state.mode === 'draw-wall') return

  // block non-left mouse buttons (for mouse)
  if (e.button !== 0 && e.pointerType === 'mouse') return
  if (state.ui?.dragged && state.mode !== 'draw-furniture') return

  const p = screenToWorld(draw, e.clientX, e.clientY)

  // --- furniture: rotate handle (works in idle and draw-furniture) ---
  const rotId = findFurnitureRotateIdFromEventTarget(e.target)
  if (rotId) {
    e.preventDefault()
    draw.node.setPointerCapture?.(e.pointerId)

    state.selectedFurnitureId = rotId
    state.selectedWallId = null
    state.selectedDoorId = null

    startFurnitureRotate(rotId, p)
    scheduleRerender()
    return
  }

  // --- furniture: body hit -> move (works in idle and draw-furniture) ---
  const fid = findFurnitureIdFromEventTarget(e.target)
  if (fid) {
    e.preventDefault()
    draw.node.setPointerCapture?.(e.pointerId)

    state.selectedFurnitureId = fid
    state.selectedWallId = null
    state.selectedDoorId = null

    startFurnitureMove(fid, p)
    scheduleRerender()
    return
  }

  // --- furniture: place new ---
  if (state.mode === 'draw-furniture') {
    const typeId = state.draftFurnitureTypeId
    const meta = typeId ? FURN_BY_TYPE.get(typeId) : null
    const pf = state.previewFurniture

    // 🖱️ mouse: click = place
    if (e.pointerType === 'mouse') {
      if (!meta || !pf || pf.ok === false) return

      historyCommit('add-furniture')
      state.furniture ??= []

      const newId = newFurnitureId()
      state.furniture.push({
        id: newId,
        typeId,
        symbolId: meta.symbolId,
        w: meta.w,
        h: meta.h,
        x: pf.x,
        y: pf.y,
        rot: pf.rot || 0,
      })

      setMode('idle')
      // ✅ desktop (mouse): НЕ выделяем после постановки
      scheduleRerender()
      return
    }

    // 📱 touch: начать placement (добавление будет в pointerup)
    if (!meta) return
    e.preventDefault()
    draw.node.setPointerCapture?.(e.pointerId)

    furniturePlace = { pointerId: e.pointerId }
    state.ui ??= {}
    state.ui.lockPan = true

    updateFurniturePreviewAtPoint(p)
    scheduleRerender()
    return
  }

  // --- doors select/drag ---
  const doorId = findDoorIdFromEventTarget(e.target)
  if (doorId) {
    const d = getDoorById(doorId)
    if (d && d.kind === 'interior' && !d.locked) {
      state.selectedDoorId = doorId
      state.selectedWallId = null
      state.selectedFurnitureId = null
      startDoorDrag(doorId)
      scheduleRerender()
      return
    }
  }

  // --- wall handle ---
  const h =
    typeof pickWallHandleAt === 'function'
      ? pickWallHandleAt(p, { tolPx: HANDLE_TOL_PX })
      : null

  if (h) {
    state.selectedWallId = h.id
    state.selectedDoorId = null
    state.selectedFurnitureId = null
    startEdit(h.handle, h.id, p)
    scheduleRerender()
    return
  }

  // --- wall by DOM target (особенно важно на touch) ---
  const wallIdFromTarget = findWallIdFromEventTarget(e.target)
  if (wallIdFromTarget) {
    state.selectedWallId = wallIdFromTarget
    state.selectedDoorId = null
    state.selectedFurnitureId = null
    startEdit('move', wallIdFromTarget, p)
    scheduleRerender()
    return
  }

  // --- wall body ---
  const wid = pickNormalWallAt(p, { tolPx: WALL_TOL_PX })
  if (wid) {
    state.selectedWallId = wid
    state.selectedDoorId = null
    state.selectedFurnitureId = null
    startEdit('move', wid, p)
    scheduleRerender()
    return
  }

  // --- empty click: clear selections ---
  state.selectedWallId = null
  state.selectedDoorId = null
  state.selectedFurnitureId = null
  scheduleRerender()
})
draw.node.addEventListener('pointermove', (e) => {
  const p = screenToWorld(draw, e.clientX, e.clientY)
  lastPointerWorld = p

  // ✅ если тащим превью для постановки (touch)
  if (furniturePlace && furniturePlace.pointerId === e.pointerId) {
    updateFurniturePreviewAtPoint(p)
    // scheduleRerender() можно не звать — updateFurniturePreviewAtPoint сам вызывает,
    // но оставить не страшно

    return
  }

  // ✅ 0.5) мебель: drag/rotate — СНАЧАЛА
  if (furnitureEdit) {
    applyFurnitureEdit(p)
    scheduleRerender()
    return
  }

  // ✅ 0) мебель: preview — ПОТОМ
  if (state.mode === 'draw-furniture') {
    updateFurniturePreviewAtPoint(p)
    return
  }


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
  if (state.mode === 'draw-wall' || state.mode === 'draw-door' || state.mode === 'draw-furniture') return
  if (state.ui?.lockPan || state.ui?.dragged || state.edit || doorEdit) return
  const furnHover = findFurnitureIdFromEventTarget(e.target)
  if (furnHover !== state.hoverFurnitureId) {
    state.hoverFurnitureId = furnHover
    if (furnHover) {
      state.hoverDoorId = null
      state.hoverWallId = null
    }
    scheduleRerender()
    return
  }
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
  // ✅ finish furniture placement (touch)
  if (furniturePlace && furniturePlace.pointerId === e.pointerId) {
    draw.node.releasePointerCapture?.(e.pointerId)
    furniturePlace = null

    state.ui ??= {}
    state.ui.lockPan = false

    const typeId = state.draftFurnitureTypeId
    const meta = typeId ? FURN_BY_TYPE.get(typeId) : null
    const pf = state.previewFurniture

    // ставим только если валидно
    // ставим только если валидно
    if (meta && pf && pf.ok !== false) {
      historyCommit('add-furniture')
      state.furniture ??= []

      const newId = newFurnitureId()
      state.furniture.push({
        id: newId,
        typeId,
        symbolId: meta.symbolId,
        w: meta.w,
        h: meta.h,
        x: pf.x,
        y: pf.y,
        rot: pf.rot || 0,
      })

      // ✅ сначала выходим в idle (оно всё сбросит)
      setMode('idle')

      // ✅ потом возвращаем выделение (только mobile/touch ветка)
      state.selectedFurnitureId = newId
    }

    scheduleRerender()
    return
  }
  // если ставили дверь — отпускаем capture
  if (doorPlace && doorPlace.pointerId === e.pointerId) {
    draw.node.releasePointerCapture?.(e.pointerId)
    doorPlace = null
  }

  if (state.mode === 'draw-wall') return

  if (furnitureEdit) {
    draw.node.releasePointerCapture?.(e.pointerId)
    stopFurnitureEdit()
    scheduleRerender()
    return
  }

  if (doorEdit) {
    stopDoorDrag()
    scheduleRerender()
    return
  }

  if (!state.edit) return
  stopEdit()
  scheduleRerender()
})

draw.node.addEventListener('pointercancel', (e) => {
  // ✅ cancel furniture placement
  if (furniturePlace && furniturePlace.pointerId === e.pointerId) {
    draw.node.releasePointerCapture?.(e.pointerId)
    furniturePlace = null
    state.ui ??= {}
    state.ui.lockPan = false
    scheduleRerender()
    return
  }

  if (furnitureEdit) {
    stopFurnitureEdit()
    scheduleRerender()
    return
  }
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
initWindowsFromTemplate()
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

function initTraceFromURL() {
  const params = new URLSearchParams(location.search)
  const traceOn = params.get('trace') === '1' || localStorage.trace === '1'

  if (!traceOn) return

  state.trace.active = true
  state.trace.imageHref = './planner/assets/plan.jpg'

  // ты говорил: верхняя ширина 12м, высота пусть 6м
  // (если UNITS_PER_M=100, то 12м = 1200, 6м = 600)
  state.trace.rectWorld = { x: 0, y: 0, w: 1200, h: 600 }

  state.trace.points = []
}
initTraceFromURL()

// удобно для дебага в консоли
window.state = state