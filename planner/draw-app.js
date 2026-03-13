import { state, wid } from '../engine/state.js'
import { config } from '../engine/config.js'
import { historyCommit, undo, historyBegin, historyEnd } from '../engine/history.js'
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
        const btnBuildMode = document.getElementById('btn-build-mode')

        const status = document.getElementById('status')
        const hint = document.getElementById('hint')


        const CAPITAL_POINT_SNAP_PX = 26   // сильнее липнем к готовым углам
        const CAPITAL_AXIS_SNAP_PX = 14    // чуть шире допуск по X/Y
        const CAPITAL_HIT_PX = 24
        const CAPITAL_SEG_SNAP_PX = 28     // сильнее липнем к оси стены
        const CAPITAL_END_SNAP_PX = 26     // липнем к концам сегмента
        const EPS_AXIS = 1e-6
        const CAPITAL_PICK_WALL_PX = 18
        const CAPITAL_PICK_HANDLE_PX = 16

        function findFurnitureIdFromEventTarget(target) {
            let el = target
            while (el && el !== draw.node) {
                if (el.getAttribute) {
                    const id = el.getAttribute('data-furniture-id')
                    if (id) return id
                }
                el = el.parentNode
            }
            return null
        }

        function getFurnitureById(id) {
            return (state.furniture || []).find(f => f.id === id) || null
        }

        function isDraggableTemplateFurniture(f) {
            return !!f && (f.typeId === 'stoyak' || f.typeId === 'stoyak-vertical')
        }

        function startFurnitureDrag(furnitureId, mouseWorld) {
            const f = getFurnitureById(furnitureId)
            if (!isDraggableTemplateFurniture(f)) return

            historyBegin('move-riser')

            furnitureEdit = {
                id: furnitureId,
                startMouse: { ...mouseWorld },
                startX: f.x,
                startY: f.y,
            }
        }

        function applyFurnitureDrag(mouseWorld) {
            if (!furnitureEdit) return

            const f = getFurnitureById(furnitureEdit.id)
            if (!isDraggableTemplateFurniture(f)) return

            const dx = mouseWorld.x - furnitureEdit.startMouse.x
            const dy = mouseWorld.y - furnitureEdit.startMouse.y

            f.x = furnitureEdit.startX + dx
            f.y = furnitureEdit.startY + dy
        }

        function stopFurnitureDrag() {
            if (!furnitureEdit) return
            furnitureEdit = null
            historyEnd()
        }

        function findWindowIdFromEventTarget(target) {
            let el = target
            while (el && el !== draw.node) {
                if (el.getAttribute) {
                    const id = el.getAttribute('data-window-id')
                    if (id) return id
                }
                el = el.parentNode
            }
            return null
        }

        function isDraggableTemplateWindow(win) {
            return !!win && (win.kind === 'balcony' || win.kind === 'std')
        }

        function getWindowById(id) {
            return (state.windows || []).find(w => w.id === id) || null
        }

        function startWindowDrag(windowId) {
            const win = getWindowById(windowId)
            if (!isDraggableTemplateWindow(win)) return

            const wall = (state.walls || []).find(w => w.id === win.wallId)
            if (!wall || wall.kind !== 'capital') return

            historyBegin('move-window')

            windowEdit = {
                id: windowId,
                wallId: wall.id,
            }
        }

        function applyWindowDrag(mouseWorld) {
            if (!windowEdit) return

            const win = getWindowById(windowEdit.id)
            if (!isDraggableTemplateWindow(win)) return

            const wall = (state.walls || []).find(w => w.id === win.wallId)
            if (!wall || wall.kind !== 'capital') return

            const pr = projectPointToSegmentClamped(mouseWorld, wall.a, wall.b)
            win.t = clampOpeningTToWall(pr.t, win.w, wall)
        }
        function stopWindowDrag() {
            if (!windowEdit) return
            windowEdit = null
            historyEnd()
        }

        let capitalEdit = null
        let windowEdit = null
        let furnitureEdit = null

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

        let currentTool = null
        let editorMode = 'idle' // 'idle' | 'build'
        let capitalStart = null

        initState()
        state.editorType = 'draw-template'

        await loadFurnitureSpriteIntoDefs(draw)
        syncUI()
        rerender()


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
                if (capitalStart) {
                    cancelCapitalDraft()
                    rerender()
                    return
                }

                if (editorMode === 'build') {
                    exitBuildMode()
                    return
                }
            }

            const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
            const mod = isMac ? e.metaKey : e.ctrlKey
            if (mod && e.key.toLowerCase() === 'z') {
                e.preventDefault()
                cancelCapitalDraft()
                if (undo()) rerender()
            }
        })

        btnBuildMode?.addEventListener('click', () => {
            if (editorMode === 'build') {
                exitBuildMode()
                return
            }

            editorMode = 'build'
            currentTool = null
            cancelCapitalDraft()

            syncUI()
            rerender()
        })

        draw.node.addEventListener('pointermove', (e) => {
            const raw = screenToWorld(draw, e.clientX, e.clientY)

            if (editorMode !== 'build' && furnitureEdit) {
                applyFurnitureDrag(raw)
                rerender()
                return
            }

            if (editorMode !== 'build' && windowEdit) {
                applyWindowDrag(raw)
                rerender()
                return
            }

            if (editorMode !== 'build' && capitalEdit) {
                applyCapitalEdit(raw)
                rerender()
                return
            }

            if (editorMode === 'build' && currentTool === 'capital' && capitalStart) {
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
            if (editorMode !== 'build') {
                const furnitureId = findFurnitureIdFromEventTarget(e.target)
                if (furnitureId) {
                    const f = getFurnitureById(furnitureId)

                    state.selectedFurnitureId = furnitureId
                    state.selectedWallId = null
                    state.selectedWindowId = null

                    if (isDraggableTemplateFurniture(f)) {
                        startFurnitureDrag(furnitureId, raw)
                    }

                    rerender()
                    return
                }

                const windowId = findWindowIdFromEventTarget(e.target)
                if (windowId) {
                    const win = getWindowById(windowId)

                    state.selectedWindowId = windowId
                    state.selectedFurnitureId = null
                    state.selectedWallId = null

                    if (isDraggableTemplateWindow(win)) {
                        startWindowDrag(windowId)
                    }

                    rerender()
                    return
                }

                const handleHit = pickCapitalHandleAt(raw)
                if (handleHit) {
                    state.selectedWallId = handleHit.id
                    state.selectedWindowId = null
                    state.selectedFurnitureId = null

                    startCapitalEdit(handleHit.handle, handleHit.id, raw)
                    rerender()
                    return
                }

                const wallHit = pickCapitalWallAt(raw)
                if (wallHit) {
                    state.selectedWallId = wallHit
                    state.selectedWindowId = null
                    state.selectedFurnitureId = null

                    startCapitalEdit('move', wallHit, raw)
                    rerender()
                    return
                }

                state.selectedWallId = null
                state.selectedWindowId = null
                state.selectedFurnitureId = null
                rerender()
                return
            }

            // BUILD MODE
            if (currentTool === 'capital') {
                state.selectedWallId = null
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

        draw.node.addEventListener('pointerup', () => {
            if (editorMode === 'build') return

            if (furnitureEdit) {
                stopFurnitureDrag()
                rerender()
                return
            }

            if (windowEdit) {
                stopWindowDrag()
                rerender()
                return
            }

            if (!capitalEdit) return
            stopCapitalEdit()
            rerender()
        })

        draw.node.addEventListener('pointercancel', () => {
            if (editorMode === 'build') return

            if (furnitureEdit) {
                stopFurnitureDrag()
                rerender()
                return
            }

            if (windowEdit) {
                stopWindowDrag()
                rerender()
                return
            }

            if (!capitalEdit) return
            stopCapitalEdit()
            rerender()
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

        function getCapitalById(id) {
            return (state.walls || []).find(w => w && w.kind === 'capital' && w.id === id) || null
        }

        function pickCapitalHandleAt(worldPoint, { tolPx = CAPITAL_PICK_HANDLE_PX } = {}) {
            const tolWorld = tolPx / Math.max(1e-6, state.view.scale)

            let best = null

            for (const w of (state.walls || [])) {
                if (!w || w.kind !== 'capital') continue
                if (!w.id) continue

                const da = dist(worldPoint, w.a)
                if (da <= tolWorld && (!best || da < best.d)) {
                    best = { id: w.id, handle: 'a', d: da }
                }

                const db = dist(worldPoint, w.b)
                if (db <= tolWorld && (!best || db < best.d)) {
                    best = { id: w.id, handle: 'b', d: db }
                }
            }

            return best ? { id: best.id, handle: best.handle } : null
        }

        function pickCapitalWallAt(worldPoint, { tolPx = CAPITAL_PICK_WALL_PX } = {}) {
            const tolWorld = tolPx / Math.max(1e-6, state.view.scale)

            let bestId = null
            let bestD = Infinity

            for (const w of (state.walls || [])) {
                if (!w || w.kind !== 'capital') continue
                if (!w.id) continue

                const pr = projectPointToSegmentClamped(worldPoint, w.a, w.b)

                // near ends -> handles, not body
                if (pr.t <= 0.08 || pr.t >= 0.92) continue

                if (pr.d <= tolWorld && pr.d < bestD) {
                    bestD = pr.d
                    bestId = w.id
                }
            }

            return bestId
        }

        function startCapitalEdit(kind, wallId, mouseWorld) {
            const w = getCapitalById(wallId)
            if (!w) return

            historyBegin(kind)

            capitalEdit = {
                id: wallId,
                kind, // 'move' | 'a' | 'b'
                startMouse: { ...mouseWorld },
                startA: { ...w.a },
                startB: { ...w.b },
            }

            state.selectedWallId = wallId
        }

        function applyCapitalEdit(mouseWorld) {
            if (!capitalEdit) return

            const w = getCapitalById(capitalEdit.id)
            if (!w) return

            const dx = mouseWorld.x - capitalEdit.startMouse.x
            const dy = mouseWorld.y - capitalEdit.startMouse.y

            let newA = { ...capitalEdit.startA }
            let newB = { ...capitalEdit.startB }

            if (capitalEdit.kind === 'move') {
                newA = {
                    x: capitalEdit.startA.x + dx,
                    y: capitalEdit.startA.y + dy,
                }
                newB = {
                    x: capitalEdit.startB.x + dx,
                    y: capitalEdit.startB.y + dy,
                }
            }

            if (capitalEdit.kind === 'a') {
                const fixed = capitalEdit.startB
                const moved = {
                    x: capitalEdit.startA.x + dx,
                    y: capitalEdit.startA.y + dy,
                }

                newA = orthogonalPoint(fixed, moved).point
                newB = { ...fixed }
            }

            if (capitalEdit.kind === 'b') {
                const fixed = capitalEdit.startA
                const moved = {
                    x: capitalEdit.startB.x + dx,
                    y: capitalEdit.startB.y + dy,
                }

                newB = orthogonalPoint(fixed, moved).point
                newA = { ...fixed }
            }

            if (isZeroLenSegment(newA, newB)) return

            w.a = { ...newA }
            w.b = { ...newB }

            ensureCapitalInnerFaces()
        }

        function stopCapitalEdit() {
            if (!capitalEdit) return
            capitalEdit = null
            historyEnd()
        }


        /////

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
            const endTol = worldTol(CAPITAL_END_SNAP_PX)

            const { point: ortho, axis } = orthogonalPoint(start, raw)
            const nodes = collectCapitalNodes(excludePoint)

            // 1) сначала очень стараемся сесть именно в готовый угол
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

            // 2) если угла рядом нет — липнем к совместимому сегменту,
            //    но если рядом конец сегмента, то садимся именно в него
            let best = null
            let bestD = Infinity

            for (const w of (state.walls || [])) {
                if (!w || w.kind !== 'capital') continue

                if (axis === 'h' && isVerticalSeg(w.a, w.b)) {
                    const xWall = w.a.x
                    const minY = Math.min(w.a.y, w.b.y)
                    const maxY = Math.max(w.a.y, w.b.y)

                    const dx = Math.abs(ortho.x - xWall)
                    const insideY = start.y >= (minY - endTol) && start.y <= (maxY + endTol)

                    if (!insideY || dx > segTol) continue

                    // если близко к концам вертикальной стены — липнем прямо в угол
                    const dA = dist(ortho, w.a)
                    const dB = dist(ortho, w.b)

                    if (dA <= pointTol || dB <= pointTol) {
                        const p = dA <= dB ? w.a : w.b
                        const d = Math.min(dA, dB)
                        if (d < bestD) {
                            bestD = d
                            best = { x: p.x, y: p.y }
                        }
                        continue
                    }

                    // иначе липнем к оси вертикальной стены
                    if (dx < bestD) {
                        bestD = dx
                        best = { x: xWall, y: start.y }
                    }
                }

                if (axis === 'v' && isHorizontalSeg(w.a, w.b)) {
                    const yWall = w.a.y
                    const minX = Math.min(w.a.x, w.b.x)
                    const maxX = Math.max(w.a.x, w.b.x)

                    const dy = Math.abs(ortho.y - yWall)
                    const insideX = start.x >= (minX - endTol) && start.x <= (maxX + endTol)

                    if (!insideX || dy > segTol) continue

                    // если близко к концам горизонтальной стены — липнем прямо в угол
                    const dA = dist(ortho, w.a)
                    const dB = dist(ortho, w.b)

                    if (dA <= pointTol || dB <= pointTol) {
                        const p = dA <= dB ? w.a : w.b
                        const d = Math.min(dA, dB)
                        if (d < bestD) {
                            bestD = d
                            best = { x: p.x, y: p.y }
                        }
                        continue
                    }

                    // иначе липнем к оси горизонтальной стены
                    if (dy < bestD) {
                        bestD = dy
                        best = { x: start.x, y: yWall }
                    }
                }
            }

            if (best) return best

            // 3) fallback: снап по оси к ближайшим узлам
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

            state.selectedWindowId = null
            state.hoverWindowId = null

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

        function exitBuildMode() {
            editorMode = 'idle'
            currentTool = null

            capitalStart = null
            capitalEdit = null
            windowEdit = null
            furnitureEdit = null

            state.selectedWallId = null
            state.selectedWindowId = null
            state.selectedFurnitureId = null
            state.selectedDoorId = null
            state.previewWall = null
            state.mode = 'idle'

            syncUI()
            rerender()
        }

        function setTool(tool) {
            // повторный клик по "Капиталка" выключает режим рисования
            if (tool === 'capital' && editorMode === 'build' && currentTool === 'capital') {
                exitBuildMode()
                return
            }

            currentTool = tool
            editorMode = 'build'
            cancelCapitalDraft()

            if (tool === 'capital') {
                state.mode = 'draw-wall'
            } else {
                state.mode = 'idle'
            }

            syncUI()
            rerender()
        }

        function syncUI() {
            const isBuild = editorMode === 'build'

            btnBuildMode?.classList.toggle('is-active', isBuild)

            btnCapital?.classList.toggle('is-active', isBuild && currentTool === 'capital')
            btnWindow?.classList.toggle('is-active', isBuild && currentTool === 'window')
            btnBalcony?.classList.toggle('is-active', isBuild && currentTool === 'balcony')
            btnEntryDoor?.classList.toggle('is-active', isBuild && currentTool === 'entry-door')
            btnRiserH?.classList.toggle('is-active', isBuild && currentTool === 'riser-h')
            btnRiserV?.classList.toggle('is-active', isBuild && currentTool === 'riser-v')

            if (!isBuild) {
                hint.textContent = 'Редактирование: клик по capital для выбора. Тяни за тело — move, за конец — resize.'
                return
            }

            if (!currentTool) {
                hint.textContent = 'Строительство: выбери инструмент.'
                return
            }

            switch (currentTool) {
                case 'capital':
                    hint.textContent = 'Строительство: клик A, клик B. Капиталка рисуется строго по X/Y.'
                    break
                case 'window':
                    hint.textContent = 'Строительство: клик по капитальной стене, чтобы поставить окно.'
                    break
                case 'balcony':
                    hint.textContent = 'Строительство: клик по капитальной стене, чтобы поставить балкон.'
                    break
                case 'entry-door':
                    hint.textContent = 'Строительство: клик по капитальной стене, чтобы поставить входную дверь.'
                    break
                case 'riser-h':
                    hint.textContent = 'Строительство: клик по месту установки стояка H.'
                    break
                case 'riser-v':
                    hint.textContent = 'Строительство: клик по месту установки стояка V.'
                    break
                default:
                    hint.textContent = ''
            }
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

            const toolLabel = currentTool ?? '—'
            const modeLabel = editorMode === 'build' ? 'build' : 'edit'

            status.textContent =
                `Mode: ${modeLabel} | Tool: ${toolLabel} | capital: ${caps} | windows: ${wins} | doors: ${doors} | risers: ${risers}`
        }

        function cancelCapitalDraft() {
            capitalStart = null
            capitalEdit = null
            state.previewWall = null

            if (editorMode === 'build' && currentTool === 'capital') {
                state.mode = 'draw-wall'
            } else {
                state.mode = 'idle'
            }
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

            exitBuildMode()
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

            exitBuildMode()
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

            exitBuildMode()
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

            capitalEdit = null
            windowEdit = null
            furnitureEdit = null

            state.selectedWallId = null
            state.selectedWindowId = null
            state.selectedFurnitureId = null

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
        window.state = state
    }
}