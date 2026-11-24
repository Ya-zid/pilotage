// The Map's drawing: SVG, pan (drag), zoom (wheel, pinch, + / − / fit), click to select. Pan and zoom write the
// transform straight to the DOM during a gesture (no React render per frame); the zoom level is committed when the
// gesture ends, which is when label visibility is recomputed.
import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { GraphLink, GraphNode } from '../../types-map';
import { bounds, placeLabels, radius, type XY } from './layout';

type View = { tx: number; ty: number; k: number };
export type MapCanvasHandle = { centerOn: (id: string, zoomIn?: boolean) => void; fit: (ids?: Iterable<string>) => void; zoomBy: (f: number) => void; panBy: (dx: number, dy: number) => void; centerNode: () => string | null };

const K_MIN = 0.15;
const K_MAX = 4;
const LABEL_MAX = 70;
const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clampK = (k: number) => Math.max(K_MIN, Math.min(K_MAX, k));

function Shape({ n, r }: { n: GraphNode; r: number }) {
  if (n.type === 'idea') return <polygon points={`0,${-r * 1.25} ${r * 1.25},0 0,${r * 1.25} ${-r * 1.25},0`} />;
  if (n.type === 'task' || n.type === 'file') {
    const s = n.type === 'file' ? r * 1.6 : r * 1.8;
    return <rect x={-s / 2} y={-s / 2} width={s} height={s} rx={n.type === 'task' ? s * 0.28 : 1} />;
  }
  return <circle r={r} />;
}

const Edges = memo(function Edges({ links, pos, hi }: { links: GraphLink[]; pos: Map<string, XY>; hi: Set<string> | null }) {
  return (
    <g className="mp-edges">
      {links.map((l) => {
        const a = pos.get(l.source);
        const b = pos.get(l.target);
        if (!a || !b) return null;
        const on = hi && hi.has(l.source) && hi.has(l.target);
        return <line key={`${l.source}>${l.target}>${l.kind}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`mp-edge k-${l.kind}${on ? ' on' : hi ? ' dim' : ''}`} />;
      })}
    </g>
  );
});

const Nodes = memo(function Nodes({ nodes, pos, selected, hi, matches }: { nodes: GraphNode[]; pos: Map<string, XY>; selected: string | null; hi: Set<string> | null; matches: Set<string> | null }) {
  return (
    <g className="mp-nodes">
      {nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const r = radius(n);
        const dim = (hi && !hi.has(n.id)) || (matches && !matches.has(n.id) && !(hi && hi.has(n.id)));
        const cls = `mp-node t-${n.type}${n.id === selected ? ' sel' : ''}${matches?.has(n.id) ? ' match' : ''}${dim ? ' dim' : ''}${n.live ? ' live' : ''}`;
        return (
          <g key={n.id} className={cls} transform={`translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`} data-id={n.id}>
            {n.live && <circle className="mp-live" r={r + 3.5} />}
            <Shape n={n} r={r} />
          </g>
        );
      })}
    </g>
  );
});

function Labels({ nodes, pos, k, show }: { nodes: GraphNode[]; pos: Map<string, XY>; k: number; show: Set<string> }) {
  const fs = 12 / k;
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const items = [];
  for (const id of show) {
    const n = byId.get(id);
    const p = n && pos.get(id);
    if (n && p) items.push({ id, x: p.x, y: p.y, r: radius(n), label: n.label });
  }
  return (
    <g className="mp-labels" aria-hidden="true">
      {placeLabels(items, fs).map((l) => (
        <text key={l.id} x={l.x} y={l.y} fontSize={fs} strokeWidth={3 / k} className={`mp-label t-${byId.get(l.id)!.type}`}>
          {l.text}
        </text>
      ))}
    </g>
  );
}

export const MapCanvas = forwardRef<
  MapCanvasHandle,
  {
    nodes: GraphNode[];
    links: GraphLink[];
    pos: Map<string, XY>;
    selected: string | null;
    hi: Set<string> | null; // the selected node and its neighbours
    matches: Set<string> | null; // search hits
    onSelect: (id: string | null) => void;
    label: string;
    fitKey: string; // what's being looked at (period, project, filters, focus): a new value fits the map once
  }
>(function MapCanvas({ nodes, links, pos, selected, hi, matches, onSelect, label, fitKey }, ref) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const view = useRef<View>({ tx: 0, ty: 0, k: 1 });
  const [k, setK] = useState(1);
  const [hover, setHover] = useState<string | null>(null);
  const anim = useRef<number | null>(null);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const apply = useCallback((commit = false) => {
    const v = view.current;
    gRef.current?.setAttribute('transform', `translate(${v.tx.toFixed(2)},${v.ty.toFixed(2)}) scale(${v.k.toFixed(4)})`);
    if (commit) setK(v.k);
  }, []);
  const size = () => {
    const el = svgRef.current;
    return el ? { w: el.clientWidth || 800, h: el.clientHeight || 600 } : { w: 800, h: 600 };
  };
  const animateTo = useCallback(
    (to: View) => {
      if (anim.current) cancelAnimationFrame(anim.current);
      if (reduced()) {
        view.current = to;
        apply(true);
        return;
      }
      const from = { ...view.current };
      const t0 = performance.now();
      const step = (t: number) => {
        const u = Math.min(1, (t - t0) / 260);
        const e = 1 - Math.pow(1 - u, 3);
        view.current = { tx: from.tx + (to.tx - from.tx) * e, ty: from.ty + (to.ty - from.ty) * e, k: from.k + (to.k - from.k) * e };
        apply(u === 1);
        anim.current = u < 1 ? requestAnimationFrame(step) : null;
      };
      anim.current = requestAnimationFrame(step);
    },
    [apply],
  );
  const fitTo = useCallback(
    (ids: Iterable<string>, animate = true) => {
      const b = bounds(ids, pos, (id) => (byId.has(id) ? radius(byId.get(id)!) + 14 : 0));
      if (!b) return;
      const { w, h } = size();
      const pad = 28;
      const kk = clampK(Math.min((w - pad * 2) / Math.max(1, b.x1 - b.x0), (h - pad * 2) / Math.max(1, b.y1 - b.y0), 1.6));
      const to = { k: kk, tx: w / 2 - ((b.x0 + b.x1) / 2) * kk, ty: h / 2 - ((b.y0 + b.y1) / 2) * kk };
      if (animate) animateTo(to);
      else {
        view.current = to;
        apply(true);
      }
    },
    [pos, byId, animateTo, apply],
  );
  const zoomAt = useCallback(
    (f: number, cx: number, cy: number, commit: boolean) => {
      const v = view.current;
      const nk = clampK(v.k * f);
      const wx = (cx - v.tx) / v.k;
      const wy = (cy - v.ty) / v.k;
      view.current = { k: nk, tx: cx - wx * nk, ty: cy - wy * nk };
      apply(commit);
    },
    [apply],
  );

  useImperativeHandle(
    ref,
    () => ({
      centerOn: (id, zoomIn = false) => {
        const p = pos.get(id);
        if (!p) return;
        const { w, h } = size();
        const kk = zoomIn ? Math.max(view.current.k, 1.2) : view.current.k;
        animateTo({ k: kk, tx: w / 2 - p.x * kk, ty: h / 2 - p.y * kk });
      },
      fit: (ids) => fitTo(ids || nodes.map((n) => n.id)),
      zoomBy: (f) => {
        const { w, h } = size();
        zoomAt(f, w / 2, h / 2, true);
      },
      panBy: (dx, dy) => {
        const v = view.current;
        view.current = { ...v, tx: v.tx + dx, ty: v.ty + dy };
        apply(false);
      },
      centerNode: () => {
        const { w, h } = size();
        const v = view.current;
        const cx = (w / 2 - v.tx) / v.k;
        const cy = (h / 2 - v.ty) / v.k;
        let best: string | null = null;
        let bd = Infinity;
        for (const n of nodes) {
          const p = pos.get(n.id);
          if (!p) continue;
          const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
          if (d < bd) [bd, best] = [d, n.id];
        }
        return best;
      },
    }),
    [pos, nodes, animateTo, fitTo, zoomAt, apply],
  );

  // Fit the map when what's being looked at changes (period, project, filters, focus), and once more when the layout
  // of a new graph lands; a live refresh (a new session) keeps the view where it is.
  const fitted = useRef<{ key: string; complete: boolean } | null>(null);
  useEffect(() => {
    const complete = nodes.every((n) => pos.has(n.id));
    const f = fitted.current;
    if (f && f.key === fitKey && (f.complete || !complete)) return;
    fitted.current = { key: fitKey, complete };
    fitTo(
      nodes.map((n) => n.id),
      false,
    );
  }, [fitKey, pos, nodes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wheel zoom needs a non-passive listener (preventDefault keeps the page from scrolling).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX - rect.left, e.clientY - rect.top, false);
      if (t) clearTimeout(t);
      t = setTimeout(() => setK(view.current.k), 120);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (t) clearTimeout(t);
    };
  }, [zoomAt]);

  // Pointer gestures: one pointer pans (a click when it barely moved), two pinch-zoom around their midpoint.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; start: View; x: number; y: number; dist: number; mx: number; my: number; down: string | null } | null>(null);
  const local = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const startGesture = (down: string | null) => {
    const pts = [...pointers.current.values()];
    const [a, b] = pts;
    gesture.current = {
      moved: gesture.current?.moved || pts.length > 1,
      start: { ...view.current },
      x: a.x,
      y: a.y,
      dist: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0,
      mx: b ? (a.x + b.x) / 2 : a.x,
      my: b ? (a.y + b.y) / 2 : a.y,
      down,
    };
  };
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (anim.current) cancelAnimationFrame(anim.current);
    svgRef.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    const id = (e.target as Element).closest?.('[data-id]')?.getAttribute('data-id') || null;
    startGesture(pointers.current.size === 1 ? id : null);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!pointers.current.has(e.pointerId) || !g) {
      if (e.pointerType === 'mouse') {
        const id = (e.target as Element).closest?.('[data-id]')?.getAttribute('data-id') || null;
        if (id !== hover) setHover(id);
      }
      return;
    }
    pointers.current.set(e.pointerId, local(e));
    const pts = [...pointers.current.values()];
    if (pts.length >= 2 && g.dist) {
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const nk = clampK(g.start.k * (dist / g.dist));
      const wx = (g.mx - g.start.tx) / g.start.k;
      const wy = (g.my - g.start.ty) / g.start.k;
      view.current = { k: nk, tx: mx - wx * nk, ty: my - wy * nk };
      g.moved = true;
      apply(false);
    } else {
      const p = pts[0];
      const dx = p.x - g.x;
      const dy = p.y - g.y;
      if (!g.moved && Math.hypot(dx, dy) < 4) return;
      g.moved = true;
      view.current = { ...g.start, tx: g.start.tx + dx, ty: g.start.ty + dy };
      apply(false);
    }
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size) {
      startGesture(null); // one finger left after a pinch: keep panning from here
      return;
    }
    gesture.current = null;
    if (!g) return;
    if (g.moved) setK(view.current.k);
    else if (e.type === 'pointerup') onSelect(g.down);
  };

  // Labels: selected, hovered, its neighbours, search hits, then whatever is big enough on screen.
  const show = useMemo(() => {
    const s = new Set<string>();
    const push = (id: string | null | undefined) => {
      if (id && s.size < LABEL_MAX && byId.has(id)) s.add(id);
    };
    push(selected);
    push(hover);
    if (hi) for (const id of hi) push(id);
    if (matches) for (const id of [...matches].slice(0, 30)) push(id);
    // Workspaces and projects are the landmarks: always named while there are few of them (a phone fits the whole
    // map at a small zoom, which left it without a single label), else from a reasonable zoom on.
    const landmarks = nodes.filter((n) => n.type === 'workspace' || n.type === 'project').length;
    const big = nodes.filter((n) => radius(n) * k >= 10 || ((n.type === 'workspace' || n.type === 'project') && (k >= 0.55 || landmarks <= 24))).sort((a, b) => radius(b) - radius(a));
    for (const n of big) if (!(hi && !hi.has(n.id)) && !(matches && !matches.has(n.id))) push(n.id);
    return s;
  }, [nodes, byId, selected, hover, hi, matches, k]);

  return (
    <svg
      ref={svgRef}
      className="mp-svg"
      role="img"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={(e) => e.pointerType === 'mouse' && !pointers.current.size && setHover(null)}
    >
      <g ref={gRef}>
        <Edges links={links} pos={pos} hi={hi} />
        <Nodes nodes={nodes} pos={pos} selected={selected} hi={hi} matches={matches} />
        <Labels nodes={nodes} pos={pos} k={k} show={show} />
      </g>
    </svg>
  );
});
