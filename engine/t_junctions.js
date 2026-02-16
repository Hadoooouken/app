// engine/t_junctions.js
import { state } from './state.js'
import { projectPointToSegmentClamped } from './geom.js'

function samePoint(a, b, tol) {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol
}

/**
 * "T-junction snap" without splitting:
 * - checks endpoints newWall.a and newWall.b
 * - if endpoint falls close to the interior of some NORMAL wall,
 *   it moves the endpoint to projection point (snap),
 *   BUT DOES NOT split the target wall.
 *
 * opts:
 *  - tolPx: picking tolerance in pixels (converted to world via scale)
 *  - endGuard: do not snap near ends of the target wall (by t)
 */
export function snapTJunctionEndpoints(newWall, {
  tolPx = 10,
  endGuard = 0.06,
} = {}) {
  const tolWorld = tolPx / Math.max(1e-6, state.view.scale)

  const endpoints = [
    { key: 'a', p: newWall.a },
    { key: 'b', p: newWall.b },
  ]

  for (const ep of endpoints) {
    let best = null // { point, d }

    for (const w of (state.walls || [])) {
      if (!w || w.kind === 'capital') continue
      if (!w.id) continue
      if (w.id === newWall.id) continue

      // если уже совпали с узлом — не снапим
      if (samePoint(ep.p, w.a, tolWorld) || samePoint(ep.p, w.b, tolWorld)) continue

      const pr = projectPointToSegmentClamped(ep.p, w.a, w.b)
      if (pr.d > tolWorld) continue

      // только внутренняя часть стены
      if (pr.t <= endGuard || pr.t >= (1 - endGuard)) continue

      if (!best || pr.d < best.d) best = { point: pr.point, d: pr.d }
    }

    if (!best) continue
    newWall[ep.key] = { ...best.point }
  }

  return newWall
}
