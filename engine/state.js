// engine/state.js

export const state = {
  mode: 'select',
  walls: [],
  previewWall: null,
  view: { scale: 1, offsetX: 0, offsetY: 0 },
  selectedWallId: null,
  edit: null, // { id, kind:'move'|'a'|'b', startMouse:{x,y}, startA:{x,y}, startB:{x,y} }
  ui: { dragged: false, lockPan: false, snapPulse: null },
  snapPoint: null,
}

// ---- Units / grid ----
export const UNIT = 'cm'
export const UNITS_PER_M = 100      // 100 cm = 1 m (у тебя 100 world = 1m)
export const GRID_STEP_VIEW = 100   // визуальная сетка (1 м)
export const GRID_STEP_SNAP = 25    // магнит (25 см)

// ---- Wall thickness in WORLD units ----
export const CAP_W = 28
export const NOR_W = 10
export const OVERLAP = 5

// насколько normal должен держаться “внутри” от оси капитальной,
// чтобы визуально не залезать в её толщину
export const CLEAR_FROM_CAPITAL = (CAP_W / 2) + (NOR_W / 2) - OVERLAP

function wid() {
  return (crypto?.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2)
}

// пример шаблона (если нужно)
export function loadOneRoomTemplate() {
  const W = 5200
  const H = 3600

  const x0 = -W / 2
  const y0 = -H / 2
  const x1 = W / 2
  const y1 = H / 2

  state.walls = [
    // capital
    { id: wid(), kind: 'capital', a: { x: x0, y: y0 }, b: { x: x1, y: y0 } },
    { id: wid(), kind: 'capital', a: { x: x1, y: y0 }, b: { x: x1, y: y1 } },
    { id: wid(), kind: 'capital', a: { x: x1, y: y1 }, b: { x: x0, y: y1 } },
    { id: wid(), kind: 'capital', a: { x: x0, y: y1 }, b: { x: x0, y: y0 } },

    // normal
    { id: wid(), kind: 'normal', a: { x: x0 + 1600, y: y0 }, b: { x: x0 + 1600, y: y0 + 2200 } },
    { id: wid(), kind: 'normal', a: { x: x0 + 1600, y: y0 + 2200 }, b: { x: x0 + 2800, y: y0 + 2200 } },
  ]
}
