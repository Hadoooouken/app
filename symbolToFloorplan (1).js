/**
 * symbolToFloorplan.js
 *
 * Converts an SVG <symbol> with colored <line> elements into
 * a floorplan JSON template.
 *
 * Color conventions:
 *   black  -> capital wall
 *   red    -> window (std)
 *   blue   -> window (balcony)
 *   green  -> door (entry)
 *
 * Usage (Node.js):
 *   node symbolToFloorplan.js input.svg > output.json
 *   node symbolToFloorplan.js input.svg output.json
 *
 * Usage (browser / import):
 *   import { symbolToFloorplan } from './symbolToFloorplan.js';
 *   const json = symbolToFloorplan(svgString);
 */

// UUID

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// Parse <line> elements from SVG string

function parseLines(svgString) {
  const lineRe = /<line([^>]*)\/?\s*>/gi;
  const attrRe = /(\w[\w-]*)\s*=\s*["']([^"']*)["']/g;

  const lines = [];
  let m;
  while ((m = lineRe.exec(svgString)) !== null) {
    const attrs = {};
    let a;
    while ((a = attrRe.exec(m[1])) !== null) {
      attrs[a[1]] = a[2];
    }
    attrRe.lastIndex = 0;

    const stroke = (attrs.stroke || '').toLowerCase().trim();
    const x1 = parseFloat(attrs.x1);
    const y1 = parseFloat(attrs.y1);
    const x2 = parseFloat(attrs.x2);
    const y2 = parseFloat(attrs.y2);

    if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) continue;

    lines.push({ stroke, x1, y1, x2, y2 });
  }
  return lines;
}

// Cluster close coordinate values into a single canonical value.
//
// Collects all values, sorts them, groups any that are within `tol` of
// each other, then replaces every value in the group with the group mean.
// This absorbs stroke-width snapping noise (e.g. 26 vs 26.5) before any
// other processing so walls end up on exactly the same axis coordinates.

function clusterValues(values, tol) {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && v - last[last.length - 1] <= tol) {
      last.push(v);
    } else {
      clusters.push([v]);
    }
  }
  const map = new Map();
  for (const cluster of clusters) {
    const mean = round(cluster.reduce((s, v) => s + v, 0) / cluster.length);
    for (const v of cluster) map.set(v, mean);
  }
  return map;
}

// Apply coordinate clusters to a set of lines, returning cleaned copies.

function applyCluster(lines, tol) {
  const rawX = lines.flatMap(l => [l.x1, l.x2]);
  const rawY = lines.flatMap(l => [l.y1, l.y2]);
  const cxMap = clusterValues(rawX, tol);
  const cyMap = clusterValues(rawY, tol);
  return lines.map(l => ({
    ...l,
    x1: cxMap.get(l.x1) ?? l.x1,
    y1: cyMap.get(l.y1) ?? l.y1,
    x2: cxMap.get(l.x2) ?? l.x2,
    y2: cyMap.get(l.y2) ?? l.y2,
  }));
}

function round(v, decimals = 3) {
  return Math.round(v * 10 ** decimals) / 10 ** decimals;
}

// Snap value to nearest reference within tolerance (second-pass safety net).

function snap(v, refs, tol) {
  let best = null, bestD = Infinity;
  for (const r of refs) {
    const d = Math.abs(v - r);
    if (d < bestD) { bestD = d; best = r; }
  }
  return bestD <= tol ? best : v;
}

function snapPoint(pt, refX, refY, tol) {
  return { x: snap(pt.x, refX, tol), y: snap(pt.y, refY, tol) };
}

// Calibrate SVG -> world coordinate transform.
//
// World origin = SVG centroid, scale = 1 px/cm.
// Y is NOT flipped: host application uses screen-space Y (grows downward).

function buildTransform(wallLines) {
  const allX = wallLines.flatMap(l => [l.x1, l.x2]);
  const allY = wallLines.flatMap(l => [l.y1, l.y2]);

  const svgXmin = Math.min(...allX);
  const svgXmax = Math.max(...allX);
  const svgYmin = Math.min(...allY);
  const svgYmax = Math.max(...allY);

  const svgW = svgXmax - svgXmin;
  const svgH = svgYmax - svgYmin;

  return {
    toWorld(sx, sy) {
      return {
        x: round(sx - (svgXmin + svgW / 2)),
        y: round(sy - (svgYmin + svgH / 2)),
      };
    },
    svgXmin, svgXmax, svgYmin, svgYmax,
  };
}

// Build wall segments from cleaned lines.

function buildWalls(lines, xform, snapTol) {
  // Step 1: cluster raw SVG coords to merge wobbled duplicates (26 vs 26.5).
  const cleaned = applyCluster(lines, snapTol);

  const walls = [];
  for (const l of cleaned) {
    const a = xform.toWorld(l.x1, l.y1);
    const b = xform.toWorld(l.x2, l.y2);
    walls.push({ id: uuid(), kind: 'capital', a, b, locked: true });
  }

  // Step 2: snap world-space endpoints to shared references to catch any
  // residual differences that survived clustering.
  const refX = [...new Set(walls.flatMap(w => [w.a.x, w.b.x]))];
  const refY = [...new Set(walls.flatMap(w => [w.a.y, w.b.y]))];
  for (const w of walls) {
    w.a = snapPoint(w.a, refX, refY, snapTol);
    w.b = snapPoint(w.b, refX, refY, snapTol);
  }

  return walls;
}

// Compute t (normalised position along a wall, 0 at A, 1 at B).
// Uses the centre of the opening line segment.

function computeT(wall, px, py) {
  const { a, b } = wall;
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.abs(dx) >= Math.abs(dy)
    ? (px - a.x) / (dx || 1)
    : (py - a.y) / (dy || 1);
  return round(Math.max(0, Math.min(1, t)), 6);
}

// Find the wall that a coloured line lies on.

function findWall(cx, cy, walls, tol) {
  for (const w of walls) {
    const isWH = Math.abs(w.a.y - w.b.y) < tol;
    const isWV = Math.abs(w.a.x - w.b.x) < tol;

    if (isWH) {
      if (Math.abs(cy - w.a.y) > tol) continue;
      const wXmin = Math.min(w.a.x, w.b.x), wXmax = Math.max(w.a.x, w.b.x);
      if (cx < wXmin - tol || cx > wXmax + tol) continue;
      return w;
    }
    if (isWV) {
      if (Math.abs(cx - w.a.x) > tol) continue;
      const wYmin = Math.min(w.a.y, w.b.y), wYmax = Math.max(w.a.y, w.b.y);
      if (cy < wYmin - tol || cy > wYmax + tol) continue;
      return w;
    }
  }
  return null;
}

// Build windows and doors from coloured lines.

function buildOpenings(lines, walls, xform, snapTol) {
  // Apply the same coordinate clustering to opening lines so their coords
  // align with the already-cleaned wall coords.
  const allLines = [...walls.map(w => ({
    stroke: 'black',
    x1: w.a.x, y1: w.a.y, x2: w.b.x, y2: w.b.y,
  })), ...lines];
  const clustered = applyCluster(allLines, snapTol);
  const cleanedOpenings = clustered.slice(walls.length);  // drop wall entries

  const windows = [];
  const doors = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const cl = cleanedOpenings[i];

    const a = xform.toWorld(cl.x1, cl.y1);
    const b = xform.toWorld(cl.x2, cl.y2);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const w = round(Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2), 2);

    const wall = findWall(cx, cy, walls, snapTol * 2);
    if (!wall) {
      console.warn(`[symbolToFloorplan] No wall found for ${l.stroke} line at (${cx}, ${cy})`);
      continue;
    }

    const t = computeT(wall, cx, cy);

    if (l.stroke === 'green') {
      doors.push({ id: uuid(), kind: 'entry', wallId: wall.id, t, w, locked: true });
    } else {
      const kind = l.stroke === 'blue' ? 'balcony' : 'std';
      windows.push({ id: uuid(), kind, wallId: wall.id, t, w });
    }
  }

  return { windows, doors };
}


// Build furniture (risers/standpipes) from white lines.
//
// horizontal white line -> typeId = 'stoyak',          symbolId = 'mebel-stoyak'
// vertical white line   -> typeId = 'stoyak-vertical', symbolId = 'mebel-stoyak-vertical'
//
// w/h are derived from the line length; the perpendicular dimension
// defaults to DEFAULT_RISER_DEPTH cm (matching the original JSON).

function buildFurniture(lines, xform) {
  const DEFAULT_RISER_DEPTH = 28;
  const furniture = [];

  for (const l of lines) {
    const a = xform.toWorld(l.x1, l.y1);
    const b = xform.toWorld(l.x2, l.y2);

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = round(Math.sqrt(dx * dx + dy * dy), 2);
    const isVertical = Math.abs(dy) > Math.abs(dx);

    const cx = round((a.x + b.x) / 2);
    const cy = round((a.y + b.y) / 2);

    if (isVertical) {
      furniture.push({
        id: uuid(),
        typeId: 'stoyak-vertical',
        symbolId: 'mebel-stoyak-vertical',
        w: DEFAULT_RISER_DEPTH,
        h: length,
        x: cx,
        y: cy,
        rot: 0,
        locked: true,
      });
    } else {
      furniture.push({
        id: uuid(),
        typeId: 'stoyak',
        symbolId: 'mebel-stoyak',
        w: length,
        h: DEFAULT_RISER_DEPTH,
        x: cx,
        y: cy,
        rot: 0,
        locked: true,
      });
    }
  }

  return furniture;
}

// Main conversion function.
//
// @param {string} svgString  - raw SVG / symbol markup
// @param {object} [opts]
// @param {string} [opts.unit='cm']
// @param {number} [opts.pxToWorld=1]
// @param {number} [opts.snapTol=3]  - coordinate cluster tolerance in SVG px
// @returns {object}  floorplan JSON object

function symbolToFloorplan(svgString, opts = {}) {
  const { unit = 'cm', pxToWorld = 1, snapTol = 3 } = opts;

  const allLines = parseLines(svgString);
  if (!allLines.length) throw new Error('No <line> elements found in input');

  const wallLines      = allLines.filter(l => l.stroke === 'black');
  const windowLines    = allLines.filter(l => ['red', 'blue'].includes(l.stroke));
  const doorLines      = allLines.filter(l => l.stroke === 'green');
  const furnitureLines = allLines.filter(l => ['white', '#ffffff', '#fff'].includes(l.stroke));

  if (!wallLines.length) throw new Error('No black wall lines found');

  const xform   = buildTransform(wallLines);
  const walls   = buildWalls(wallLines, xform, snapTol);
  const { windows, doors } = buildOpenings(
    [...windowLines, ...doorLines], walls, xform, snapTol
  );
  const furniture = buildFurniture(furnitureLines, xform);

  return {
    version: 1,
    meta: {
      unit,
      pxToWorld,
      createdAt: new Date().toISOString(),
      source: 'svg-symbol-import',
    },
    walls,
    windows,
    doors,
    furniture,
  };
}

// Node.js CLI entry point

if (typeof process !== 'undefined' && process.argv && process.argv[1]
    && process.argv[1].endsWith('symbolToFloorplan.js')) {

  const fs = require('fs');

  const inputFile  = process.argv[2];
  const outputFile = process.argv[3];

  if (!inputFile) {
    console.error('Usage: node symbolToFloorplan.js <input.svg> [output.json]');
    process.exit(1);
  }

  const svgString = fs.readFileSync(inputFile, 'utf8');
  let result;
  try {
    result = symbolToFloorplan(svgString);
  } catch (e) {
    console.error('Conversion error:', e.message);
    process.exit(1);
  }

  const json = JSON.stringify(result, null, 2);

  if (outputFile) {
    fs.writeFileSync(outputFile, json, 'utf8');
    console.error(`Written to ${outputFile}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

// Export

if (typeof module !== 'undefined') module.exports = { symbolToFloorplan };
export { symbolToFloorplan };
