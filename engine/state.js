// engine/state.js

export const state = {
  mode: 'select',

  // геометрия
  walls: [],
  doors: [],

  // selection
  selectedWallId: null,
  hoverWallId: null,
  selectedDoorId: null,

  // interaction/render helpers
  previewWall: null,
  view: { scale: 1, offsetX: 0, offsetY: 0 },
  edit: null,
  ui: { dragged: false, lockPan: false, snapPulse: null },
  snapPoint: null,

  previewDoor: null, // { wallId, t, w, thick }
  selectedDoorId: null,
}

// ---- Units / grid ----
export const UNIT = 'cm'
export const UNITS_PER_M = 100      // 100 cm = 1 m (world units = cm)
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
  // crypto.randomUUID() есть в современных браузерах
  return (globalThis.crypto?.randomUUID)
    ? globalThis.crypto.randomUUID()
    : `id_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

/**
 * Пример шаблона “одна комната”.
 * ВАЖНО:
 * - двери лежат в state.doors, НЕ в state.walls
 * - door.wallId должен ссылаться на существующую стену (id)
 */
export function loadOneRoomTemplate() {
  const W = 5200
  const H = 3600

  const x0 = -W / 2
  const y0 = -H / 2
  const x1 = W / 2
  const y1 = H / 2

  // заранее создаём id стен, чтобы на них можно было ссылаться дверями
  const capTop = wid()
  const capRight = wid()
  const capBottom = wid()
  const capLeft = wid()

  const n1 = wid()
  const n2 = wid()

  state.walls = [
    // capital box
    { id: capTop, kind: 'capital', a: { x: x0, y: y0 }, b: { x: x1, y: y0 } },
    { id: capRight, kind: 'capital', a: { x: x1, y: y0 }, b: { x: x1, y: y1 } },
    { id: capBottom, kind: 'capital', a: { x: x1, y: y1 }, b: { x: x0, y: y1 } },
    { id: capLeft, kind: 'capital', a: { x: x0, y: y1 }, b: { x: x0, y: y0 } },

    // normal пример (мок)
    { id: n1, kind: 'normal', a: { x: x0 + 1600, y: y0 }, b: { x: x0 + 1600, y: y0 + 2200 } },
    { id: n2, kind: 'normal', a: { x: x0 + 1600, y: y0 + 2200 }, b: { x: x0 + 2800, y: y0 + 2200 } },
  ]

  state.doors = [
    // Пример межкомнатной двери: можно двигать по стене (t меняется 0..1)
    {
      id: wid(),
      kind: 'interior', // 'entry' | 'interior'
      wallId: n2,       // ✅ привязка к существующей normal-стене
      t: 0.5,           // центр двери вдоль стены 0..1
      w: 75,            // ширина проёма в см (world=cm)
      thick: NOR_W,     // толщина отрисовки двери
      // optional: можно добавить rotation/hinge потом
    },

    // Пример входной двери: не двигается/не редактируется (ты это решишь в UI)
    {
      id: wid(),
      kind: 'entry',
      wallId: capBottom, // ✅ привязка к капитальной
      t: 0.2,
      w: 90,             // обычно входная шире
      thick: CAP_W,      // как капитальная, чтобы красиво
      locked: true,      // удобно: UI/interaction просто игнорит locked
    },
  ]

  // сброс селектов
  state.selectedWallId = null
  state.hoverWallId = null
  state.selectedDoorId = null

  // сброс режима/драфта/редактора
  state.mode = 'select'
  state.previewWall = null
  state.edit = null
  state.ui = { dragged: false, lockPan: false, snapPulse: null }
  state.snapPoint = null
}
