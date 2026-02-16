import { UNITS_PER_M } from './state.js'

export const unitsToMeters = (u) => u / UNITS_PER_M
export const metersToUnits = (m) => m * UNITS_PER_M

export const wallLengthUnits = (w) =>
  Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)

export const wallLengthMeters = (w) =>
  unitsToMeters(wallLengthUnits(w))
