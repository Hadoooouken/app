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

