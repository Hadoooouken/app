export function createWall(p1, p2) {
  return { id: crypto.randomUUID(), p1, p2 }
}

export function addWall(state, wall) {
  state.walls.push(wall)
}

// пример структуры стены
export function makeWall(a, b, opts = {}) {
  return {
    id: crypto.randomUUID(),
    a, // {x,y}
    b, // {x,y}
    kind: opts.kind ?? 'partition',   // 'capital' | 'partition'
    locked: opts.locked ?? false,     // true для капитальных
  }
}
