// More (phone): the pages that aren't tabs (Tasks, Ideas, Map, History, Portfolio & CV, Settings, How Pilotage works),
// plus Claude usage. One line per page; only Tasks and Ideas carry a state line (their counts), nothing explains itself.
import { Briefcase, ChevronRight, CircleHelp, Gauge, History, Lightbulb, ListChecks, Network, Settings } from 'lucide-react';
import { useBootstrap, useIdeas, useOverview } from '../api';
import { useTodayTaskCount } from '../components/Layout';
import { Card, CountPill, ListRow, Meter, PageHeader, USAGE_LABELS } from '../components/ui';
import { fmtDateTime, fmtTime, plural } from '../util';
import './More.css';

function UsageRow({ label, pct, resetsAt, sameDay }: { label: string; pct: number | null; resetsAt?: number; sameDay?: boolean }) {
  return (
    <div className="usage-line">
      <div className="spread">
        <span className="medium">{label}</span>
        <span className={`num medium${pct != null && pct >= 85 ? ' tone-red' : pct != null && pct >= 60 ? ' tone-amber' : ''}`}>{pct == null ? 'Unknown' : `${Math.round(pct)}%`}</span>
      </div>
      {pct != null ? <Meter pct={pct} label={label} /> : <div className="meter" aria-hidden="true" />}
      <div className="tiny faint">{pct == null ? 'Pilotage hasn’t seen a usage reading yet' : resetsAt ? `Resets ${sameDay ? fmtTime(resetsAt) : fmtDateTime(resetsAt)}` : ' '}</div>
    </div>
  );
}

export default function More() {
  const { data: o } = useOverview();
  const { data: boot } = useBootstrap();
  const { data: ideas } = useIdeas();
  const u = o?.usage || boot?.usage;
  const today = useTodayTaskCount();
  const work = o?.work;
  const open = work ? (work.todoCount || 0) + (work.doingCount || 0) : 0;
  const savedIdeas = ideas ? ideas.filter((i) => !i.doneAt).length : 0;
  const possible = o?.scout?.newCount || 0;
  const items = [
    {
      to: '/tasks',
      icon: <ListChecks />,
      label: 'Tasks',
      sub: work ? [today ? `${today} for today` : null, open ? `${open} to do` : 'Nothing to do'].filter(Boolean).join(' · ') : undefined,
      count: today > 0 ? <CountPill n={today} tone="accent" title={`${plural(today, 'task')} for today or in progress`} /> : null,
    },
    {
      to: '/ideas',
      icon: <Lightbulb />,
      label: 'Ideas',
      sub: [possible ? plural(possible, 'possible project') : null, savedIdeas ? plural(savedIdeas, 'saved idea') : null].filter(Boolean).join(' · ') || undefined,
      count: possible > 0 ? <CountPill n={possible} title={plural(possible, 'new possible project')} /> : null,
    },
    { to: '/map', icon: <Network />, label: 'Map' },
    { to: '/history', icon: <History />, label: 'History' },
    { to: '/portfolio', icon: <Briefcase />, label: 'Portfolio & CV' },
    { to: '/settings', icon: <Settings />, label: 'Settings' },
    { to: '/guide', icon: <CircleHelp />, label: 'How Pilotage works' },
  ];
  const sameDay = (t?: number) => !!t && new Date(t).toDateString() === new Date().toDateString();
  return (
    <>
      <PageHeader title="More" />
      <Card flush className="more-menu">
        {items.map((i) => (
          <ListRow
            key={i.to}
            dense
            to={i.to}
            lead={<span className="more-ico">{i.icon}</span>}
            title={i.label}
            sub={'sub' in i ? i.sub : undefined}
            trail={
              <>
                {'count' in i && i.count}
                <ChevronRight size={16} />
              </>
            }
            label={i.label}
          />
        ))}
      </Card>
      <Card title="Claude usage" icon={<Gauge />}>
        {u ? (
          <div className="stack-lg">
            <UsageRow label={USAGE_LABELS.five} pct={u.five ? u.five.pct : null} resetsAt={u.five?.resetsAt} sameDay={sameDay(u.five?.resetsAt)} />
            <UsageRow label={USAGE_LABELS.seven} pct={u.seven ? u.seven.pct : null} resetsAt={u.seven?.resetsAt} sameDay={sameDay(u.seven?.resetsAt)} />
          </div>
        ) : (
          <div className="small faint">Loading…</div>
        )}
      </Card>
      <div className="tiny faint more-foot">
        Pilotage {boot?.version} · this device: {boot?.device.name || '…'}
      </div>
    </>
  );
}
