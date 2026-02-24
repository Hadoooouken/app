// engine/state.js
import { config } from './config.js'

export const state = {
  mode: 'select',

  // geometry
  walls: [],
  doors: [],
  windows: [], 

  // selection / hover
  selectedWallId: null,
  hoverWallId: null,
  selectedDoorId: null,
  hoverDoorId: null,

  // previews
  previewWall: null,
  previewDoor: null, // { wallId, t, w, thick }

  // viewport
  view: { scale: 1, offsetX: 0, offsetY: 0 },

  // edit state
  edit: null,
  ui: { dragged: false, lockPan: false, snapPulse: null },
  snapPoint: null,

  // ✅ TRACE (режим обводки по картинке, скрытый)
  // trace: {
  //   active: false,
  //   imageHref: '', // путь к jpg
  //   rectWorld: { x: 0, y: 0, w: 1200, h: 600 }, // в world
  //   points: [], // массив {x,y}
  // },
  trace: {
    active: true,
    imageHref: '../planner/assets/plan.jpg', // путь ОТ index.html (или от страницы, где открыт проект)
    rectWorld: { x: 0, y: 0, w: 2000, h: 1200 }, // размеры в WORLD
    points: [],
  },
}

// ---------------- helpers ----------------
export function wid() {
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

  const CAP_W = config.walls.CAP_W
  const NOR_W = config.walls.NOR_W

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
    },

    // Пример входной двери: не двигается/не редактируется
    {
      id: wid(),
      kind: 'entry',
      wallId: capBottom, // ✅ привязка к капитальной
      t: 0.2,
      w: 90,             
      thick: CAP_W,      // как капитальная, чтобы красиво
      locked: true,      // UI/interaction игнорит locked
    },
  ]

  // reset selections/hovers
  state.selectedWallId = null
  state.hoverWallId = null
  state.selectedDoorId = null
  state.hoverDoorId = null

  // reset previews
  state.previewWall = null
  state.previewDoor = null

  // reset mode/editor/ui
  state.mode = 'select'
  state.edit = null
  state.ui = { dragged: false, lockPan: false, snapPulse: null }
  state.snapPoint = null
}