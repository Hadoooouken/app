import { state } from '../engine/state.js'
import { render } from '../renderer/render.js'

export function initViewport(draw) {
  const node = draw.node

  state.ui = state.ui || {}
  state.ui.dragged = false
  state.ui.lockPan = false

  let isDown = false
  let isDragging = false
  let start = { x: 0, y: 0 }
  let last = { x: 0, y: 0 }

  const THRESHOLD = 6 // px

  node.addEventListener('pointerdown', (e) => {
    // ❌ в режиме рисования — пан не нужен
    if (state.mode === 'draw-wall') return
    if (state.ui.lockPan) return
    if (e.button !== 0 && e.pointerType === 'mouse') return

    // ✅ если нажали на стену (hit-line) — НЕ панорамируем
    const hitWall = e.target?.closest?.('[data-wall-id]')
    if (hitWall) return

    isDown = true
    isDragging = false
    state.ui.dragged = false

    start.x = last.x = e.clientX
    start.y = last.y = e.clientY
  })

  node.addEventListener('pointermove', (e) => {
    if (!isDown) return
    if (state.ui.lockPan) return

    const dx0 = e.clientX - start.x
    const dy0 = e.clientY - start.y

    if (!isDragging) {
      if (Math.hypot(dx0, dy0) < THRESHOLD) return
      isDragging = true
      state.ui.dragged = true
      node.setPointerCapture?.(e.pointerId)
    }

    const dx = e.clientX - last.x
    const dy = e.clientY - last.y
    last.x = e.clientX
    last.y = e.clientY

    state.view.offsetX += dx
    state.view.offsetY += dy
    render(draw)
  })

  const stop = (e) => {
    isDown = false
    isDragging = false
    node.releasePointerCapture?.(e.pointerId)
  }

  node.addEventListener('pointerup', stop)
  node.addEventListener('pointercancel', stop)
}
