// engine/t_junctions.js
import { state } from './state.js'

const EPS = 1e-6

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y)
const dot = (ax, ay, bx, by) => ax * bx + ay * by
const len2 = (ax, ay) => ax * ax + ay * ay

// { point, t, d } projection of p onto segment a-b
export function projectPointToSegment(p, a, b) {
    const abx = b.x - a.x
    const aby = b.y - a.y
    const apx = p.x - a.x
    const apy = p.y - a.y

    const ab2 = len2(abx, aby)
    if (ab2 < EPS) return { point: { ...a }, t: 0, d: dist(p, a) }

    let t = dot(apx, apy, abx, aby) / ab2
    t = clamp(t, 0, 1)

    const q = { x: a.x + abx * t, y: a.y + aby * t }
    return { point: q, t, d: dist(p, q) }
}

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
        { key: 'a', p: newWall.a, otherKey: 'b' },
        { key: 'b', p: newWall.b, otherKey: 'a' },
    ]

    for (const ep of endpoints) {
        let best = null // { point, d }

        for (const w of (state.walls || [])) {
            if (!w || w.kind === 'capital') continue
            if (!w.id) continue
            if (w.id === newWall.id) continue

            // if already hits an existing node -> don't snap (already connected)
            if (samePoint(ep.p, w.a, tolWorld) || samePoint(ep.p, w.b, tolWorld)) continue

            const pr = projectPointToSegment(ep.p, w.a, w.b)
            if (pr.d > tolWorld) continue

            // only interior of the target wall
            if (pr.t <= endGuard || pr.t >= (1 - endGuard)) continue

            if (!best || pr.d < best.d) best = { point: pr.point, d: pr.d }
        }

        if (!best) continue

        // snap endpoint to the projection
        newWall[ep.key] = { ...best.point }
    }

    return newWall
}
