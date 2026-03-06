import { state } from '../engine/state.js'
import { render } from '../renderer/render.js'

function isMobileUI() {
  try {
    return matchMedia('(pointer: coarse)').matches || window.innerWidth <= 768
  } catch {
    return window.innerWidth <= 768
  }
}

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
    if (
      state.mode === 'draw-wall' ||
      state.mode === 'draw-door' ||
      state.mode === 'draw-furniture'
    ) return

    if (state.ui.lockPan) return
    if (e.button !== 0 && e.pointerType === 'mouse') return

    if (isMobileUI() && state.mobileMode !== 'move') return

    const hitInteractive = e.target?.closest?.(
      '[data-wall-id], [data-door-id], [data-handle], [data-furniture-id], [data-furniture-rotate]'
    )
    if (hitInteractive) return

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
    state.ui.dragged = false            // ✅ критично
    node.releasePointerCapture?.(e.pointerId)
  }

  node.addEventListener('pointerup', stop)
  node.addEventListener('pointercancel', stop)
  node.addEventListener('pointerleave', stop) // ✅ страховка
  window.addEventListener('blur', () => {     // ✅ страховка
    isDown = false
    isDragging = false
    state.ui.dragged = false
  })
}