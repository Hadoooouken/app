import { unitsToMeters, unitsToSquareMeters } from './units.js'

// длина стены (в метрах)
export function wallLengthMeters(wall) {
  const dx = wall.b.x - wall.a.x
  const dy = wall.b.y - wall.a.y
  const lenUnits = Math.hypot(dx, dy)
  return unitsToMeters(lenUnits)
}

// общая длина всех normal стен
export function totalNormalLengthMeters(walls) {
  return walls
    .filter(w => w.kind === 'normal')
    .reduce((sum, w) => sum + wallLengthMeters(w), 0)
}

// площадь полигона (в м²)
export function polygonAreaMeters2(points) {
  if (!points || points.length < 3) return 0

  let area = 0
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length
    area += points[i].x * points[j].y
    area -= points[j].x * points[i].y
  }

  const areaUnits = Math.abs(area) / 2
  return unitsToSquareMeters(areaUnits)
}
