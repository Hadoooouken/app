// engine/metrics.js
import { state, UNITS_PER_M } from './state.js'

const EPS = 1e-9
const unitsToMeters = (u) => u / UNITS_PER_M

// ======================================================
// ✅ ЕДИНЫЙ ИСТОЧНИК ГЕОМЕТРИИ ДЛЯ МЕТРИК
// ======================================================

export function wallGeom(w) {
  if (!w) return { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } }

  // capital — используем внутреннюю грань
  if (w.kind === 'capital') {
    return {
      a: w.ia || w.a,
      b: w.ib || w.b,
    }
  }

  // normal — используем строительную геометрию
  return {
    a: w.va || w.a,
    b: w.vb || w.b,
  }
}

export function wallLengthUnits(w) {
  const { a, b } = wallGeom(w)
  return Math.hypot(b.x - a.x, b.y - a.y)
}

export function wallLengthM(w) {
  return unitsToMeters(wallLengthUnits(w))
}

export function getSelectedWall() {
  const id = state.selectedWallId
  if (!id) return null
  return (state.walls || []).find(w => w.id === id) || null
}

export function totalNormalLengthM() {
  let sumUnits = 0
  for (const w of (state.walls || [])) {
    if (!w || w.kind === 'capital') continue
    sumUnits += wallLengthUnits(w)
  }
  return unitsToMeters(sumUnits)
}

// ======================================================
// 🔷 ПЛОЩАДЬ КАПИТАЛЬНОГО КОНТУРА (внутри стен)
// ======================================================

function keyOf(p) {
  return `${p.x}:${p.y}`
}

export function getCapitalPolygon() {
  const caps = (state.walls || []).filter(w => w?.kind === 'capital')
  if (caps.length < 3) return null

  const map = new Map()

  const add = (p, q) => {
    const k = keyOf(p)
    if (!map.has(k)) map.set(k, { p, n: [] })
    map.get(k).n.push(q)
  }

  for (const s of caps) {
    const { a, b } = wallGeom(s)
    add(a, b)
    add(b, a)
  }

  const first = wallGeom(caps[0]).a
  const firstK = keyOf(first)
  const loop = [{ ...first }]

  let curr = first
  let prev = null

  for (let guard = 0; guard < 10000; guard++) {
    const node = map.get(keyOf(curr))
    if (!node) return null

    let next = null
    for (const cand of node.n) {
      if (!prev) { next = cand; break }
      if (Math.abs(cand.x - prev.x) > EPS || Math.abs(cand.y - prev.y) > EPS) {
        next = cand
        break
      }
    }
    if (!next) return null

    prev = curr
    curr = next

    if (keyOf(curr) === firstK) break
    loop.push({ ...curr })
  }

  if (loop.length < 3) return null
  return loop
}

export function capitalAreaUnits2() {
  const poly = getCapitalPolygon()
  if (!poly || poly.length < 3) return 0

  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

export function capitalAreaM2() {
  return capitalAreaUnits2() / (UNITS_PER_M * UNITS_PER_M)
}

// ======================================================
// formatting helpers
// ======================================================

export function fmtM(v, digits = 2) {
  if (!Number.isFinite(v)) return '0'
  return v.toFixed(digits)
}

export function fmtM2(v, digits = 2) {
  if (!Number.isFinite(v)) return '0'
  return v.toFixed(digits)
}
