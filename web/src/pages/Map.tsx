// Map: every project, workstream, topic, session, idea, task, shared file and claude.ai chat as one graph
// (GET /api/graph, docs/API-GRAPH.md). Period and project live in the URL ("See on the map" links to ?project=).
// Click a node for its panel; search highlights and centres; "Focus" keeps a node and its neighbours.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Maximize, Minus, Network, Plus, Search, TriangleAlert, X } from 'lucide-react';
import { useProjects } from '../api';
import { useGraph } from '../api-extra';
import { useApp } from '../components/AppContext';
import { Button, Card, EmptyState, IconButton, LoadingCard, PageHeader, SegmentedControl, Toolbar } from '../components/ui';
import { MapCanvas, type MapCanvasHandle } from '../components/map/MapCanvas';
import { MapPanel, TypeMark } from '../components/map/MapPanel';
import { layoutGraph, type XY } from '../components/map/layout';
import { PERIODS, TYPE_LABEL, TYPE_ORDER, adjacency, leftOut, searchNodes, type Adjacency, type Period } from '../components/map/model';
import { useIsPhone } from '../components/project/lib';
import { plural } from '../util';
import type { GraphNodeType } from '../types-map';
import './Map.css';

const PAN_STEP = 80;

export default function MapPage() {
  const [params, setParams] = useSearchParams();
  const phone = useIsPhone();
  const { openNewSession } = useApp();
  const days = (PERIODS.some((p) => p.value === params.get('days')) ? params.get('days') : '90') as Period;
  const project = /^[a-f0-9]{10}$/.test(params.get('project') || '') ? params.get('project')! : '';
  const setParam = (k: string, v: string, dflt = '') =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (!v || v === dflt) n.delete(k);
        else n.set(k, v);
        return n;
      },
      { replace: true },
    );
  const { data, error, isLoading, refetch } = useGraph(days, project || undefined);
  const { data: projects } = useProjects();

  // Layout once per graph, warm-started from the last positions so a live refresh doesn't reshuffle the map.
  const last = useRef(new Map<string, XY>());
  const [pos, setPos] = useState<Map<string, XY> | null>(null);
  useEffect(() => {
    if (!data) return;
    const t = window.setTimeout(() => {
      const p = layoutGraph(data.nodes, data.links, last.current);
      last.current = p;
      setPos(p);
    }, 0);
    return () => window.clearTimeout(t);
  }, [data]);

  const [hidden, setHidden] = useState<Set<GraphNodeType>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [grab, setGrab] = useState(false);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [hit, setHit] = useState(-1);
  const canvas = useRef<MapCanvasHandle>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setDq(q.trim()), 200);
    return () => window.clearTimeout(t);
  }, [q]);

  const adj: Adjacency = useMemo(() => (data ? adjacency(data) : new Map()), [data]);
  const byId = useMemo(() => new Map((data?.nodes || []).map((n) => [n.id, n])), [data]);
  const counts = useMemo(() => {
    const c = new Map<GraphNodeType, number>();
    for (const n of data?.nodes || []) c.set(n.type, (c.get(n.type) || 0) + 1);
    return c;
  }, [data]);
  // A selection or focus whose node left the graph (new period, filter, refresh) goes away.
  useEffect(() => {
    if (selected && !byId.has(selected)) setSelected(null);
    if (focus && !byId.has(focus)) setFocus(null);
  }, [byId]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    let nodes = (data?.nodes || []).filter((n) => !hidden.has(n.type));
    if (focus) {
      const keep = new Set([focus, ...(adj.get(focus) || []).map((x) => x.node.id)]);
      nodes = nodes.filter((n) => keep.has(n.id));
    }
    const ids = new Set(nodes.map((n) => n.id));
    const links = (data?.links || []).filter((l) => ids.has(l.source) && ids.has(l.target));
    return { nodes, links, ids };
  }, [data, hidden, focus, adj]);

  const matchList = useMemo(() => (dq.length >= 2 ? searchNodes(visible.nodes, dq) : []), [visible.nodes, dq]);
  const matches = useMemo(() => (dq.length >= 2 ? new Set(matchList.map((n) => n.id)) : null), [matchList, dq]);
  const hi = useMemo(() => {
    if (!selected || !visible.ids.has(selected)) return null;
    return new Set([selected, ...(adj.get(selected) || []).map((x) => x.node.id).filter((id) => visible.ids.has(id))]);
  }, [selected, adj, visible.ids]);

  // Typing centres the best hit; Enter walks through the hits and opens each one.
  useEffect(() => {
    setHit(-1);
    if (matchList[0] && pos) canvas.current?.centerOn(matchList[0].id);
  }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const select = useCallback((id: string | null, opts: { center?: boolean; grab?: boolean } = {}) => {
    setSelected(id);
    setGrab(!!opts.grab);
    if (id && opts.center) canvas.current?.centerOn(id, true);
  }, []);
  const nextHit = () => {
    if (!matchList.length) return;
    const i = (hit + 1) % matchList.length;
    setHit(i);
    select(matchList[i].id, { center: true });
  };
  const closePanel = useCallback(() => {
    setSelected(null);
    stageRef.current?.focus({ preventScroll: true });
  }, []);
  const toggleType = (t: GraphNodeType) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  const toggleFocus = () => {
    if (!selected) return;
    setFocus((f) => (f === selected ? null : selected));
  };

  const onStageKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const c = canvas.current;
    if (!c) return;
    const pan: Record<string, [number, number]> = { ArrowLeft: [PAN_STEP, 0], ArrowRight: [-PAN_STEP, 0], ArrowUp: [0, PAN_STEP], ArrowDown: [0, -PAN_STEP] };
    if (pan[e.key]) c.panBy(...pan[e.key]);
    else if (e.key === '+' || e.key === '=') c.zoomBy(1.25);
    else if (e.key === '-' || e.key === '_') c.zoomBy(0.8);
    else if (e.key === '0') c.fit();
    else if (e.key === 'Enter' || e.key === ' ') {
      const id = c.centerNode();
      if (id) select(id, { center: true, grab: true });
    } else return;
    e.preventDefault();
  };

  const projectOptions = useMemo(() => (projects || []).filter((p) => p.sessionCount > 0 || p.id === project).sort((a, b) => a.name.localeCompare(b.name)), [projects, project]);
  const node = selected ? byId.get(selected) || null : null;
  const hasProjects = (counts.get('project') || 0) > 0;

  const period = <SegmentedControl value={days} onChange={(v) => setParam('days', v, '90')} options={PERIODS.map((p) => ({ value: p.value, label: p.label, title: p.title }))} size="sm" label="Period" />;
  return (
    <>
      <PageHeader title="Map" actions={phone ? undefined : period} />
      <Toolbar className="mp-toolbar">
        <div className="input-wrap mp-search">
          <Search />
          <input
            className="input"
            type="search"
            placeholder="Find on the map…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                nextHit();
              } else if (e.key === 'Escape' && q) {
                e.preventDefault();
                setQ('');
              }
            }}
            aria-label="Find on the map"
            aria-describedby="mp-search-hint"
          />
          {dq.length >= 2 && (
            <span id="mp-search-hint" className="mp-hits num" aria-live="polite">
              {matchList.length ? `${hit >= 0 ? `${hit + 1}/` : ''}${matchList.length}` : 'none'}
            </span>
          )}
        </div>
        <select className="select mp-select" value={project} onChange={(e) => setParam('project', e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {projectOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {phone && period}
      </Toolbar>
      {data && data.nodes.length > 0 && (
        <div className="mp-chips" role="group" aria-label="Show on the map">
          {TYPE_ORDER.filter((t) => counts.get(t)).map((t) => (
            <button key={t} type="button" className={`mp-chip${hidden.has(t) ? ' off' : ''}`} aria-pressed={!hidden.has(t)} onClick={() => toggleType(t)} title={hidden.has(t) ? `Show ${TYPE_LABEL[t].many.toLowerCase()}` : `Hide ${TYPE_LABEL[t].many.toLowerCase()}`}>
              <TypeMark type={t} />
              {TYPE_LABEL[t].many}
              <span className="num faint">{counts.get(t)}</span>
            </button>
          ))}
        </div>
      )}

      {isLoading || (data && !pos && data.nodes.length > 0) ? (
        <LoadingCard lines={8} />
      ) : error ? (
        <Card>
          <EmptyState icon={<TriangleAlert />} title="Couldn’t load the map" body={(error as Error).message} action={<Button size="sm" onClick={() => refetch()}>Try again</Button>} />
        </Card>
      ) : !data || !hasProjects ? (
        <Card>
          <EmptyState
            icon={<Network />}
            title={days !== '0' && !project ? 'Nothing on the map for this period' : 'Your map is empty for now'}
            body="Projects, sessions, workstreams and ideas show up here, linked to each other, once Pilotage has read some of your work."
            action={
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                {days !== '0' ? (
                  <Button size="sm" onClick={() => setParam('days', '0', '90')}>
                    Show all time
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => openNewSession({})}>
                    New session
                  </Button>
                )}
                <Link className="btn sm ghost" to="/guide">
                  How Pilotage works
                </Link>
              </div>
            }
          />
        </Card>
      ) : (
        <div className={`mp-stage${node ? ' has-panel' : ''}`}>
          <div ref={stageRef} className="mp-canvas" tabIndex={0} onKeyDown={onStageKey} aria-describedby="mp-keys">
            {visible.nodes.length ? (
              <MapCanvas
                ref={canvas}
                nodes={visible.nodes}
                links={visible.links}
                pos={pos!}
                selected={selected}
                hi={hi}
                matches={matches}
                onSelect={(id) => select(id, { grab: false })}
                label={`Map of ${plural(counts.get('project') || 0, 'project')} and ${plural(visible.nodes.length, 'item')}`}
                fitKey={`${days}|${project}|${[...hidden].sort().join(',')}|${focus || ''}`}
              />
            ) : (
              <EmptyState compact title="Nothing to show" body="Every type is hidden." action={<Button size="sm" onClick={() => setHidden(new Set())}>Show everything</Button>} />
            )}
            <span id="mp-keys" className="mp-sr">
              Arrow keys move the map, plus and minus zoom, 0 fits it, Enter opens the item in the middle. The search box finds an item by name.
            </span>
            <div className="mp-zoom">
              <IconButton icon={<Plus />} label="Zoom in" variant="secondary" onClick={() => canvas.current?.zoomBy(1.3)} />
              <IconButton icon={<Minus />} label="Zoom out" variant="secondary" onClick={() => canvas.current?.zoomBy(1 / 1.3)} />
              <IconButton icon={<Maximize />} label="Fit the map" variant="secondary" onClick={() => canvas.current?.fit()} />
            </div>
            {focus && byId.get(focus) && (
              <div className="mp-focusbar">
                <span className="truncate">Focus: {byId.get(focus)!.label}</span>
                <IconButton icon={<X />} label="Show everything" onClick={() => setFocus(null)} />
              </div>
            )}
          </div>
          {node && (
            <MapPanel
              node={node}
              links={(adj.get(node.id) || []).filter((x) => visible.ids.has(x.node.id))}
              focused={focus === node.id}
              onFocus={toggleFocus}
              onSelect={(id) => select(id, { center: true, grab: true })}
              onClose={closePanel}
              onProject={(id) => {
                setFocus(null);
                setParam('project', id);
              }}
              grabFocus={grab}
            />
          )}
        </div>
      )}
      {data?.truncated && (
        <p className="hint mp-note">
          Showing {data.truncated.shown} of {data.truncated.total}. Left out: {leftOut(data.truncated.left)}. Pick a project or a shorter period to see more.
        </p>
      )}
    </>
  );
}
