// The conversation of a session, newest at the bottom. Opens scrolled to the latest turns, pages backwards with
// "Load earlier messages", keeps its place when older turns are prepended, follows new turns of a live session
// while you are at the bottom, and offers "Jump to latest" when you are not.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlarmClock, Archive, ArrowDown, Bot, ChevronRight, Cog, Eye, EyeOff, MessagesSquare, TriangleAlert, Users } from 'lucide-react';
import { api, useTurnDetail, useTurns } from '../../api';
import { Button, ClampText, EmptyState, Markdown, Meta, Skeleton, Snippet, Spinner, StatusIcon } from '../ui';
import { fmtDate, fmtDateTime, fmtDay, fmtTime, plural } from '../../util';
import type { BlockView, SessionDetail, Turn, TurnItem, TurnsPage } from '../../types';
import { assistantName, dayKey } from './shared';

const PAGE = 40;
const BG = new Set(['n', 'c', 'y']);
const isBg = (t: Turn) => BG.has(t.o);

type Item =
  | { kind: 'day'; key: string; t: number }
  | { kind: 'block'; key: string; b: BlockView }
  | { kind: 'turn'; key: string; t: Turn }
  | { kind: 'group'; key: string; turns: Turn[] };

// ---------- pieces ----------

function bgLabel(t: Turn) {
  if (t.o === 'n') return { icon: <Bot size={13} />, label: 'Background task finished' };
  if (t.o === 'c') return { icon: <AlarmClock size={13} />, label: 'Scheduled check-in' };
  return { icon: <Cog size={13} />, label: 'System' };
}

/** Task notifications carry ids and temp paths; keep only the words. */
function cleanSys(p: string) {
  return p
    .split(/\s+/)
    .filter((w) => w && !w.includes('/') && !/^toolu_/i.test(w) && !/^(?=.*\d)(?=.*[a-z])[a-z0-9_-]{8,}$/i.test(w))
    .join(' ')
    .trim();
}

function SysLine({ t }: { t: Turn }) {
  const { icon, label } = bgLabel(t);
  const text = cleanSys(t.p || '');
  return (
    <div className="bubble-sys sx-sys" title={t.p || undefined}>
      {icon}
      <span className="sx-sys-label">{label}</span>
      {text && <Snippet text={text} className="sx-sys-text" />}
      <span className="sx-time num">{fmtTime(t.t)}</span>
    </div>
  );
}

/** Lazy <details>: the body (and its network request) only exists once opened. Same look as <Disclosure>. */
function LazyDisclosure({ summary, children, className = '' }: { summary: React.ReactNode; children: (open: boolean) => React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={`disclosure ${className}`} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <ChevronRight size={14} className="chev" />
        {summary}
      </summary>
      <div className="disclosure-body">{open ? children(open) : null}</div>
    </details>
  );
}

function ToolRow({ it }: { it: Extract<TurnItem, { kind: 'tool' }> }) {
  const head = (
    <>
      <span className="sx-tool-name">{it.name}</span>
      <span className="sx-tool-sum truncate">{it.summary || '—'}</span>
      {it.error && (
        <span className="sx-tool-err" title="This call failed">
          <TriangleAlert size={12} /> failed
        </span>
      )}
    </>
  );
  if (!it.result) return <div className="sx-tool">{head}</div>;
  return (
    <details className="sx-tool-d">
      <summary className="sx-tool">{head}</summary>
      <pre className="sx-tool-result">{it.result}</pre>
    </details>
  );
}

const TOOLS_SHOWN = 25;

function TurnDetailBody({ sessionId, t }: { sessionId: string; t: Turn }) {
  const { data, isLoading, error } = useTurnDetail(sessionId, t.i, true);
  const [all, setAll] = useState(false);
  if (isLoading)
    return (
      <div className="row small faint sx-pad-y">
        <Spinner size={13} /> Loading the tool calls…
      </div>
    );
  if (error) return <div className="small tone-red sx-pad-y">Couldn’t load this turn: {(error as Error).message}</div>;
  const items = data?.items || [];
  // Drop the prompt (shown above) and the final reply (shown above too).
  let lastText = -1;
  for (let k = items.length - 1; k >= 0; k--)
    if (items[k].kind === 'text') {
      lastText = k;
      break;
    }
  const rest = items.filter((x, k) => !(k === 0 && x.kind === 'prompt') && !(k === lastText && t.a));
  const tools = rest.filter((x) => x.kind === 'tool').length;
  let toolSeen = 0;
  const visible = all ? rest : rest.filter((x) => (x.kind === 'tool' ? ++toolSeen <= TOOLS_SHOWN : toolSeen < TOOLS_SHOWN));
  if (!rest.length) return <div className="small faint sx-pad-y">Nothing else was recorded in this turn.</div>;
  return (
    <div className="sx-detail">
      {visible.map((it, k) =>
        it.kind === 'tool' ? (
          <ToolRow key={k} it={it} />
        ) : it.kind === 'text' ? (
          <div key={k} className="sx-detail-text">
            <ClampText lines={6} fade>
              <Markdown text={it.text} />
            </ClampText>
          </div>
        ) : (
          <div key={k} className="sx-detail-prompt">
            <span className="tiny faint">{it.origin === 'h' || !it.origin ? 'You' : 'Message'}</span>
            <ClampText lines={4} className="pre-wrap break small">
              {it.text}
            </ClampText>
          </div>
        ),
      )}
      {!all && tools > TOOLS_SHOWN && (
        <button type="button" className="more-link" onClick={() => setAll(true)}>
          Show all {tools} tool calls
        </button>
      )}
    </div>
  );
}

function FullReply({ sessionId, t }: { sessionId: string; t: Turn }) {
  const { data, isLoading } = useTurnDetail(sessionId, t.i, true);
  const text = [...(data?.items || [])].reverse().find((x) => x.kind === 'text') as Extract<TurnItem, { kind: 'text' }> | undefined;
  if (isLoading) return <Skeleton h={14} w="40%" />;
  return <Markdown text={text?.text || t.a} />;
}

function Reply({ s, t, bare = false }: { s: SessionDetail; t: Turn; bare?: boolean }) {
  const [full, setFull] = useState(false);
  // The list endpoint clips replies at 1,600 characters; the turn detail has the whole text.
  const clipped = t.hasDetail && t.a.length >= 1590 && t.a.endsWith('…');
  return (
    <div className="sx-reply">
      {!bare && (
        <div className="sx-who">
          <span className="sx-who-name">{assistantName(s)}</span>
          {t.at ? <span className="num">{fmtTime(t.at)}</span> : null}
        </div>
      )}
      {full ? (
        <FullReply sessionId={s.id} t={t} />
      ) : clipped ? (
        <>
          <div className="sx-fade">
            <Markdown text={t.a} />
          </div>
          <button type="button" className="more-link" onClick={() => setFull(true)}>
            Show the full reply
          </button>
        </>
      ) : (
        <ClampText lines={14} fade>
          <Markdown text={t.a} />
        </ClampText>
      )}
    </div>
  );
}

function Tools({ s, t }: { s: SessionDetail; t: Turn }) {
  if (!t.hasDetail || t.n <= 0) return null;
  return (
    <LazyDisclosure className="sx-tools-d" summary={<span>{plural(t.n, 'tool call')}</span>}>
      {() => <TurnDetailBody sessionId={s.id} t={t} />}
    </LazyDisclosure>
  );
}

function Prompt({ t }: { t: Turn }) {
  const who = t.o === 'p' ? 'Another Claude session' : t.o === 's' ? 'Automated prompt' : 'You';
  return (
    <div className={`sx-prompt${t.o === 's' ? ' sdk' : t.o === 'p' ? ' peer' : ''}`}>
      <div className="sx-who">
        {t.o === 'p' ? <Users size={12} /> : t.o === 's' ? <Bot size={12} /> : null}
        <span className="sx-who-name">{who}</span>
        <span className="num" title={fmtDateTime(t.t)}>
          {fmtTime(t.t)}
        </span>
      </div>
      <div className={`bubble-user${t.o === 's' ? ' sdk' : t.o === 'p' ? ' peer' : ''}`}>
        <ClampText lines={10} className="pre-wrap break">
          {t.p}
        </ClampText>
      </div>
    </div>
  );
}

function Compaction({ t }: { t: Turn }) {
  return (
    <div className="sx-compact" data-key={`t${t.i}`}>
      <div className="sx-compact-line">
        <Archive size={13} />
        <span>Context compacted</span>
        <span className="num">{fmtTime(t.t)}</span>
      </div>
      {t.p && (
        <LazyDisclosure className="sx-compact-d" summary={<span>What Claude kept</span>}>
          {() => (
            <ClampText lines={12} className="pre-wrap break small muted">
              {t.p}
            </ClampText>
          )}
        </LazyDisclosure>
      )}
    </div>
  );
}

function TurnView({ s, t, showSys }: { s: SessionDetail; t: Turn; showSys: boolean }) {
  if (t.o === 'x') return <Compaction t={t} />;
  const bg = isBg(t);
  if (bg && !t.a && !showSys) return null;
  return (
    <div className={`sx-turn${bg ? ' bg' : ''}`} data-key={`t${t.i}`}>
      {bg ? <SysLine t={t} /> : <Prompt t={t} />}
      {t.a && <Reply s={s} t={t} bare={bg} />}
      <Tools s={s} t={t} />
    </div>
  );
}

/** A run of background turns (check-ins, finished tasks): shows the latest reply, the rest on demand. */
function BgGroup({ s, turns }: { s: SessionDetail; turns: Turn[] }) {
  const [open, setOpen] = useState(false);
  const last = turns[turns.length - 1];
  const first = turns[0];
  return (
    <div className="sx-group" data-key={`g${last.i}`}>
      <button type="button" className="sx-group-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Bot size={13} />
        <span className="sx-sys-label">{plural(turns.length, 'background update')}</span>
        <span className="sx-time num">
          {fmtTime(first.t)}–{fmtTime(last.t)}
        </span>
        <ChevronRight size={14} className={`sx-chev${open ? ' open' : ''}`} />
      </button>
      {open ? (
        turns.map((t) => <TurnView key={t.i} s={s} t={t} showSys />)
      ) : (
        <div className="sx-turn bg">
          <SysLine t={last} />
          {last.a && <Reply s={s} t={last} bare />}
          <Tools s={s} t={last} />
        </div>
      )}
    </div>
  );
}

function BlockHeader({ b }: { b: BlockView }) {
  const d = b.digest;
  const a = fmtDate(b.startAt);
  const z = fmtDate(b.endAt);
  return (
    <div className="sx-blocksep" role="separator" aria-label={`Work block: ${d?.title || b.fallbackTitle}`}>
      {d ? <StatusIcon status={d.status} /> : <span className="sx-blocksep-dot" />}
      <div className="grow">
        <div className="sx-blocksep-title">{d?.title || b.fallbackTitle}</div>
        <Meta items={[<span title={`${fmtDateTime(b.startAt)} → ${fmtDateTime(b.endAt)}`}>{a === z ? a : `${a} → ${z}`}</span>, b.prompts > 0 ? plural(b.prompts, 'prompt') : null]} />
      </div>
    </div>
  );
}

function DayDivider({ t }: { t: number }) {
  return (
    <div className="sx-day" role="separator">
      <span title={fmtDate(t)}>{fmtDay(t)}</span>
    </div>
  );
}

// ---------- the list ----------

function buildItems(turns: Turn[], blocks: BlockView[], showSys: boolean): Item[] {
  const items: Item[] = [];
  const blockOf = (i: number) => blocks.find((b) => i >= b.i0 && i <= b.i1) || null;
  const seenBlocks = new Set<string>();
  let prevDay = '';
  let run: Turn[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length >= 2) items.push({ kind: 'group', key: `g${run[run.length - 1].i}`, turns: run });
    else items.push({ kind: 'turn', key: `t${run[0].i}`, t: run[0] });
    run = [];
  };
  for (const t of turns) {
    const day = dayKey(t.t);
    const b = blockOf(t.i);
    const newBlock = !!b && !seenBlocks.has(b.key);
    if (day !== prevDay || newBlock) flush();
    if (day !== prevDay) {
      items.push({ kind: 'day', key: `d${day}`, t: t.t });
      prevDay = day;
    }
    if (b && newBlock) {
      seenBlocks.add(b.key);
      items.push({ kind: 'block', key: `b${b.key}`, b });
    }
    if (!showSys && isBg(t) && t.a) {
      run.push(t);
      continue;
    }
    flush();
    items.push({ kind: 'turn', key: `t${t.i}`, t });
  }
  flush();
  return items;
}

export function Conversation({ s }: { s: SessionDetail }) {
  const [showSys, setShowSys] = useState(false);
  const latest = useTurns(s.id, undefined, showSys);
  const viewKey = `${s.id}:${showSys ? 1 : 0}`;
  // The turns on screen. Kept until the next view's first page arrives, so toggling never blanks the page.
  const [view, setView] = useState<{ key: string; map: Map<number, Turn>; more: boolean | null }>(() => ({ key: '', map: new Map(), more: null }));
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const initial = useRef(true);
  const userMoved = useRef(false);
  const atBottom = useRef(true);
  const lastKey = useRef('');
  const lastCount = useRef(0);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(0);

  // Merge the latest page (it is refetched live); never drop turns we already have.
  useEffect(() => {
    const page = latest.data;
    if (!page) return;
    setView((v) => {
      if (v.key !== viewKey) return { key: viewKey, map: new Map(page.turns.map((t) => [t.i, t])), more: null };
      const m = new Map(v.map);
      for (const t of page.turns) m.set(t.i, t);
      return { ...v, map: m };
    });
  }, [latest.data, viewKey]);

  const turns = useMemo(() => [...view.map.values()].sort((a, b) => a.i - b.i), [view.map]);
  const viewSys = view.key.endsWith(':1');
  const items = useMemo(() => buildItems(turns, s.blocksDetail, viewSys), [turns, s.blocksDetail, viewSys]);
  const hasMore = view.key === viewKey ? (view.more ?? latest.data?.hasMore ?? false) : false;
  const switching = view.key !== viewKey && !!view.key;

  // Notice when the user scrolls on their own (so we never fight them).
  useEffect(() => {
    const mark = () => (userMoved.current = true);
    const evs = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;
    evs.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, mark));
  }, []);

  // Track whether the end of the conversation is on screen.
  useEffect(() => {
    const el = endRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([e]) => {
        const below = e.boundingClientRect.top > (e.rootBounds?.bottom ?? window.innerHeight);
        atBottom.current = e.isIntersecting;
        setAway(!e.isIntersecting && below);
        if (e.isIntersecting) setUnseen(0);
      },
      { rootMargin: '0px 0px 160px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [turns.length > 0]);

  const jump = useCallback((smooth = false) => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // Open at the latest turns; keep the place when older turns are prepended; follow new turns at the bottom.
  useLayoutEffect(() => {
    if (!turns.length) return;
    const a = anchor.current;
    if (a) {
      anchor.current = null;
      lastCount.current = turns.length;
      const q = (k: string) => listRef.current?.querySelector<HTMLElement>(`[data-key="${k}"]`);
      // Replies measure themselves ("Show more") right after this commit, so settle over a few frames.
      const fix = () => {
        if (userMoved.current) return;
        // A single background turn can merge into a group once its older neighbours load.
        const el = q(a.key) || q(a.key.replace(/^t/, 'g'));
        if (!el) return;
        const d = el.getBoundingClientRect().top - a.top;
        if (Math.abs(d) >= 1) window.scrollBy(0, d);
      };
      fix();
      let n = 0;
      let raf = requestAnimationFrame(function tick() {
        fix();
        if (++n < 8) raf = requestAnimationFrame(tick);
      });
      const t = window.setTimeout(fix, 300);
      return () => {
        cancelAnimationFrame(raf);
        window.clearTimeout(t);
      };
    }
    const keyChanged = lastKey.current !== view.key;
    lastKey.current = view.key;
    if (initial.current) {
      initial.current = false;
      lastCount.current = turns.length;
      if (window.location.hash) return;
      jump();
      // The shell resets the scroll on navigation, and fonts, the summary and replies measuring themselves can
      // shift the layout for a moment: stay pinned to the latest turn until it settles or the user scrolls.
      const pin = () => !userMoved.current && jump();
      const id = window.setTimeout(pin, 80);
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(pin) : null;
      ro?.observe(document.body);
      const stop = window.setTimeout(() => ro?.disconnect(), 3000);
      return () => {
        window.clearTimeout(id);
        window.clearTimeout(stop);
        ro?.disconnect();
      };
    }
    if (keyChanged) {
      lastCount.current = turns.length;
      return;
    }
    const added = turns.length - lastCount.current;
    lastCount.current = turns.length;
    if (added > 0) {
      if (atBottom.current) jump();
      else setUnseen((n) => n + added);
    }
  }, [turns, view.key, jump]);

  const loadOlder = async () => {
    const first = turns[0];
    if (!first) return;
    const key = view.key;
    const firstEl = listRef.current?.querySelector<HTMLElement>('[data-key]');
    userMoved.current = false;
    setOlderBusy(true);
    setOlderError(null);
    try {
      const page = await api<TurnsPage>(`/api/sessions/${s.id}/turns?limit=${PAGE}&before=${first.i}${viewSys ? '&system=1' : ''}`);
      if (firstEl && page.turns.length) anchor.current = { key: firstEl.dataset.key!, top: firstEl.getBoundingClientRect().top };
      setView((v) => {
        if (v.key !== key) return v;
        const m = new Map(v.map);
        for (const t of page.turns) m.set(t.i, t);
        return { ...v, map: m, more: page.hasMore };
      });
    } catch (e) {
      setOlderError((e as Error).message);
    } finally {
      setOlderBusy(false);
    }
  };

  const total = latest.data?.shown ?? 0;
  // Background events (finished tasks, check-ins) only exist in Claude transcripts.
  const canSys = (s.harness || 'claude') === 'claude' && s.kind !== 'archived';
  const head = (
    <div className="card-head sx-conv-head">
      <h2>
        Conversation
        {total > 0 && (
          <span className="count" title={`${total.toLocaleString('en-GB')} ${total === 1 ? 'message' : 'messages'}${showSys ? ', background events included' : ': each is a prompt and the reply to it'}`}>
            {total.toLocaleString('en-GB')}
          </span>
        )}
      </h2>
      {canSys && <Button size="sm" variant="ghost" icon={showSys ? <EyeOff /> : <Eye />} loading={switching} onClick={() => setShowSys(!showSys)} aria-pressed={showSys} title="Background events: finished tasks, scheduled check-ins, system notes">
        {showSys ? 'Hide background' : 'Show background'}
      </Button>}
    </div>
  );

  if (latest.isLoading && !turns.length)
    return (
      <div className="card sx-conv" aria-busy="true">
        {head}
        <div className="sx-conv-skel">
          <Skeleton h={38} w="58%" />
          <Skeleton h={12} w="90%" />
          <Skeleton h={12} w="76%" />
          <Skeleton h={12} w="82%" />
          <Skeleton h={38} w="44%" />
          <Skeleton h={12} w="88%" />
        </div>
      </div>
    );

  if (latest.error && !turns.length)
    return (
      <div className="card sx-conv">
        {head}
        <EmptyState icon={<TriangleAlert />} title="Couldn’t load the conversation" body={(latest.error as Error).message} action={<Button size="sm" onClick={() => latest.refetch()}>Try again</Button>} compact />
      </div>
    );

  return (
    <div className="card sx-conv">
      {head}
      <div className="sx-conv-body" ref={listRef}>
        {hasMore && (
          <div className="sx-earlier">
            <Button size="sm" loading={olderBusy} onClick={loadOlder}>
              Load earlier messages
            </Button>
            {olderError && <span className="small tone-red">{olderError}</span>}
            {!olderError && total > turns.length && <span className="tiny faint num">{(total - turns.length).toLocaleString()} more</span>}
          </div>
        )}
        {turns.length === 0 && <EmptyState icon={<MessagesSquare />} title="No messages recorded" body={s.kind === 'archived' ? 'Only the prompts were kept, and none are left.' : undefined} compact />}
        {items.map((it) =>
          it.kind === 'day' ? (
            <DayDivider key={it.key} t={it.t} />
          ) : it.kind === 'block' ? (
            <BlockHeader key={it.key} b={it.b} />
          ) : it.kind === 'group' ? (
            <BgGroup key={it.key} s={s} turns={it.turns} />
          ) : (
            <TurnView key={it.key} s={s} t={it.t} showSys={viewSys} />
          ),
        )}
        <div className="sx-jump-dock" aria-hidden={!away}>
          {away && (
            <button type="button" className="sx-jump" onClick={() => jump(true)}>
              <ArrowDown size={15} />
              {unseen > 0 ? `${plural(unseen, 'new message')}` : 'Jump to latest'}
            </button>
          )}
        </div>
        <div ref={endRef} className="sx-end" />
      </div>
    </div>
  );
}
