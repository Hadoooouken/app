// engine/pick.js
import { state } from './state.js'
import { distPointToSegment, distPointToPoint } from './geom.js'

// вернуть {id, handle:'a'|'b'} если попали рядом с концом
export function pickWallHandleAt(worldPoint, { tolPx = 14 } = {}) {
    const tolWorld = tolPx / Math.max(1e-6, state.view.scale)

    let best = null
    let bestD = Infinity

    for (const w of (state.walls || [])) {
        if (w.kind === 'capital') continue
        if (!w.id) continue

        const da = distPointToPoint(worldPoint, w.a)
        if (da <= tolWorld && da < bestD) {
            bestD = da
            best = { id: w.id, handle: 'a' }
        }

        const db = distPointToPoint(worldPoint, w.b)
        if (db <= tolWorld && db < bestD) {
            bestD = db
            best = { id: w.id, handle: 'b' }
        }
    }

    return best
}

// вернуть id если попали в сегмент
export function pickNormalWallAt(worldPoint, { tolPx = 16 } = {}) {
    const tolWorld = tolPx / Math.max(1e-6, state.view.scale)

    let bestId = null
    let bestD = Infinity

    for (const w of (state.walls || [])) {
        if (w.kind === 'capital') continue
        if (!w.id) continue

        const d = distPointToSegment(worldPoint, w.a, w.b)
        if (d <= tolWorld && d < bestD) {
            bestD = d
            bestId = w.id
        }
    }

    return bestId
}
