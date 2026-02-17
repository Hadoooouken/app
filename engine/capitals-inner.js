// engine/capitals-inner.js
import { state } from './state.js'

// сравнение с допуском
const EPS = 1e-9
const samePt = (p, q) =>
  Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS

/**
 * ВАЖНО:
 * Для твоего кейса "строительные размеры" — это внутренний контур помещения.
 * Поэтому inner-face капитальных стен НЕ должен сдвигаться на толщину.
 *
 * ia/ib = a/b (строительные координаты)
 *
 * Если позже понадобится внешняя грань — добавим oa/ob.
 */
export function ensureCapitalInnerFaces() {
  const caps = (state.walls || []).filter(w => w?.kind === 'capital')
  if (!caps.length) return

  // пересчитываем только если:
  // - нет ia/ib
  // - или точки изменились
  let need = false

  for (const w of caps) {
    if (!w.ia || !w.ib) { need = true; break }

    if (!samePt(w.ia, w.a) || !samePt(w.ib, w.b)) {
      // кто-то уже сдвигал inner-face — возвращаем как должно быть
      need = true
      break
    }
  }

  if (!need) return

  for (const w of caps) {
    w.ia = { ...w.a }
    w.ib = { ...w.b }
  }
}
