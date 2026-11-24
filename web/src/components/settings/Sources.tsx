// Settings → Sources & accounts: which coding tools Pilotage reads sessions from, and the Claude accounts it has seen.
import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FolderTree, Layers, Sparkles, SquareTerminal, Users } from 'lucide-react';
import { api, useInvalidate } from '../../api';
import { useHarnesses } from '../../api-extra';
import type { Harness, HarnessesPatch, HarnessesResponse, HarnessInfo } from '../../types-extra';
import { EmptyState, ErrorBox, LoadingCard, Meta, Switch, useToast } from '../ui';
import { ago, fmtDateTime, plural } from '../../util';
import { PathList, PcOnly, SettingRow, SettingRows, SettingsCard, errMsg, useViaLan } from './common';

const SOURCE_LABEL: Record<string, string> = { wsl: 'WSL', win: 'Windows', history: 'history', 'win-history': 'Windows history' };
const sourceLabel = (s: string) => SOURCE_LABEL[s] || (s.startsWith('x-') ? 'extra folder' : s);

function HarnessIcon({ id }: { id: Harness }) {
  return (
    <span className="icon-tile" aria-hidden="true">
      {id === 'claude' ? <Sparkles size={16} /> : <SquareTerminal size={16} />}
    </span>
  );
}

function usePatchHarnesses() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  const toast = useToast();
  return async (body: HarnessesPatch, ok: string | null): Promise<boolean> => {
    try {
      const r = await api<HarnessesResponse & { rescanning: boolean }>('/api/harnesses', { method: 'PATCH', body });
      qc.setQueryData(['harnesses'], r);
      inv('settings', 'bootstrap');
      if (ok) toast(r.rescanning ? `${ok}. Re-reading sessions…` : ok);
      return true;
    } catch (e) {
      toast(errMsg(e), true);
      return false;
    }
  };
}

export function useSourcesSummary() {
  const { data } = useHarnesses();
  if (!data) return '';
  const on = data.harnesses.filter((h) => h.enabled && h.installed).map((h) => h.label.replace(/ (Code|CLI)$/, ''));
  return [on.join(', '), data.accounts.length > 1 ? plural(data.accounts.length, 'account') : null].filter(Boolean).join(' · ');
}

export function SourcesSection() {
  const { data, error, isLoading } = useHarnesses();
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data)
    return (
      <>
        <LoadingCard lines={3} />
        <LoadingCard lines={2} />
      </>
    );
  return (
    <>
      <HarnessesCard data={data} />
      <AccountsCard data={data} />
    </>
  );
}

function HarnessesCard({ data }: { data: HarnessesResponse }) {
  const patch = usePatchHarnesses();
  const viaLan = useViaLan();
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = async (h: HarnessInfo, on: boolean) => {
    setBusy(h.id);
    await patch({ enabled: { [h.id]: on } }, on ? `${h.label} sessions on` : `${h.label} sessions hidden`);
    setBusy(null);
  };
  return (
    <SettingsCard title="Coding tools" icon={<Layers />} description="Pilotage reads sessions from these tools, side by side. It never changes their files." actions={viaLan ? <PcOnly text="Change on the PC" /> : null} flush>
      <fieldset className="list bare-fieldset" disabled={viaLan}>
        {data.harnesses.map((h) => (
          <div key={h.id} className="lrow harness-row">
            <div className="lrow-lead">
              <HarnessIcon id={h.id} />
            </div>
            <div className="lrow-body">
              <div className="lrow-title">
                <span className="t">{h.label}</span>
              </div>
              <Meta
                items={[
                  h.installed ? h.version ? h.version.replace(/\s*\(.*\)$/, '') : 'installed' : <span className="tone-amber">not installed</span>,
                  <span className="num">{plural(h.sessions, 'session')}</span>,
                  h.dataDir ? (
                    <span className="mono" title={h.dataDir}>
                      {h.dataDir.replace(/^\/home\/[^/]+/, '~')}
                    </span>
                  ) : null,
                  h.live ? 'live tracking' : null,
                ]}
              />
            </div>
            <div className="lrow-trail">
              {h.id === 'claude' ? <span className="tiny faint">Always on</span> : <Switch on={h.enabled} label={`Read ${h.label} sessions`} onChange={(v) => busy !== h.id && toggle(h, v)} />}
            </div>
          </div>
        ))}
      </fieldset>
    </SettingsCard>
  );
}

function AccountsCard({ data }: { data: HarnessesResponse }) {
  const patch = usePatchHarnesses();
  const saveDirs = async (next: string[], added: string | null) => patch({ extraClaudeDirs: next }, added ? 'Folder added' : 'Folder removed');
  const viaLan = useViaLan();
  return (
    <SettingsCard title="Claude accounts" icon={<Users />} description="Accounts seen in your Claude transcripts, and where Pilotage looks for them." actions={viaLan ? <PcOnly text="Change on the PC" /> : null}>
      <fieldset className="stack-lg bare-fieldset" disabled={viaLan}>
        {data.accounts.length === 0 ? (
          <EmptyState compact title="No accounts seen yet" body="Older transcripts don't record which account wrote them." />
        ) : (
          <div className="mini-list">
            {data.accounts.map((a, i) => (
              <div key={a.account} className="mini-row account-row">
                <span className="mono small medium">{a.account}</span>
                <Meta
                  className="grow"
                  items={[
                    i === 0 ? <span className="tone-accent">most recent</span> : null,
                    <span className="num">{plural(a.sessions, 'session')}</span>,
                    <span title={fmtDateTime(a.lastAt)}>{ago(a.lastAt)}</span>,
                    a.sources.map(sourceLabel).join(', '),
                  ]}
                />
              </div>
            ))}
          </div>
        )}
        <SettingRows>
          <SettingRow
            stack
            label={
              <span className="row" style={{ gap: 8 }}>
                <FolderTree size={15} className="faint" aria-hidden="true" />
                Folders Pilotage reads
              </span>
            }
            hint="Your WSL and Windows Claude folders are always read. Add another account's folder (the one you start it with, e.g. CLAUDE_CONFIG_DIR=~/.claude-work)."
          >
            <div className="stack">
              <div className="mini-list">
                {data.claudeDirs
                  .filter((d) => !d.extra)
                  .map((d) => (
                    <div key={d.id} className="mini-row">
                      <span className="mono small grow break">{d.dir}</span>
                      <span className={`tiny ${d.exists ? 'faint' : 'tone-amber'}`}>{d.exists ? sourceLabel(d.id) : 'missing'}</span>
                    </div>
                  ))}
              </div>
              <PathList id="extra-claude-dir" label="Extra Claude folders" paths={data.extraClaudeDirs} placeholder="/home/you/.claude-work" onSave={saveDirs} empty="No extra folders." />
            </div>
          </SettingRow>
        </SettingRows>
      </fieldset>
    </SettingsCard>
  );
}
