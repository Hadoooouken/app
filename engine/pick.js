import { state } from './state.js'
import { distPointToPoint, distPointToSegment } from './geom.js'

const clampCos = (v) => Math.max(-1, Math.min(1, v))

function angleBetween(ax, ay, bx, by) {
    const al = Math.hypot(ax, ay) || 1
    const bl = Math.hypot(bx, by) || 1
    const cos = (ax * bx + ay * by) / (al * bl)
    return Math.acos(clampCos(cos))
}

// вернуть {id, handle:'a'|'b'} если попали рядом с концом
export function pickWallHandleAt(worldPoint, { tolPx = 14 } = {}) {
    const tolWorld = tolPx / Math.max(1e-6, state.view.scale)

    const candidates = []

    for (const w of (state.walls || [])) {
        if (!w || w.kind === 'capital') continue
        if (!w.id) continue

        const ends = [
            { handle: 'a', p: w.a, other: w.b },
            { handle: 'b', p: w.b, other: w.a },
        ]

        for (const e of ends) {
            const d = distPointToPoint(worldPoint, e.p)
            if (d > tolWorld) continue

            // угол — чтобы на L-стыке клик "чуть в сторону" выбирал нужную стену
            const vx = worldPoint.x - e.p.x
            const vy = worldPoint.y - e.p.y
            const wx = e.other.x - e.p.x
            const wy = e.other.y - e.p.y
            const ang = angleBetween(vx, vy, wx, wy)

            candidates.push({
                id: w.id,
                handle: e.handle,
                d,
                ang,
                prefer: (w.id === state.selectedWallId) ? 1 : 0, // если уже выбрана — держим её
            })
        }
    }

    if (!candidates.length) return null

    candidates.sort((c1, c2) =>
        (c2.prefer - c1.prefer) || // сначала выбранная
        (c1.d - c2.d) ||           // потом ближе
        (c1.ang - c2.ang)          // потом по направлению
    )

    return { id: candidates[0].id, handle: candidates[0].handle }
}

// вернуть id если попали в сегмент
export function pickNormalWallAt(worldPoint, { tolPx = 16 } = {}) {
    const tolWorld = tolPx / Math.max(1e-6, state.view.scale)

    let bestId = null
    let bestD = Infinity

    for (const w of (state.walls || [])) {
        if (!w || w.kind === 'capital') continue
        if (!w.id) continue

        // ✅ лучше по оси (va/vb), чтобы trim не мешал попаданию
        const a = w.va || w.a
        const b = w.vb || w.b

        const d = distPointToSegment(worldPoint, a, b)
        if (d <= tolWorld && d < bestD) {
            bestD = d
            bestId = w.id
        }
    }

    return bestId
}