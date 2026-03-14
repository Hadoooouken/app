// // engine/capitals-inner.js
// import { state } from './state.js'

// // сравнение с допуском
// const EPS = 1e-9
// const samePt = (p, q) =>
//   Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS

// /**
//  * ВАЖНО:
//  * Для твоего кейса "строительные размеры" — это внутренний контур помещения.
//  * Поэтому inner-face капитальных стен НЕ должен сдвигаться на толщину.
//  *
//  * ia/ib = a/b (строительные координаты)
//  *
//  * Если позже понадобится внешняя грань — добавим oa/ob.
//  */
// export function ensureCapitalInnerFaces() {
//   const caps = (state.walls || []).filter(w => w?.kind === 'capital')
//   if (!caps.length) return

//   // пересчитываем только если:
//   // - нет ia/ib
//   // - или точки изменились
//   let need = false

//   for (const w of caps) {
//     if (!w.ia || !w.ib) { need = true; break }

//     if (!samePt(w.ia, w.a) || !samePt(w.ib, w.b)) {
//       // кто-то уже сдвигал inner-face — возвращаем как должно быть
//       need = true
//       break
//     }
//   }

//   if (!need) return

//   for (const w of caps) {
//     w.ia = { ...w.a }
//     w.ib = { ...w.b }
//   }
// }














// engine/capitals-inner.js
import { state } from './state.js'
import { config } from './config.js'

const EPS = 1e-9
let cachedKey = ''

const samePt = (p, q, eps = 1e-6) =>
  Math.abs(p.x - q.x) <= eps && Math.abs(p.y - q.y) <= eps

const round = (v, digits = 6) =>
  Math.round(v * 10 ** digits) / 10 ** digits

function keyOf(p) {
  return `${round(p.x, 3)}:${round(p.y, 3)}`
}

function signedArea(poly) {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

// Пересечение БЕСКОНЕЧНЫХ прямых AB и CD
function lineIntersection(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y }
  const s = { x: d.x - c.x, y: d.y - c.y }

  const denom = r.x * s.y - r.y * s.x
  if (Math.abs(denom) < EPS) return null

  const ca = { x: c.x - a.x, y: c.y - a.y }
  const t = (ca.x * s.y - ca.y * s.x) / denom

  return {
    x: round(a.x + r.x * t),
    y: round(a.y + r.y * t),
  }
}

// Строим замкнутый обход капиталок.
// Возвращает массив рёбер в порядке обхода:
// [{ wall, a, b, reversed }]
// где a->b — направление по контуру,
// reversed=true если направление обратное оригинальному wall.a -> wall.b
function buildOrderedLoop(caps) {
  if (!caps.length) return null

  const nodes = new Map()

  const addNode = (p, wall, end) => {
    const k = keyOf(p)
    if (!nodes.has(k)) nodes.set(k, [])
    nodes.get(k).push({ wall, end, p })
  }

  for (const w of caps) {
    addNode(w.a, w, 'a')
    addNode(w.b, w, 'b')
  }

  // Для простого контура в каждой вершине должно быть по 2 инцидентных стены
  for (const arr of nodes.values()) {
    if (arr.length !== 2) return null
  }

  const used = new Set()
  const ordered = []

  let currPoint = { ...caps[0].a }
  const startKey = keyOf(currPoint)

  for (let guard = 0; guard < caps.length + 5; guard++) {
    const arr = nodes.get(keyOf(currPoint))
    if (!arr) return null

    const nextRef = arr.find(x => !used.has(x.wall.id))
    if (!nextRef) break

    const w = nextRef.wall
    used.add(w.id)

    const forward = samePt(currPoint, w.a)
    const a = forward ? { ...w.a } : { ...w.b }
    const b = forward ? { ...w.b } : { ...w.a }

    ordered.push({
      wall: w,
      a,
      b,
      reversed: !forward,
    })

    currPoint = { ...b }

    if (keyOf(currPoint) === startKey && used.size === caps.length) {
      return ordered
    }
  }

  return null
}

/**
 * Считает ВНУТРЕННИЕ грани capital-стен.
 *
 * Модель:
 * - wall.a / wall.b = ОСЬ капитальной стены
 * - wall.ia / wall.ib = ВНУТРЕННЯЯ грань (смещена внутрь на CAP_W/2)
 *
 * Это нужно, чтобы:
 * - размеры капиталок были по внутреннему контуру
 * - площади помещений считались по чистому полу
 *
 * Важно:
 * - работает для одного замкнутого ортогонального контура
 * - если контур битый/не замкнутый, делаем безопасный fallback: ia/ib = a/b
 */
export function ensureCapitalInnerFaces() {
  const caps = (state.walls || []).filter(w => w?.kind === 'capital')
  if (!caps.length) return

  const CAP_W = config.walls?.CAP_W ?? 0
  const half = CAP_W / 2

  const key =
    `${CAP_W}|${caps.length}|` +
    caps
      .map(w => `${w.id}:${round(w.a.x)}:${round(w.a.y)}:${round(w.b.x)}:${round(w.b.y)}`)
      .join('|')

  const alreadyComputed = caps.every(w => w.ia && w.ib)

  if (key === cachedKey && alreadyComputed) return

  const ordered = buildOrderedLoop(caps)

  if (!ordered || ordered.length < 3) {
    for (const w of caps) {
      w.ia = { ...w.a }
      w.ib = { ...w.b }
    }
    cachedKey = key
    return
  }

  const poly = ordered.map(e => e.a)

  // В screen-space (Y вниз):
  // signedArea > 0  => обход по часовой
  // signedArea < 0  => обход против часовой
  const clockwise = signedArea(poly) > 0

  const offsetLines = ordered.map(({ a, b }) => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1

    // inward normal
    // clockwise  -> внутрь = левая нормаль
    // counterCW  -> внутрь = правая нормаль
    const nx = clockwise ? (-dy / len) : (dy / len)
    const ny = clockwise ? (dx / len) : (-dx / len)

    return {
      a: { x: round(a.x + nx * half), y: round(a.y + ny * half) },
      b: { x: round(b.x + nx * half), y: round(b.y + ny * half) },
      nx,
      ny,
    }
  })

  // innerVerts[i] — внутренняя вершина в начале ordered[i]
  const innerVerts = []

  for (let i = 0; i < ordered.length; i++) {
    const prev = offsetLines[(i - 1 + ordered.length) % ordered.length]
    const curr = offsetLines[i]

    let p = lineIntersection(prev.a, prev.b, curr.a, curr.b)

    // Если соседние сегменты коллинеарны/параллельны,
    // просто берём смещённую вершину текущего начала.
    if (!p) {
      const v = ordered[i].a
      p = {
        x: round(v.x + curr.nx * half),
        y: round(v.y + curr.ny * half),
      }
    }

    innerVerts.push(p)
  }

  // Записываем ia/ib обратно в исходные стены
  for (let i = 0; i < ordered.length; i++) {
    const edge = ordered[i]
    const startInner = innerVerts[i]
    const endInner = innerVerts[(i + 1) % ordered.length]

    if (!edge.reversed) {
      edge.wall.ia = { ...startInner }
      edge.wall.ib = { ...endInner }
    } else {
      // original wall.a соответствует oriented b
      edge.wall.ia = { ...endInner }
      edge.wall.ib = { ...startInner }
    }
  }

  cachedKey = key
}