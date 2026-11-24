// Home (route `/`): how things stand, in one calm column. Order and rules: docs/SIMPLIFY.md §4.
// Header (greeting + date) → pulse tiles → Needs you → Running → Today → Pick up. No prose until a row is tapped.
// First run (no session indexed yet): one welcome with New session in place of the zero tiles.
import { useOverview } from '../api';
import { liveState } from '../components/cards';
import { Button, Card, EmptyState, PageHeader, Skeleton } from '../components/ui';
import { CatchingUp, HomeUndoToast, sortLive } from '../components/today/TodayBits';
import { Collisions, HomeHeader, NeedsYou, PhoneSetup, PickUp, PulseTiles, Running, TodayPlan, Welcome, homeTitle, useUserName } from '../components/today/HomeSections';
import { TaskUndoToast } from '../components/tasks/TaskBits';
import { friendly, useMedia, useTick } from '../components/tasks/model';
import './Today.css';

export default function Today() {
  useTick();
  const { data: o, error, isLoading, refetch } = useOverview();
  const phone = useMedia();
  const name = useUserName();

  if (isLoading)
    return (
      <div className="home" aria-busy="true">
        <PageHeader className="home-head" title={homeTitle(name)} />
        <div className="pulse">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="pulse-tile">
              <Skeleton h={12} w="60%" />
              <Skeleton h={22} w={28} />
            </div>
          ))}
        </div>
      </div>
    );
  if (error || !o)
    return (
      <div className="home">
        <PageHeader className="home-head" title={homeTitle(name)} />
        <Card>
          <EmptyState
            title="Home didn’t load"
            body={friendly(error)}
            action={
              <Button size="sm" onClick={() => refetch()}>
                Try again
              </Button>
            }
          />
        </Card>
      </div>
    );

  const live = sortLive(o.live.filter((s) => s.live));
  const needs = live.filter((s) => liveState(s) === 'needs-you');
  const working = live.filter((s) => liveState(s) === 'working');
  const idle = live.filter((s) => liveState(s) === 'idle_live');
  // Nothing indexed once the first scan is done: a new user (no ~/.claude history yet), not a quiet day.
  const fresh = o.counts.sessions === 0 && o.index.firstDone && !o.live.length;
  const tasks = o.plan?.today.length || 0;

  return (
    <div className="home">
      <HomeHeader />
      {fresh ? <Welcome phone={phone} /> : <PulseTiles o={o} needs={needs.length} working={working.length} />}
      <CatchingUp o={o} />
      <Collisions items={o.attention.filter((a) => a.kind === 'collision')} />
      {!phone && <PhoneSetup />}
      <NeedsYou list={needs} />
      <Running working={working} idle={idle} />
      {(!fresh || tasks > 0) && <TodayPlan o={o} />}
      <PickUp items={o.pickup || []} phone={phone} />
      <TaskUndoToast />
      <HomeUndoToast />
    </div>
  );
}
