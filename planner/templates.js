// planner/templates.js
import { state } from '../engine/state.js'
import { config } from '../engine/config.js'
import { ensureCapitalInnerFaces } from '../engine/capitals-inner.js'

let id = 1
const W = (ax, ay, bx, by, kind = 'capital') => ({
  id: `w${id++}`,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  kind,
})

function did() {
  return `d${Date.now()}_${Math.random().toString(16).slice(2)}`
}

const CAP_W = config.walls.CAP_W

// Окна/балконный блок только на капитальных стенах
export const studioWindows = [
  { wallId: 'w1', t: 165 / 1050, kind: 'std', w: 330 - CAP_W },
  { wallId: 'w1', t: 0.50, kind: 'std', w: 170 },
  { wallId: 'w1', t: 0.80, kind: 'std', w: 170 },

  // выход на балкон
  { wallId: 'w5', t: 0.40, kind: 'balcony', w: 180 },
]

export function loadStudioTemplate() {
  id = 1

  // коробка
  const x0 = 0
  const y0 = 0
  const x1 = 1050
  const y1 = 675

  // внутренние капитальные по скрину
  const X_BALCONY_R = 330
  const Y_BALCONY_B = 120

  const X_MAIN = 330
  const Y_MAIN_BOTTOM_TOP = 560

  // ---- ВНЕШНИЙ КОНТУР ----
  const capTop = W(x0, y0, x1, y0, 'capital')       // w1
  const capRight = W(x1, y0, x1, y1, 'capital')     // w2
  const capBottom = W(x1, y1, x0, y1, 'capital')    // w3
  const capLeft = W(x0, y1, x0, y0, 'capital')      // w4

  // ---- ВНУТРЕННИЕ КАПИТАЛЬНЫЕ ----

  // лоджия слева сверху
  const capBalconyBottom = W(0, Y_BALCONY_B, X_BALCONY_R, Y_BALCONY_B, 'capital') // w5

  // главная вертикальная стена
  const capMainTop = W(X_MAIN, 0, X_MAIN, 420, 'capital') // w6
  const capMainBottom = W(X_MAIN, Y_MAIN_BOTTOM_TOP, X_MAIN, y1, 'capital') // w7

  state.walls = [
    capTop,
    capRight,
    capBottom,
    capLeft,
    capBalconyBottom,
    capMainTop,
    capMainBottom,
  ]

  ensureCapitalInnerFaces()

  // только входная дверь
  state.doors = [
    {
      id: did(),
      kind: 'entry',
      wallId: capBottom.id,
      t: 0.54,
      w: 90,
      thick: CAP_W,
      locked: true,
    },
  ]

  // только окна/балконный блок
  state.windows = [...studioWindows]

  // стартовая мебель шаблона
  state.furniture = [
    {
      id: 'tpl_stoyak_1',
      typeId: 'stoyak',
      symbolId: 'mebel-stoyak',
      w: 50,
      h: 28,
      x: 690,
      y: 675,
      rot: 0,
    },
  ]

  // сброс интерактива
  state.previewWall = null
  state.previewDoor = null
  state.previewFurniture = null

  state.selectedWallId = null
  state.hoverWallId = null

  state.selectedDoorId = null
  state.hoverDoorId = null

  state.selectedFurnitureId = null
  state.hoverFurnitureId = null

  state.draft = null
  state.draftFurnitureTypeId = null
}