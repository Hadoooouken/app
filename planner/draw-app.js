import { state, wid } from '../engine/state.js'
import { config } from '../engine/config.js'
import { historyCommit, undo } from '../engine/history.js'
import { createSVG, screenToWorld } from '../renderer/svg.js'
import { render, fitToWalls } from '../renderer/render.js'
import { ensureCapitalInnerFaces } from '../engine/capitals-inner.js'
import { projectPointToSegmentClamped } from '../engine/geom.js'
import { loadFurnitureSpriteIntoDefs } from './furniture-catalog.js'

export const DrawTemplate = {
    init: async function (options = {}) {
        const runtimeConfig = options.config || options.settings || null
        if (runtimeConfig) {
            config.override(runtimeConfig)
        }

        const workspace = document.getElementById('workspace')
        const draw = createSVG(workspace)

        const imageInput = document.getElementById('image-input')
        const btnLoadImage = document.getElementById('btn-load-image')
        const btnSaveJson = document.getElementById('btn-save-json')
        const btnClear = document.getElementById('btn-clear')
        const btnUndo = document.getElementById('btn-undo')
        const btnCenter = document.getElementById('btn-center')

        const btnCapital = document.getElementById('tool-capital')
        const btnWindow = document.getElementById('tool-window')
        const btnBalcony = document.getElementById('tool-balcony')
        const btnEntryDoor = document.getElementById('tool-entry-door')
        const btnRiserH = document.getElementById('tool-riser-h')
        const btnRiserV = document.getElementById('tool-riser-v')

        const status = document.getElementById('status')
        const hint = document.getElementById('hint')

        const CAPITAL_POINT_SNAP_PX = 14
        const CAPITAL_AXIS_SNAP_PX = 10
        const CAPITAL_HIT_PX = 24
        const CAPITAL_SEG_SNAP_PX = 16
        const EPS_AXIS = 1e-6

        const RISER_H = {
            typeId: 'stoyak',
            symbolId: 'mebel-stoyak',
            w: 50,
            h: 28,
        }

        const RISER_V = {
            typeId: 'stoyak-vertical',
            symbolId: 'mebel-stoyak-vertical',
            w: 28,
            h: 50,
        }

        let currentTool = 'capital'
        let capitalStart = null

        initState()
        state.editorType = 'draw-template'

        await loadFurnitureSpriteIntoDefs(draw)
        rerender()
        setTool('capital')

        btnLoadImage?.addEventListener('click', () => imageInput?.click())
        imageInput?.addEventListener('change', onImageSelected)
        btnSaveJson?.addEventListener('click', saveJsonToFile)
        btnClear?.addEventListener('click', clearTemplate)
        btnUndo?.addEventListener('click', () => {
            cancelCapitalDraft()
            if (undo()) rerender()
        })
        btnCenter?.addEventListener('click', centerScene)

        btnCapital?.addEventListener('click', () => setTool('capital'))
        btnWindow?.addEventListener('click', () => setTool('window'))
        btnBalcony?.addEventListener('click', () => setTool('balcony'))
        btnEntryDoor?.addEventListener('click', () => setTool('entry-door'))
        btnRiserH?.addEventListener('click', () => setTool('riser-h'))
        btnRiserV?.addEventListener('click', () => setTool('riser-v'))

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                cancelCapitalDraft()
                rerender()
            }

            const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
            const mod = isMac ? e.metaKey : e.ctrlKey
            if (mod && e.key.toLowerCase() === 'z') {
                e.preventDefault()
                cancelCapitalDraft()
                if (undo()) rerender()
            }
        })

        draw.node.addEventListener('pointermove', (e) => {
            const raw = screenToWorld(draw, e.clientX, e.clientY)

            if (currentTool === 'capital' && capitalStart) {
                const end = snapCapitalDraftPoint(raw, capitalStart, capitalStart)

                state.mode = 'draw-wall'
                state.previewWall = {
                    a: { ...capitalStart },
                    b: { ...end },
                    ok: !isZeroLenSegment(capitalStart, end),
                }

                rerender()
                return
            }

            if (state.previewWall) {
                state.previewWall = null
                if (state.mode === 'draw-wall') state.mode = 'idle'
                rerender()
            }
        })

        draw.node.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return

            const raw = screenToWorld(draw, e.clientX, e.clientY)

            if (currentTool === 'capital') {
                handleCapitalTool(raw)
                return
            }

            const p = { ...raw }

            if (currentTool === 'window') {
                placeWindowOnCapital(p, 'std')
                return
            }

            if (currentTool === 'balcony') {
                placeWindowOnCapital(p, 'balcony')
                return
            }

            if (currentTool === 'entry-door') {
                placeEntryDoorOnCapital(p)
                return
            }

            if (currentTool === 'riser-h') {
                placeRiser(p, RISER_H)
                return
            }

            if (currentTool === 'riser-v') {
                placeRiser(p, RISER_V)
                return
            }
        })

        function dist(a, b) {
            return Math.hypot(a.x - b.x, a.y - b.y)
        }

        function worldTol(px) {
            return px / Math.max(1e-6, state.view.scale)
        }

        function samePoint(a, b, tol = 1e-6) {
            return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol
        }

        function isVerticalSeg(a, b, eps = EPS_AXIS) {
            return Math.abs(a.x - b.x) <= eps
        }

        function isHorizontalSeg(a, b, eps = EPS_AXIS) {
            return Math.abs(a.y - b.y) <= eps
        }

        function orthogonalPoint(start, p) {
            const dx = p.x - start.x
            const dy = p.y - start.y

            if (Math.abs(dx) >= Math.abs(dy)) {
                return {
                    point: { x: p.x, y: start.y },
                    axis: 'h',
                }
            }

            return {
                point: { x: start.x, y: p.y },
                axis: 'v',
            }
        }

        function collectCapitalNodes(excludePoint = null) {
            const pts = []

            for (const w of (state.walls || [])) {
                if (!w || w.kind !== 'capital') continue

                for (const p of [w.a, w.b]) {
                    if (excludePoint && samePoint(p, excludePoint)) continue
                    pts.push({ x: p.x, y: p.y })
                }
            }

            return pts
        }

        function snapCapitalStartPoint(raw) {
            const nodeTol = worldTol(CAPITAL_POINT_SNAP_PX)
            const segTol = worldTol(CAPITAL_SEG_SNAP_PX)

            let bestNode = null
            let bestNodeD = Infinity

            for (const pt of collectCapitalNodes()) {
                const d = dist(raw, pt)
                if (d <= nodeTol && d < bestNodeD) {
                    bestNode = pt
                    bestNodeD = d
                }
            }

            if (bestNode) return { ...bestNode }

            let bestSeg = null
            let bestSegD = Infinity

            for (const w of (state.walls || [])) {
                if (!w || w.kind !== 'capital') continue

                const pr = projectPointToSegmentClamped(raw, w.a, w.b)
                if (pr.d <= segTol && pr.d < bestSegD) {
                    bestSeg = pr
                    bestSegD = pr.d
                }
            }

            return bestSeg ? { ...bestSeg.point } : { ...raw }
        }

        function snapCapitalDraftPoint(raw, start, excludePoint = null) {
            const pointTol = worldTol(CAPITAL_POINT_SNAP_PX)
            const axisTol = worldTol(CAPITAL_AXIS_SNAP_PX)
            const segTol = worldTol(CAPITAL_SEG_SNAP_PX)

            const { point: ortho, axis } = orthogonalPoint(start, raw)
            const nodes = collectCapitalNodes(excludePoint)

            let bestNode = null
            let bestNodeD = Infinity

            for (const pt of nodes) {
                const axisOk =
                    axis === 'h'
                        ? Math.abs(pt.y - start.y) <= axisTol
                        : Math.abs(pt.x - start.x) <= axisTol

                if (!axisOk) continue

                const d = dist(ortho, pt)
                if (d <= pointTol && d < bestNodeD) {
                    bestNode = pt
                    bestNodeD = d
                }
            }

            if (bestNode) {
                return { x: bestNode.x, y: bestNode.y }
            }

            let bestSeg = null
            let bestSegD = Infinity

            for (const w of (state.walls || [])) {
                if (!w || w.kind !== 'capital') continue

                const compatible =
                    axis === 'h'
                        ? isVerticalSeg(w.a, w.b)
                        : isHorizontalSeg(w.a, w.b)

                if (!compatible) continue

                const pr = projectPointToSegmentClamped(ortho, w.a, w.b)

                if (axis === 'h') {
                    if (Math.abs(pr.point.y - start.y) > axisTol) continue
                } else {
                    if (Math.abs(pr.point.x - start.x) > axisTol) continue
                }

                if (pr.d <= segTol && pr.d < bestSegD) {
                    bestSeg = pr
                    bestSegD = pr.d
                }
            }

            if (bestSeg) {
                return axis === 'h'
                    ? { x: bestSeg.point.x, y: start.y }
                    : { x: start.x, y: bestSeg.point.y }
            }

            const out = { ...ortho }

            if (axis === 'h') {
                let bestX = null
                let bestDX = Infinity

                for (const pt of nodes) {
                    const dx = Math.abs(pt.x - ortho.x)
                    if (dx <= pointTol && dx < bestDX) {
                        bestDX = dx
                        bestX = pt.x
                    }
                }

                if (bestX !== null) out.x = bestX
            } else {
                let bestY = null
                let bestDY = Infinity

                for (const pt of nodes) {
                    const dy = Math.abs(pt.y - ortho.y)
                    if (dy <= pointTol && dy < bestDY) {
                        bestDY = dy
                        bestY = pt.y
                    }
                }

                if (bestY !== null) out.y = bestY
            }

            return out
        }

        function isZeroLenSegment(a, b, tol = 1e-6) {
            return Math.hypot(b.x - a.x, b.y - a.y) <= tol
        }

        function isSameCapitalSegment(a, b, tol = 1e-6) {
            for (const w of (state.walls || [])) {
                if (!w || w.kind !== 'capital') continue

                const sameDir = dist(a, w.a) <= tol && dist(b, w.b) <= tol
                const revDir = dist(a, w.b) <= tol && dist(b, w.a) <= tol

                if (sameDir || revDir) return true
            }

            return false
        }

        function initState() {
            state.mode = 'idle'
            state.mobileMode = 'move'

            state.walls = []
            state.doors = []
            state.windows = []
            state.furniture = []

            state.selectedWallId = null
            state.hoverWallId = null
            state.selectedDoorId = null
            state.hoverDoorId = null
            state.selectedFurnitureId = null
            state.hoverFurnitureId = null

            state.previewWall = null
            state.previewDoor = null
            state.previewFurniture = null

            state.view = { scale: 1, offsetX: 0, offsetY: 0 }
            state.ui = { dragged: false, lockPan: false, snapPulse: null }
            state.snapPoint = null

            state.trace = {
                active: false,
                imageHref: '',
                rectWorld: { x: -500, y: -300, w: 1000, h: 600 },
                points: [],
                opacity: 0.6,
            }
        }

        function setTool(tool) {
            currentTool = tool
            cancelCapitalDraft()

            btnCapital?.classList.toggle('is-active', tool === 'capital')
            btnWindow?.classList.toggle('is-active', tool === 'window')
            btnBalcony?.classList.toggle('is-active', tool === 'balcony')
            btnEntryDoor?.classList.toggle('is-active', tool === 'entry-door')
            btnRiserH?.classList.toggle('is-active', tool === 'riser-h')
            btnRiserV?.classList.toggle('is-active', tool === 'riser-v')

            switch (tool) {
                case 'capital':
                    hint.textContent = 'Капитальная стена: клик A, клик B. Стена рисуется строго по X/Y и магнитится к готовым углам.'
                    break
                case 'window':
                    hint.textContent = 'Окно: клик по капитальной стене.'
                    break
                case 'balcony':
                    hint.textContent = 'Балконный блок: клик по капитальной стене.'
                    break
                case 'entry-door':
                    hint.textContent = 'Входная дверь: клик по капитальной стене.'
                    break
                case 'riser-h':
                    hint.textContent = 'Стояк H: клик по месту установки.'
                    break
                case 'riser-v':
                    hint.textContent = 'Стояк V: клик по месту установки.'
                    break
                default:
                    hint.textContent = ''
            }

            rerender()
        }

        function rerender() {
            render(draw)
            updateStatus()
        }

        function updateStatus() {
            const caps = (state.walls || []).filter(w => w.kind === 'capital').length
            const wins = (state.windows || []).length
            const doors = (state.doors || []).length
            const risers = (state.furniture || []).length

            status.textContent =
                `Tool: ${currentTool} | capital: ${caps} | windows: ${wins} | doors: ${doors} | risers: ${risers}`
        }

        function cancelCapitalDraft() {
            capitalStart = null
            state.previewWall = null
            state.mode = 'idle'
        }

        function handleCapitalTool(p) {
            if (!capitalStart) {
                capitalStart = snapCapitalStartPoint(p)
                state.mode = 'draw-wall'
                state.previewWall = {
                    a: { ...capitalStart },
                    b: { ...capitalStart },
                    ok: false,
                }
                rerender()
                return
            }

            const end = snapCapitalDraftPoint(p, capitalStart, capitalStart)

            if (isZeroLenSegment(capitalStart, end)) {
                cancelCapitalDraft()
                rerender()
                return
            }

            if (isSameCapitalSegment(capitalStart, end)) {
                cancelCapitalDraft()
                rerender()
                return
            }

            historyCommit('add-capital-wall')
            state.walls.push({
                id: wid(),
                kind: 'capital',
                a: { ...capitalStart },
                b: { ...end },
            })

            ensureCapitalInnerFaces()
            cancelCapitalDraft()
            rerender()
        }

        function nearestCapitalHit(p, tolPx = CAPITAL_HIT_PX) {
            const scale = Math.max(1e-6, state.view.scale)
            const tolWorld = tolPx / scale

            let best = null

            for (const w of (state.walls || [])) {
                if (!w || w.kind !== 'capital') continue

                const pr = projectPointToSegmentClamped(p, w.a, w.b)
                if (pr.d > tolWorld) continue

                if (!best || pr.d < best.d) {
                    best = {
                        wall: w,
                        point: { ...pr.point },
                        t: pr.t,
                        d: pr.d,
                    }
                }
            }

            return best
        }

        function clampOpeningTToWall(t, openingW, wall) {
            const dx = wall.b.x - wall.a.x
            const dy = wall.b.y - wall.a.y
            const len = Math.hypot(dx, dy) || 1

            const half = openingW / 2
            const marginT = Math.min(0.49, half / len)

            return Math.max(marginT, Math.min(1 - marginT, t))
        }

        function placeWindowOnCapital(p, kind = 'std') {
            const hit = nearestCapitalHit(p)
            if (!hit) return

            const width =
                kind === 'balcony'
                    ? (config.windows.balconyW ?? 180)
                    : (config.windows.defaultW ?? 100)

            historyCommit(kind === 'balcony' ? 'add-balcony' : 'add-window')

            state.windows.push({
                id: wid(),
                kind,
                wallId: hit.wall.id,
                t: clampOpeningTToWall(hit.t, width, hit.wall),
                w: width,
            })

            rerender()
        }

        function placeEntryDoorOnCapital(p) {
            const hit = nearestCapitalHit(p)
            if (!hit) return

            const width = config.doors.defaultEntryW ?? 90

            historyCommit('add-entry-door')

            state.doors.push({
                id: wid(),
                kind: 'entry',
                wallId: hit.wall.id,
                t: clampOpeningTToWall(hit.t, width, hit.wall),
                w: width,
                thick: config.walls.CAP_W,
                locked: true,
            })

            rerender()
        }

        function placeRiser(p, meta) {
            historyCommit('add-riser')

            state.furniture.push({
                id: wid(),
                typeId: meta.typeId,
                symbolId: meta.symbolId,
                w: meta.w,
                h: meta.h,
                x: p.x,
                y: p.y,
                rot: 0,
            })

            rerender()
        }

        async function onImageSelected(e) {
            const file = e.target.files?.[0]
            if (!file) return

            const dataUrl = await fileToDataUrl(file)
            const size = await loadImageSize(dataUrl)

            state.trace.active = true
            state.trace.imageHref = dataUrl
            state.trace.rectWorld = {
                x: -size.width / 2,
                y: -size.height / 2,
                w: size.width,
                h: size.height,
            }
            state.trace.opacity = 0.6

            centerScene()
            rerender()
        }

        function fileToDataUrl(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader()
                reader.onload = () => resolve(reader.result)
                reader.onerror = reject
                reader.readAsDataURL(file)
            })
        }

        function loadImageSize(src) {
            return new Promise((resolve, reject) => {
                const img = new Image()
                img.onload = () => resolve({ width: img.width, height: img.height })
                img.onerror = reject
                img.src = src
            })
        }

        function clearTemplate() {
            historyCommit('clear-template')

            state.walls = []
            state.windows = []
            state.doors = []
            state.furniture = []

            cancelCapitalDraft()
            rerender()
        }

        function centerScene() {
            if ((state.walls || []).length) {
                fitToWalls(draw, { padding: 120, maxScale: 2 })
                rerender()
                return
            }

            if (state.trace?.active) {
                fitToTraceRect(state.trace.rectWorld, { padding: 80, maxScale: 2 })
                rerender()
            }
        }

        function fitToTraceRect(rectWorld, { padding = 80, maxScale = 2, minScale = 0.1 } = {}) {
            const rect = draw.node.getBoundingClientRect()
            const wW = Math.max(1, rectWorld.w)
            const wH = Math.max(1, rectWorld.h)

            const viewW = Math.max(1, rect.width - padding * 2)
            const viewH = Math.max(1, rect.height - padding * 2)

            let s = Math.min(viewW / wW, viewH / wH)
            s = Math.max(minScale, Math.min(maxScale, s))

            const cx = rectWorld.x + rectWorld.w / 2
            const cy = rectWorld.y + rectWorld.h / 2
            const sx = rect.width / 2
            const sy = rect.height / 2

            state.view.scale = s
            state.view.offsetX = sx - cx * s
            state.view.offsetY = sy - cy * s
        }

        function exportTemplateJson() {
            ensureCapitalInnerFaces()

            return {
                version: 1,
                meta: {
                    unit: 'cm',
                    pxToWorld: 1,
                    createdAt: new Date().toISOString(),
                    source: 'draw.html',
                },

                walls: (state.walls || [])
                    .filter(w => w.kind === 'capital')
                    .map(w => ({
                        id: w.id,
                        kind: w.kind,
                        a: { ...w.a },
                        b: { ...w.b },
                        locked: true,
                    })),

                windows: (state.windows || []).map(w => ({
                    id: w.id,
                    kind: w.kind,
                    wallId: w.wallId,
                    t: w.t,
                    w: w.w,
                })),

                doors: (state.doors || [])
                    .filter(d => d.kind === 'entry')
                    .map(d => ({
                        id: d.id,
                        kind: d.kind,
                        wallId: d.wallId,
                        t: d.t,
                        w: d.w,
                        locked: true,
                    })),

                furniture: (state.furniture || []).map(f => ({
                    id: f.id,
                    typeId: f.typeId,
                    symbolId: f.symbolId,
                    w: f.w,
                    h: f.h,
                    x: f.x,
                    y: f.y,
                    rot: f.rot || 0,
                    locked: true,
                })),
            }
        }

        function saveJsonToFile() {
            const data = exportTemplateJson()
            const text = JSON.stringify(data, null, 2)
            const blob = new Blob([text], { type: 'application/json' })
            const url = URL.createObjectURL(blob)

            const a = document.createElement('a')
            a.href = url
            a.download = 'template.json'
            document.body.appendChild(a)
            a.click()
            a.remove()

            URL.revokeObjectURL(url)
        }
    }
}