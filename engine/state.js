export const state = {
  mode: 'select',
  walls: [],
  previewWall: null,
  view: { scale: 1, offsetX: 0, offsetY: 0 },
  selectedWallId: null,
  edit: null,     // { id, kind:'move'|'a'|'b', startMouse:{x,y}, startA:{x,y}, startB:{x,y} }
  ui: { dragged: false, lockPan: false },
  snapPoint: null,
}


export const UNITS_PER_M = 100      // 100 cm = 1 m
export const GRID_STEP_VIEW = 100   // шаг визуальной сетки (1 м)
export const GRID_STEP_SNAP = 25    // шаг магнита (25 см)


function wid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)
}

export function loadOneRoomTemplate() {
  // “однушка” условно: прямоугольник + перегородка под санузел/коридор
  // Единицы — в твоих world units (у тебя шаг сетки 100, значит 3000 = 30 клеток)
  const W = 5200
  const H = 3600

  const x0 = -W / 2
  const y0 = -H / 2
  const x1 = W / 2
  const y1 = H / 2

  const walls = [
    // внешний контур (капитальные)
    { id: wid(), kind: 'capital', a: { x: x0, y: y0 }, b: { x: x1, y: y0 } },
    { id: wid(), kind: 'capital', a: { x: x1, y: y0 }, b: { x: x1, y: y1 } },
    { id: wid(), kind: 'capital', a: { x: x1, y: y1 }, b: { x: x0, y: y1 } },
    { id: wid(), kind: 'capital', a: { x: x0, y: y1 }, b: { x: x0, y: y0 } },

    // внутренняя перегородка (обычная) — например отделить “санузел/коридор”
    { id: wid(), kind: 'normal', a: { x: x0 + 1600, y: y0 }, b: { x: x0 + 1600, y: y0 + 2200 } },
    { id: wid(), kind: 'normal', a: { x: x0 + 1600, y: y0 + 2200 }, b: { x: x0 + 2800, y: y0 + 2200 } },
  ]

  state.walls = walls
}
