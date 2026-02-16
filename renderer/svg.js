import { SVG } from 'https://cdn.jsdelivr.net/npm/@svgdotjs/svg.js@3.2.0/+esm'
import { state } from '../engine/state.js'

export function createSVG(container) {
  const draw = SVG().addTo(container).size('100%', '100%')
  draw.attr({ style: 'touch-action:none;' }) // важно для тача
  return draw
}

export function screenToWorld(draw, clientX, clientY) {
  const rect = draw.node.getBoundingClientRect()
  const sx = clientX - rect.left
  const sy = clientY - rect.top
  const { scale, offsetX, offsetY } = state.view
  return {
    x: (sx - offsetX) / scale,
    y: (sy - offsetY) / scale,
  }
}
export function setZoomAtCenter(draw, newScale) {
  const rect = draw.node.getBoundingClientRect()
  const cx = rect.width / 2
  const cy = rect.height / 2
  const { scale, offsetX, offsetY } = state.view
  const wx = (cx - offsetX) / scale
  const wy = (cy - offsetY) / scale
  state.view.scale = newScale
  state.view.offsetX = cx - wx * newScale
  state.view.offsetY = cy - wy * newScale
}

// НОВОЕ: fit на капиталки/стены
// export function fitToWalls(draw, { padding = 80 } = {}) {
//   const rect = draw.node.getBoundingClientRect()
//   const vw = rect.width
//   const vh = rect.height
//   if (!vw || !vh) return

//   const caps = state.walls.filter(w => w.kind === 'capital')
//   const list = caps.length ? caps : state.walls
//   if (!list.length) return

//   let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
//   for (const w of list) {
//     minX = Math.min(minX, w.a.x, w.b.x)
//     minY = Math.min(minY, w.a.y, w.b.y)
//     maxX = Math.max(maxX, w.a.x, w.b.x)
//     maxY = Math.max(maxY, w.a.y, w.b.y)
//   }

//   const worldW = Math.max(1, (maxX - minX))
//   const worldH = Math.max(1, (maxY - minY))

//   const scaleX = (vw - padding * 2) / worldW
//   const scaleY = (vh - padding * 2) / worldH
//   const scale = Math.max(0.2, Math.min(5, Math.min(scaleX, scaleY)))

//   const cx = (minX + maxX) / 2
//   const cy = (minY + maxY) / 2

//   state.view.scale = scale
//   state.view.offsetX = vw / 2 - cx * scale
//   state.view.offsetY = vh / 2 - cy * scale
// }
