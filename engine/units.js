import { config } from './config.js'

export const unitsToMeters = (u) => u / config.units.UNITS_PER_M
export const metersToUnits = (m) => m * config.units.UNITS_PER_M

export const wallLengthUnits = (w) =>
  Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)

export const wallLengthMeters = (w) =>
  unitsToMeters(wallLengthUnits(w))