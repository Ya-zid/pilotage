// A small force layout for the Map (no dependency): many-body repulsion with a soft collision term, springs along the
// links, a weak pull to the centre. Deterministic: a node's first position comes from its id (or the node it hangs
// off), so the same graph always looks the same, and a refetch starts from the previous positions (no jump).
export type XY = { x: number; y: number };
export type LayoutNode = { id: string; type: string; weight: number };
export type LayoutLink = { source: string; target: string; kind: string };

const BASE: Record<string, number> = { workspace: 13, project: 9, thread: 6.5, topic: 6, session: 4.5, idea: 5.5, task: 5, chat: 5, file: 4 };
const MAX: Record<string, number> = { workspace: 26, project: 22, thread: 14, topic: 14, session: 10, idea: 8, task: 7, chat: 10, file: 9 };

/** Node radius in map units, from its type and weight (square root, so one huge project doesn't eat the map). */
export function radius(n: { type: string; weight: number }) {
  const b = BASE[n.type] ?? 4.5;
  return Math.min(MAX[n.type] ?? 10, b + Math.sqrt(Math.max(0, (n.weight || 1) - 1)) * 1.5);
}

/** Rest length of a spring per link kind: workspace → project is long, a session under its workstream short. */
const LINK_LEN: Record<string, number> = { workspace: 110, thread: 48, session: 34, topic: 64, idea: 42, spinoff: 140, task: 36, source: 44, edit: 56, file: 80, chat: 56 };

/** FNV-1a of the id → [0, 1). */
export function seed(id: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

export function layoutGraph(nodes: LayoutNode[], links: LayoutLink[], prev?: Map<string, XY>, opts: { iterations?: number } = {}): Map<string, XY> {
  const n = nodes.length;
  const out = new Map<string, XY>();
  if (!n) return out;
  const idx = new Map(nodes.map((d, i) => [d.id, i]));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const r = Float64Array.from(nodes, radius);
  const deg = new Float64Array(n);
  const ls: { s: number; t: number; len: number }[] = [];
  for (const l of links) {
    const s = idx.get(l.source);
    const t = idx.get(l.target);
    if (s === undefined || t === undefined || s === t) continue;
    ls.push({ s, t, len: (LINK_LEN[l.kind] ?? 50) + r[s] + r[t] });
    deg[s]++;
    deg[t]++;
  }
  const nbr: number[][] = Array.from({ length: n }, () => []);
  for (const l of ls) {
    nbr[l.s].push(l.t);
    nbr[l.t].push(l.s);
  }

  // First positions: the previous layout, else next to an already placed neighbour, else a golden-angle spiral.
  const placed = new Uint8Array(n);
  let known = 0;
  nodes.forEach((d, i) => {
    const p = prev?.get(d.id);
    if (p) {
      x[i] = p.x;
      y[i] = p.y;
      placed[i] = 1;
      known++;
    }
  });
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  nodes.forEach((d, i) => {
    if (placed[i]) return;
    const a = seed(d.id) * Math.PI * 2;
    const anchor = nbr[i].find((j) => placed[j]);
    if (anchor !== undefined) {
      const dist = 30 + r[anchor] + r[i];
      x[i] = x[anchor] + Math.cos(a) * dist;
      y[i] = y[anchor] + Math.sin(a) * dist;
    } else {
      const rad = 28 * Math.sqrt(i + 0.5);
      x[i] = Math.cos(i * GOLDEN) * rad;
      y[i] = Math.sin(i * GOLDEN) * rad;
    }
    placed[i] = 1;
  });

  const warm = prev && known >= n * 0.8;
  const iterations = opts.iterations ?? (warm ? 70 : n > 250 ? 240 : 300);
  let alpha = warm ? 0.1 : 1;
  const alphaMin = 0.002;
  const decay = 1 - Math.pow(alphaMin / alpha, 1 / iterations);
  const DIST_MAX2 = 360 * 360;
  for (let it = 0; it < iterations; it++) {
    // repulsion + collision, O(n²): fine for the 400 nodes the server sends
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = x[j] - x[i];
        let dy = y[j] - y[i];
        let d2 = dx * dx + dy * dy;
        if (d2 > DIST_MAX2) continue;
        if (d2 < 1e-6) {
          dx = (seed(nodes[i].id + nodes[j].id) - 0.5) * 1e-3;
          dy = 1e-3;
          d2 = dx * dx + dy * dy;
        }
        const f = ((14 + (r[i] + r[j]) * 3) * alpha) / d2;
        let fx = dx * f;
        let fy = dy * f;
        const min = r[i] + r[j] + 4;
        if (d2 < min * min) {
          const d = Math.sqrt(d2);
          const push = ((min - d) / d) * 0.5;
          fx += dx * push;
          fy += dy * push;
        }
        vx[i] -= fx;
        vy[i] -= fy;
        vx[j] += fx;
        vy[j] += fy;
      }
    }
    // springs
    for (const l of ls) {
      const dx = x[l.t] + vx[l.t] - x[l.s] - vx[l.s];
      const dy = y[l.t] + vy[l.t] - y[l.s] - vy[l.s];
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const k = ((d - l.len) / d) * alpha * (0.7 / Math.min(deg[l.s], deg[l.t]));
      const bias = deg[l.s] / (deg[l.s] + deg[l.t]);
      vx[l.t] -= dx * k * bias;
      vy[l.t] -= dy * k * bias;
      vx[l.s] += dx * k * (1 - bias);
      vy[l.s] += dy * k * (1 - bias);
    }
    // centre pull (stronger for loose nodes, so islands don't drift off), then integrate with friction
    for (let i = 0; i < n; i++) {
      const g = (deg[i] ? 0.012 : 0.04) * alpha;
      vx[i] -= x[i] * g;
      vy[i] -= y[i] * g;
      vx[i] *= 0.6;
      vy[i] *= 0.6;
      x[i] += vx[i];
      y[i] += vy[i];
    }
    alpha -= alpha * decay;
  }
  nodes.forEach((d, i) => out.set(d.id, { x: x[i], y: y[i] }));
  return out;
}

/** Bounding box of some positions, padded by each node's radius. */
export function bounds(ids: Iterable<string>, pos: Map<string, XY>, rOf: (id: string) => number) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const id of ids) {
    const p = pos.get(id);
    if (!p) continue;
    const rr = rOf(id);
    x0 = Math.min(x0, p.x - rr);
    y0 = Math.min(y0, p.y - rr);
    x1 = Math.max(x1, p.x + rr);
    y1 = Math.max(y1, p.y + rr);
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/** Labels in priority order (the order of `show`: selected, hovered, neighbours, search hits, big nodes). One that
 * would overlap a label already placed is left out, so a zoomed-in cluster stays readable; the first two (selected,
 * hovered) are always drawn. Text width is estimated (no layout pass): ~0.56 em per character. */
export function placeLabels(items: { id: string; x: number; y: number; r: number; label: string }[], fs: number, keep = 2) {
  const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const out: { id: string; x: number; y: number; text: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const text = it.label.length > 42 ? `${it.label.slice(0, 40)}…` : it.label;
    const w = text.length * fs * 0.56 + fs * 0.4;
    const y = it.y + it.r + fs * 1.15;
    const b = { x0: it.x - w / 2, x1: it.x + w / 2, y0: y - fs * 1.05, y1: y + fs * 0.3 };
    if (i >= keep && boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)) continue;
    boxes.push(b);
    out.push({ id: it.id, x: it.x, y, text });
  }
  return out;
}
