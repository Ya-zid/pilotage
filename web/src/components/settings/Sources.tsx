// Settings → Sources & accounts: which coding tools Pilotage reads sessions from, and the Claude accounts it has seen.
import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FolderTree, Layers, MessageCircle, Sparkles, SquareTerminal, Users } from 'lucide-react';
import { api, useInvalidate } from '../../api';
import { chatsImport, chatsRemove, useChats, useHarnesses } from '../../api-extra';
import type { Harness, HarnessesPatch, HarnessesResponse, HarnessInfo } from '../../types-extra';
import { Button, EmptyState, ErrorBox, LoadingCard, Meta, Switch, useToast } from '../ui';
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
      <ClaudeAiCard />
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

/** claude.ai chats: import the official data export (a path on this PC). PC only; read-only (docs/API-CHATS.md). */
function ClaudeAiCard() {
  const { data } = useChats('', 1);
  const st = data?.status;
  const viaLan = useViaLan();
  const toast = useToast();
  const inv = useInvalidate();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!path.trim() || busy) return;
    setBusy(true);
    try {
      const r = await chatsImport(path.trim());
      toast(`${plural(r.count, 'chat')} imported${r.linked ? `, ${r.linked} linked to a project` : ''}`);
      setPath('');
      inv('chats', 'graph', 'search');
    } catch (e) {
      toast(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm('Forget the imported claude.ai chats? Your export file and claude.ai stay as they are.')) return;
    try {
      await chatsRemove();
      toast('claude.ai chats removed');
      inv('chats', 'graph', 'search');
    } catch (e) {
      toast(errMsg(e), true);
    }
  };
  return (
    <SettingsCard title="claude.ai chats" icon={<MessageCircle />} description="Your conversations on claude.ai, from its data export. Read-only: they show on the Map, in Sessions and in search, and open in claude.ai." actions={viaLan ? <PcOnly text="Import on the PC" /> : null}>
      <fieldset className="stack-lg bare-fieldset" disabled={viaLan}>
        {st?.imported ? (
          <div className="mini-list">
            <div className="mini-row">
              <span className="small medium num">{plural(st.count, 'chat')}</span>
              <Meta
                className="grow"
                items={[
                  st.linked ? <span className="num">{st.linked} linked to a project</span> : null,
                  st.importedAt ? <span title={fmtDateTime(st.importedAt)}>imported {ago(st.importedAt)}</span> : null,
                  st.source ? <span className="mono" title={st.source.from}>{st.source.from}</span> : null,
                ]}
              />
            </div>
          </div>
        ) : (
          <EmptyState compact title="No export imported yet" body="On claude.ai: Settings → Privacy → Export data. The zip arrives by e-mail." />
        )}
        <SettingRows>
          <SettingRow stack label="Import an export" htmlFor="claude-ai-path" hint="The zip, the folder you unzipped it to, or its conversations.json: a path on this PC. A newer import replaces this one.">
            <form
              className="row"
              style={{ gap: 8 }}
              onSubmit={(e) => {
                e.preventDefault();
                run();
              }}
            >
              <input id="claude-ai-path" className="input mono grow" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/Downloads/data-2026-11-24.zip" autoComplete="off" spellCheck={false} />
              <Button type="submit" loading={busy} disabled={!path.trim()}>
                Import
              </Button>
            </form>
          </SettingRow>
          {st?.imported && (
            <SettingRow label="Forget the import" hint="Removes the chats from Pilotage. Nothing changes on claude.ai.">
              <Button size="sm" variant="danger" onClick={remove}>
                Remove
              </Button>
            </SettingRow>
          )}
        </SettingRows>
      </fieldset>
    </SettingsCard>
  );
}
