// History (/history, was Timeline): a year of activity at a glance, this week in five seconds, and any day in detail.
// Blueprint: docs/DESIGN.md §8 "Timeline", renamed per docs/SIMPLIFY.md §2.
import React, { useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, Flame, GitCommitHorizontal, MessagesSquare, TrendingUp, TriangleAlert } from 'lucide-react';
import { useTimeline } from '../api';
import { Button, Card, EmptyState, LoadingCard, PageHeader, Skeleton, StatTile, compactNum } from '../components/ui';
import { fmtDate, isoDay, plural } from '../util';
import { isValidDay, parseDay, score, shiftDay } from '../components/timeline/dates';
import { Heatmap } from '../components/timeline/Heatmap';
import { DayPanel } from '../components/timeline/DayPanel';
import { WeekSummary } from '../components/timeline/WeekSummary';
import { ProjectsMonthCard, WeeksCard } from '../components/timeline/Trends';
import { useMedia } from '../components/session/shared';
import './Timeline.css';

const header = <PageHeader title="History" />;

export default function Timeline() {
  const { data, isLoading, error, refetch } = useTimeline();
  const [params, setParams] = useSearchParams();
  const today = isoDay(Date.now());
  const phone = useMedia();
  const dayRef = useRef<HTMLDivElement>(null);

  const byDay = useMemo(() => new Map((data?.days || []).map((d) => [d.day, d])), [data]);
  const projByPath = useMemo(() => new Map((data?.projects || []).map((p) => [p.path, p])), [data]);
  const projById = useMemo(() => new Map((data?.projects || []).map((p) => [p.id, p])), [data]);

  const defaultDay = useMemo(() => {
    if (score(byDay.get(today)) > 0) return today;
    const days = data?.days || [];
    for (let i = days.length - 1; i >= 0; i--) if (days[i].day <= today && score(days[i]) > 0) return days[i].day;
    return today;
  }, [byDay, data, today]);
  const paramDay = params.get('day');
  const selected = isValidDay(paramDay) && paramDay <= today ? paramDay : defaultDay;
  const select = (day: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('day', day);
        return next;
      },
      { replace: true },
    );
  // On the phone the day panel sits below the fold, so a tap on a heatmap cell brings it into view
  // (keyboard moves stay on the grid).
  const pick = (day: string, via: 'pointer' | 'key') => {
    select(day);
    if (via !== 'pointer' || !phone) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => dayRef.current?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' }));
  };

  const stats = useMemo(() => {
    const since = shiftDay(today, -364);
    let active = 0;
    let prompts = 0;
    let commits = 0;
    for (const d of data?.days || []) {
      if (d.day < since || d.day > today) continue;
      if (score(d) > 0) active++;
      prompts += d.prompts;
      commits += d.commits;
    }
    let longest = 0;
    let longestEnd = '';
    let run = 0;
    for (let i = 364; i >= 0; i--) {
      const k = shiftDay(today, -i);
      if (score(byDay.get(k)) > 0) {
        run++;
        if (run > longest) {
          longest = run;
          longestEnd = k;
        }
      } else run = 0;
    }
    let current = 0;
    let cursor = score(byDay.get(today)) > 0 ? today : shiftDay(today, -1);
    while (score(byDay.get(cursor)) > 0 && current < 800) {
      current++;
      cursor = shiftDay(cursor, -1);
    }
    // weekly prompt totals for the sparkline (last 12 weeks)
    const spark: number[] = [];
    for (let w = 11; w >= 0; w--) {
      let n = 0;
      for (let d = 0; d < 7; d++) n += byDay.get(shiftDay(today, -(w * 7 + d)))?.prompts || 0;
      spark.push(n);
    }
    return { active, prompts, commits, longest, longestEnd, current, currentStart: shiftDay(cursor, 1), spark };
  }, [data, byDay, today]);

  if (isLoading)
    return (
      <>
        {header}
        <div className="grid-stats tl-stats" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="stat sm">
              <Skeleton h={12} w="60%" />
              <Skeleton h={24} w="40%" />
            </div>
          ))}
        </div>
        <LoadingCard lines={4} />
        <div className="tl-layout">
          <div className="tl-a-day">
            <LoadingCard lines={6} />
          </div>
          <div className="tl-a-week">
            <LoadingCard lines={4} />
          </div>
        </div>
      </>
    );
  if (error || !data)
    return (
      <>
        {header}
        <Card>
          <EmptyState icon={<TriangleAlert />} title="Couldn’t load your history" body={error instanceof Error ? error.message : undefined} action={<Button size="sm" onClick={() => refetch()}>Try again</Button>} />
        </Card>
      </>
    );
  if (!data.days.some((d) => score(d) > 0))
    return (
      <>
        {header}
        <Card>
          <EmptyState icon={<CalendarDays />} title="No activity recorded yet" body="History fills in from your prompts and your git commits as you work." />
        </Card>
      </>
    );

  const ongoing = stats.current > 0 && stats.current === stats.longest;
  // Phones drop the Longest tile while it only repeats the current streak (one row less above the day).
  const foldLongest = phone && ongoing;
  const longestHint = ongoing ? 'that’s your current streak' : stats.longest > 1 && stats.longestEnd ? `ended ${fmtDate(parseDay(stats.longestEnd).getTime())}` : undefined;
  return (
    <>
      {header}

      <div className="grid-stats tl-stats">
        <StatTile size="sm" label="Active days" icon={<CalendarDays />} value={stats.active} hint="in the last 12 months" />
        <StatTile size="sm" label="Prompts" icon={<MessagesSquare />} value={compactNum(stats.prompts)} spark={stats.spark} hint="last 12 months" />
        <StatTile size="sm" label="Commits" icon={<GitCommitHorizontal />} value={compactNum(stats.commits)} hint="last 12 months" />
        <StatTile size="sm" label="Current streak" icon={<Flame />} value={stats.current} unit={stats.current === 1 ? 'day' : 'days'} hint={foldLongest && stats.current > 1 ? 'your longest yet' : stats.current > 1 ? `since ${fmtDate(parseDay(stats.currentStart).getTime())}` : stats.current === 1 ? 'keep it going' : 'start one today'} />
        {!foldLongest && <StatTile size="sm" label="Longest streak" icon={<TrendingUp />} value={stats.longest} unit={stats.longest === 1 ? 'day' : 'days'} hint={longestHint} />}
      </div>

      <Card className="tl-year">
        <Heatmap byDay={byDay} today={today} selected={selected} onSelect={pick} />
      </Card>

      <div className="tl-layout">
        <div className="tl-a-week">
          <WeekSummary byDay={byDay} today={today} projByPath={projByPath} projById={projById} />
        </div>
        <div className="tl-a-day" ref={dayRef}>
          <DayPanel day={selected} today={today} act={byDay.get(selected)} onSelect={select} projByPath={projByPath} projById={projById} />
        </div>
        <div className="tl-a-rail">
          <WeeksCard byDay={byDay} today={today} />
          <ProjectsMonthCard days={data.days} projByPath={projByPath} today={today} />
        </div>
      </div>
      <p className="tiny faint tl-footnote">Squares and bars weigh a commit like two prompts.</p>
      <span className="sr-only" aria-live="polite">
        {plural(byDay.get(selected)?.prompts || 0, 'prompt')} on {fmtDate(parseDay(selected).getTime())}
      </span>
    </>
  );
}
