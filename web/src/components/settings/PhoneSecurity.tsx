// Settings → Phone & security: phone access checklist, trusted Wi-Fi, install as an app (HTTPS certificate),
// devices + pairing, desktop key.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppWindow, CheckCircle2, Clock, Download, ExternalLink, KeyRound, Lock, Monitor, MonitorSmartphone, Pencil, Play, QrCode, RefreshCw, ShieldCheck, Smartphone, Square, Trash2, TriangleAlert, Wifi } from 'lucide-react';
import { api, useDevices, useInvalidate, useNet } from '../../api';
import type { Device } from '../../types';
import { Button, Callout, CopyButton, Disclosure, EmptyState, ErrorBox, IconButton, Meta, Modal, SegmentedControl, Skeleton, Spinner, useToast } from '../ui';
import { ago, fmtDate, fmtDateTime, plural } from '../../util';
import { installPrompt, isStandalone, onInstallPromptChange } from '../../pwa';
import { CheckLine, NetStatus, PcOnly, SettingRow, SettingRows, SettingsCard, errMsg, useNow, useViaLan } from './common';

type DevicesResp = { devices: Device[]; current: string };
type PairUrl = { kind: string; adapter: string; url: string; qr: string; scheme?: 'http' | 'https' };
type PairResp = {
  expiresAt: number;
  urls: PairUrl[];
  /** The same links in the other scheme (http when urls are https, and the reverse). */
  alt?: PairUrl[];
  scheme?: 'http' | 'https';
  primary: string;
  forwarder: NetStatus['forwarder'];
  firewallRule?: boolean;
};

/** GET /api/net/tls: the Pilotage certificate (server/tls.js) and the phone addresses. QR codes only with ?qr=1. */
export type TlsInfo = {
  ready: boolean;
  error: string | null;
  fingerprint: string | null;
  caName: string | null;
  caValidTo: number | null;
  leafValidTo: number | null;
  leafNames: string[];
  handshakeFailures: number;
  lastHandshakeFailure: { at: number; code: string } | null;
  mode?: LanMode;
  lanPort: number;
  urls: { kind: string; adapter: string; ip: string; http: string; https: string; caUrl: string; caQr?: string; httpsQr?: string }[];
};
/** How phones get in: the Windows forwarder (WSL), a direct bind (PILOTAGE_LAN_BIND), or not at all. */
type LanMode = 'forwarder' | 'bind' | 'off';
type NetX = NetStatus & { mode?: LanMode; lanBind?: string | null; allowList?: string[] | null; tls?: Partial<TlsInfo> };

const KIND_LABEL: Record<string, string> = { wifi: 'Home Wi-Fi', ethernet: 'Ethernet', netbird: 'NetBird', tailscale: 'Tailscale', other: 'Other network' };
const kindLabel = (k: string) => KIND_LABEL[k] || k;

function useNetStatus() {
  const q = useNet();
  return { ...q, net: q.data as unknown as NetX | undefined };
}

function useTls(withQr: boolean) {
  return useQuery({ queryKey: ['net', 'tls', withQr], queryFn: () => api<TlsInfo>(`/api/net/tls${withQr ? '?qr=1' : ''}`), refetchInterval: 60_000 });
}

function useNetActions() {
  const toast = useToast();
  const inv = useInvalidate();
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => {
    inv('net');
    setTimeout(() => inv('net'), 4000);
  };
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast(errMsg(e), true);
    } finally {
      setBusy(null);
      refresh();
    }
  };
  return {
    busy,
    /** UAC prompt on the PC → firewall rule (TCP 4748, home Wi-Fi subnet + NetBird only) → forwarder started. */
    enable: () =>
      run('enable', async () => {
        toast('Click “Yes” on the Windows admin prompt on your PC…');
        const r = await api<{ ok: boolean; error?: string; wifi?: string | null; trustedSsid?: string | null }>('/api/net/enable', { method: 'POST', body: {} });
        if (r.ok && r.wifi && !r.trustedSsid) toast(`Phone access is on. Wi-Fi phones are refused until you trust “${r.wifi}” below (only if it is your home network). Then pair your phone.`);
        else if (r.ok) toast('Phone access is on. Now pair your phone.');
        else toast(r.error || 'Could not enable phone access', true);
      }),
    start: () =>
      run('start', async () => {
        const r = await api<{ ok: boolean; error?: string; already?: boolean }>('/api/net/forwarder', { method: 'POST' });
        if (!r.ok) toast(`Couldn't start the forwarder: ${r.error || 'unknown error'}`, true);
        else toast(r.already ? 'The forwarder is already running' : 'Forwarder started');
      }),
    stop: () => {
      if (!window.confirm('Stop the phone forwarder?\n\nPhones lose access until you start it again (or Pilotage restarts).')) return;
      return run('stop', async () => {
        await api('/api/net/stop', { method: 'POST' });
        toast('Forwarder stopped. Phones can no longer connect.');
      });
    },
    trust: (ssid: string, trusted: boolean) =>
      run(`trust:${ssid}`, async () => {
        await api('/api/net/trust', { method: 'POST', body: { ssid, trusted } });
        toast(trusted ? `Phones on “${ssid}” can connect` : `“${ssid}” is no longer trusted`);
      }),
  };
}

// ---------------------------------------------------------------- section
export function PhoneSecuritySection() {
  const viaLan = useViaLan();
  // On a phone that isn't on https yet, installing the app is the useful thing here: show it first.
  const installFirst = viaLan && !window.isSecureContext;
  return (
    <>
      {installFirst && <InstallAppCard />}
      <PhoneAccessCard />
      {!installFirst && <InstallAppCard />}
      <DevicesCard />
      <DesktopKeyCard />
    </>
  );
}

/** One line for the collapsed section header on phones. */
export function usePhoneSummary() {
  const { net } = useNetStatus();
  const { data } = useDevices();
  if (!net) return '';
  const n = data?.devices.length;
  const state = net.mode === 'bind' ? 'On (direct)' : net.mode === 'off' ? 'Off' : !net.firewallRule ? 'Not enabled' : net.forwarder?.running ? 'On' : 'Forwarder stopped';
  return [state, net.tls?.ready ? 'HTTPS' : null, n != null ? plural(n, 'device') : null].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- phone access
function PhoneAccessCard() {
  const { net, error, isLoading } = useNetStatus();
  const viaLan = useViaLan();
  const a = useNetActions();
  const fw = net?.forwarder || {};
  const rule = !!net?.firewallRule;
  const running = !!fw.running;
  const lanPort = fw.port || net?.lanPort || 4748;
  const ssid = net?.currentSsid || null;
  const trustedList = net?.trustedSsids || [];
  const trusted = !!ssid && trustedList.includes(ssid);
  const netbird = net?.addresses.find((x) => x.kind === 'netbird' || x.kind === 'tailscale');
  const wifi = net?.addresses.find((x) => x.kind === 'wifi' || x.kind === 'ethernet');
  const https = !!net?.tls?.ready;
  if (net?.mode && net.mode !== 'forwarder') return <DirectAccessCard net={net} />;

  return (
    <SettingsCard
      title="Phone access"
      icon={<Smartphone />}
      description="Your phone reaches this PC through a small forwarder on Windows. Nothing is reachable from the internet."
      actions={viaLan && net?.firewallRule ? <PcOnly /> : null}
    >
      {error ? (
        <ErrorBox error={error} />
      ) : isLoading || !net ? (
        <div className="stack" style={{ gap: 14 }} aria-busy="true">
          <Skeleton h={18} w="55%" />
          <Skeleton h={18} w="48%" />
          <Skeleton h={18} w="62%" />
        </div>
      ) : (
        <div className="stack-lg">
          {!rule && (
            <Callout
              icon={<ShieldCheck />}
              title="Turn on phone access"
              action={
                viaLan ? (
                  <PcOnly />
                ) : (
                  <Button variant="accent" icon={<ShieldCheck />} loading={a.busy === 'enable'} onClick={a.enable}>
                    Enable phone access
                  </Button>
                )
              }
            >
              Opens a Windows admin prompt once. The firewall rule only allows TCP {lanPort}, only from your home Wi-Fi subnet and NetBird. Nothing else on the PC changes.
            </Callout>
          )}

          <div className="checklist" role="list" aria-label="Phone access status">
            <CheckLine state={rule ? 'ok' : 'warn'} title={rule ? 'Firewall rule in place' : 'Firewall rule missing'}>
              {rule ? `Allows TCP ${lanPort} from your home Wi-Fi subnet and NetBird only.` : 'Windows blocks phones until phone access is enabled once.'}
            </CheckLine>
            <CheckLine
              state={running && !fw.outdated ? 'ok' : rule ? 'warn' : 'off'}
              title={running ? (fw.outdated ? 'Forwarder needs a restart' : 'Forwarder running') : 'Forwarder stopped'}
              action={
                viaLan || !rule ? null : !running || fw.outdated ? (
                  <Button size="sm" icon={<Play />} loading={a.busy === 'start'} onClick={a.start}>
                    {fw.outdated ? 'Restart' : 'Start'}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" icon={<Square />} loading={a.busy === 'stop'} onClick={a.stop}>
                    Stop
                  </Button>
                )
              }
            >
              {running ? (
                <Meta
                  items={[
                    <span title={fmtDateTime(fw.lastSeen)}>heartbeat {ago(fw.lastSeen)}</span>,
                    plural(fw.connections || 0, 'connection'),
                    fw.refused ? <span title="Connections from networks that are not allowed">{fw.refused} refused</span> : null,
                  ]}
                />
              ) : rule ? (
                <>Start it so your phone can connect.{fw.lastSeen ? ` Last seen ${ago(fw.lastSeen)}.` : ''}</>
              ) : (
                'Starts automatically once phone access is enabled.'
              )}
            </CheckLine>
            <CheckLine
              state={!ssid ? 'off' : trusted ? 'ok' : 'warn'}
              title={
                ssid ? (
                  <>
                    Wi-Fi “{ssid}” {trusted ? 'is trusted' : 'is not trusted'}
                  </>
                ) : (
                  'PC is not on Wi-Fi'
                )
              }
              action={
                ssid && !trusted && !viaLan ? (
                  <Button size="sm" icon={<Wifi />} loading={a.busy === `trust:${ssid}`} onClick={() => a.trust(ssid, true)}>
                    Trust
                  </Button>
                ) : null
              }
            >
              {!ssid
                ? 'Wi-Fi access is off. NetBird still works.'
                : trusted
                  ? 'Phones on this network can connect directly.'
                  : 'Phones on this network are refused. Trust it only if it is your home network.'}
            </CheckLine>
            <CheckLine state={netbird ? 'ok' : 'off'} title={netbird ? 'NetBird connected' : 'NetBird not connected'}>
              {netbird ? 'Works from anywhere, and the connection is encrypted.' : 'Install NetBird on the PC and the phone to use Pilotage away from home.'}
            </CheckLine>
          </div>

          <div className="stack">
            <div className="sub-label">Trusted Wi-Fi networks</div>
            {trustedList.length === 0 ? (
              <div className="small faint">None yet. Phones can still connect through NetBird.</div>
            ) : (
              <div className="mini-list">
                {trustedList.map((n) => (
                  <div key={n} className="mini-row">
                    <Wifi size={15} className="faint" aria-hidden="true" />
                    <span className="grow truncate medium">{n}</span>
                    {n === ssid && <span className="tiny tone-green">Connected</span>}
                    {viaLan ? null : (
                      <Button size="sm" variant="ghost" loading={a.busy === `trust:${n}`} onClick={() => a.trust(n, false)}>
                        Untrust
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="stack-sm">
            <Disclosure summary="How your connection is protected">
              <ul className="plain-list small muted">
                <li>
                  <b className="medium">NetBird</b> works anywhere and is encrypted end to end (WireGuard).
                </li>
                <li>
                  <b className="medium">Home Wi-Fi</b> is only allowed while the PC is on a trusted network. Use the https address (see “Install Pilotage as an app”) to encrypt it; plain http relies on your Wi-Fi's WPA2 encryption.
                </li>
                <li>Every page and request needs a paired-device sign-in. Pairing codes work once and expire after 10 minutes.</li>
                <li>Pairing, devices, the firewall, keys and AI providers can only be changed from the PC itself, never from a phone.</li>
                <li>The server itself only listens on this PC (127.0.0.1). The forwarder is the only way in, on TCP {lanPort}.</li>
                <li>If NetBird can't connect, check that your NetBird access policy lets the phone reach this PC on TCP {lanPort}.</li>
              </ul>
            </Disclosure>
            {net.addresses.length > 0 && (
              <Disclosure summary="Addresses for a paired phone">
                <div className="mini-list">
                  {net.addresses.flatMap((x) =>
                    (https ? ['https', 'http'] : ['http']).map((scheme) => {
                      const url = `${scheme}://${x.ip}:${lanPort}`;
                      return (
                        <div key={`${x.adapter}-${x.ip}-${scheme}`} className="mini-row">
                          <span className="addr-kind small">{kindLabel(x.kind)}</span>
                          <span className="mono small grow break">{url}</span>
                          <CopyButton text={url} />
                        </div>
                      );
                    }),
                  )}
                </div>
                <div className="hint" style={{ marginTop: 8 }}>
                  A paired phone can open these directly{wifi ? '' : ' (no Wi-Fi address right now)'}. New phones need a QR code from “Pair a phone”.
                </div>
              </Disclosure>
            )}
          </div>

          {fw.error && (
            <Callout tone="warn" icon={<TriangleAlert />} title="The forwarder reported a problem">
              <span className="break">{fw.error}</span>
            </Callout>
          )}
        </div>
      )}
    </SettingsCard>
  );
}

/** Linux/macOS (PILOTAGE_LAN_BIND) or no phone path at all: there is no Windows forwarder or firewall rule to manage. */
function DirectAccessCard({ net }: { net: NetX }) {
  const bind = net.mode === 'bind';
  return (
    <SettingsCard title="Phone access" icon={<Smartphone />} description={bind ? 'Phones connect straight to this computer. Nothing is reachable from the internet.' : 'Phones cannot reach this computer yet.'}>
      <div className="stack-lg">
        {bind ? (
          <div className="checklist" role="list" aria-label="Phone access status">
            <CheckLine state="ok" title={`Listening on ${net.lanBind}:${net.lanPort}`}>
              Set with <code>PILOTAGE_LAN_BIND</code>. Only these networks may connect: {(net.allowList || []).join(', ') || 'none'}.
            </CheckLine>
            <CheckLine state={net.addresses.some((x) => x.kind === 'netbird' || x.kind === 'tailscale') ? 'ok' : 'off'} title="NetBird or Tailscale">
              Works from anywhere, and the connection is encrypted. Without it, phones must be on the same network.
            </CheckLine>
          </div>
        ) : (
          <Callout icon={<ShieldCheck />} title="Phone access is off">
            On Linux and macOS there is no Windows forwarder. Start Pilotage with <code>PILOTAGE_LAN_BIND=0.0.0.0</code> to let phones on your network and VPN
            connect (port {net.lanPort}). See docs/PHONE.md.
          </Callout>
        )}
        <Disclosure summary="How your connection is protected">
          <ul className="plain-list small muted">
            <li>Every page and request needs a paired-device sign-in. Pairing codes work once and expire after 10 minutes.</li>
            <li>Pairing, devices and keys can only be changed from this computer, never from a phone.</li>
            <li>Connections from other networks are refused before any data is read. Use your OS firewall as a second gate.</li>
            <li>Use the https address (see “Install Pilotage as an app”) so traffic on your Wi-Fi is encrypted.</li>
          </ul>
        </Disclosure>
      </div>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------- install as an app (HTTPS)
function InstallAppCard() {
  const viaLan = useViaLan();
  const { data, error, isLoading } = useTls(!viaLan);
  return (
    <SettingsCard
      title="Install Pilotage as an app"
      icon={<AppWindow />}
      description="Phones only offer “Install app” on a secure (https) address. Install the Pilotage certificate on the phone once, then open the https address. Plain http keeps working."
    >
      {error ? (
        <ErrorBox error={error} />
      ) : isLoading || !data ? (
        <div className="stack" aria-busy="true">
          <Skeleton h={18} w="50%" />
          <Skeleton h={120} w="100%" />
        </div>
      ) : !data.ready ? (
        <Callout tone="warn" icon={<TriangleAlert />} title="HTTPS isn't available">
          {data.error || 'The certificate is being created. Check again in a minute.'}
        </Callout>
      ) : viaLan ? (
        <PhoneInstall info={data} />
      ) : (
        <PcInstall info={data} />
      )}
    </SettingsCard>
  );
}

function Fingerprint({ value }: { value: string | null }) {
  if (!value) return null;
  return (
    <div className="stack-sm">
      <div className="spread">
        <span className="sub-label">Certificate fingerprint (SHA-256)</span>
        <CopyButton text={value} />
      </div>
      <code className="mono tiny break">{value}</code>
      <div className="hint">After installing, the phone shows it under the certificate's details (Trusted credentials › User). It must match.</div>
    </div>
  );
}

/** PC: QR codes for the phone (certificate over http, then the https address), steps, fallback. */
function PcInstall({ info }: { info: TlsInfo }) {
  const key = (u: TlsInfo['urls'][number]) => `${u.kind}-${u.ip}`;
  const [pick, setPick] = useState<string | null>(null);
  const sel = info.urls.find((u) => key(u) === pick) || info.urls[0];
  return (
    <div className="stack-lg">
      {info.urls.length > 1 && (
        <SegmentedControl size="sm" label="Network" value={sel ? key(sel) : ''} onChange={setPick} options={info.urls.map((u) => ({ value: key(u), label: kindLabel(u.kind), title: u.ip }))} />
      )}
      {!sel ? (
        <Callout tone="warn" icon={<TriangleAlert />} title="No Wi-Fi or NetBird address found">
          Connect the PC to Wi-Fi or NetBird, then come back here.
        </Callout>
      ) : (
        <div className="pair-grid">
          <div className="pair-item">
            <span className="medium">1 · Get the certificate</span>
            {sel.caQr && <div className="qr" role="img" aria-label="QR code to download the Pilotage certificate" dangerouslySetInnerHTML={{ __html: sel.caQr }} />}
            <div className="mono tiny break faint">{sel.caUrl}</div>
            <div>
              <CopyButton text={sel.caUrl} label="Copy link" />
            </div>
          </div>
          <div className="pair-item">
            <span className="medium">2 · Open the secure address</span>
            {sel.httpsQr && <div className="qr" role="img" aria-label="QR code for the https address" dangerouslySetInnerHTML={{ __html: sel.httpsQr }} />}
            <div className="mono tiny break faint">{sel.https}</div>
            <div>
              <CopyButton text={sel.https} label="Copy link" />
            </div>
          </div>
        </div>
      )}
      <InstallSteps info={info} />
      <Fingerprint value={info.fingerprint} />
      <div className="hint">
        <a href="/pilotage-ca.crt" download>
          Download the certificate
        </a>{' '}
        to install it on another device. Server certificate valid until {info.leafValidTo ? fmtDate(info.leafValidTo) : '?'} (renewed automatically).
        {info.handshakeFailures > 0 && info.lastHandshakeFailure && (
          <> A device refused the certificate {ago(info.lastHandshakeFailure.at)}: it doesn't have the Pilotage certificate (yet).</>
        )}
      </div>
    </div>
  );
}

/** Phone: one-tap steps on http; the install button once on https. */
function PhoneInstall({ info }: { info: TlsInfo }) {
  const [, force] = useState(0);
  useEffect(() => onInstallPromptChange(() => force((n) => n + 1)), []);
  const prompt = installPrompt();
  const toast = useToast();
  const secureHere = `https://${window.location.host}/`;
  if (isStandalone())
    return (
      <Callout tone="ok" icon={<CheckCircle2 />} title="You're using the installed app">
        Pilotage opens from its icon on your home screen.
      </Callout>
    );
  if (window.isSecureContext)
    return (
      <div className="stack">
        <Callout
          tone="ok"
          icon={<Lock />}
          title="Secure connection"
          action={
            prompt ? (
              <Button
                variant="accent"
                icon={<Download />}
                onClick={async () => {
                  await prompt.prompt();
                  const r = await prompt.userChoice.catch(() => null);
                  if (r?.outcome === 'accepted') toast('Pilotage is being added to your home screen');
                }}
              >
                Install app
              </Button>
            ) : null
          }
        >
          {prompt ? 'Pilotage can be installed on this phone.' : 'In Chrome: menu ⋮, then Install app (or Add to Home screen). On iPhone: Share, then Add to Home Screen.'}
        </Callout>
      </div>
    );
  return (
    <div className="stack-lg">
      <ol className="pair-steps">
        <li>
          <a className="btn sm" href="/pilotage-ca.crt" download>
            <Download size={14} aria-hidden="true" />
            Download the certificate
          </a>
        </li>
        <li>
          Android: Settings › Security &amp; privacy › More security settings › Encryption &amp; credentials › Install a certificate › <b className="medium">CA certificate</b> › Install anyway, then pick{' '}
          <code>pilotage-ca.crt</code> from Downloads. (Names vary by brand: search Settings for “CA certificate”.)
        </li>
        <li>
          <a className="btn sm accent" href={secureHere}>
            <ExternalLink size={14} aria-hidden="true" />
            Open the secure address
          </a>
        </li>
        <li>In Chrome: menu ⋮, then Install app.</li>
      </ol>
      <Disclosure summary="iPhone steps">
        <IphoneSteps />
      </Disclosure>
      <FlagFallback info={info} />
      <Fingerprint value={info.fingerprint} />
    </div>
  );
}

function IphoneSteps() {
  return (
    <ol className="pair-steps small">
      <li>Open the certificate link in Safari and tap Allow (it downloads a profile).</li>
      <li>Settings › General › VPN &amp; Device Management › the Pilotage profile › Install.</li>
      <li>Settings › General › About › Certificate Trust Settings › turn on the Pilotage certificate.</li>
      <li>Open the secure address in Safari, then Share › Add to Home Screen.</li>
    </ol>
  );
}

function InstallSteps({ info }: { info: TlsInfo }) {
  return (
    <div className="stack-sm">
      <Disclosure summary="Android steps" defaultOpen>
        <ol className="pair-steps small">
          <li>Scan code 1. Chrome saves pilotage-ca.crt to Downloads (it can't install certificates itself).</li>
          <li>
            Settings › Security &amp; privacy › More security settings › Encryption &amp; credentials › Install a certificate › <b className="medium">CA certificate</b> › Install anyway, then
            pick pilotage-ca.crt. Names vary by brand: search Settings for “CA certificate”.
          </li>
          <li>Scan code 2 to open Pilotage on https. If it says the phone isn't paired, pair it again with the https code (Devices › Pair a phone).</li>
          <li>In Chrome: menu ⋮, then Install app (or Add to Home screen).</li>
        </ol>
      </Disclosure>
      <Disclosure summary="iPhone steps">
        <IphoneSteps />
      </Disclosure>
      <FlagFallback info={info} />
    </div>
  );
}

/** Android Chrome without the certificate: tell Chrome these http addresses count as secure. */
function FlagFallback({ info }: { info: TlsInfo }) {
  const origins = info.urls.map((u) => u.http).join(',');
  return (
    <Disclosure summary="No certificate? Chrome flag fallback (Android)">
      <div className="stack-sm small muted">
        <p style={{ margin: 0 }}>
          In Chrome, open <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>, paste the addresses below, set it to Enabled and relaunch Chrome. Install app
          then works on plain http.
        </p>
        {origins && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <code className="mono tiny break grow">{origins}</code>
            <CopyButton text={origins} />
          </div>
        )}
        <p style={{ margin: 0 }}>
          Trade-off: the traffic stays unencrypted on Wi-Fi (NetBird is still encrypted), Chrome trusts anything answering at those addresses, and the flag is easy to lose
          (Chrome resets experiments now and then). The certificate is the better way.
        </p>
      </div>
    </Disclosure>
  );
}

// ---------------------------------------------------------------- devices
function DevicesCard() {
  const { data, error, isLoading } = useDevices();
  const viaLan = useViaLan();
  const [pairing, setPairing] = useState<{ known: string[] | null } | null>(null);
  const current = data?.current;
  const devices = useMemo(() => (data?.devices || []).slice().sort((a, b) => Number(b.id === current) - Number(a.id === current) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0)), [data, current]);
  return (
    <SettingsCard
      title="Devices"
      icon={<MonitorSmartphone />}
      description="Browsers allowed to open Pilotage. Revoke any you don't recognise."
      actions={
        viaLan ? (
          <PcOnly />
        ) : (
          <Button icon={<QrCode />} onClick={() => setPairing({ known: data ? data.devices.map((d) => d.id) : null })}>
            Pair a phone
          </Button>
        )
      }
      flush
    >
      {error ? (
        <div className="scard-pad">
          <ErrorBox error={error} />
        </div>
      ) : isLoading ? (
        <div className="scard-pad stack" aria-busy="true">
          <Skeleton h={16} w="40%" />
          <Skeleton h={12} w="30%" />
        </div>
      ) : devices.length === 0 ? (
        <EmptyState compact icon={<Smartphone />} title="No paired devices yet" />
      ) : (
        <div className="list">
          {devices.map((d) => (
            <DeviceRow key={d.id} d={d} current={d.id === current} readOnly={viaLan} twin={devices.some((x) => x.id !== d.id && x.name.trim().toLowerCase() === d.name.trim().toLowerCase())} />
          ))}
        </div>
      )}
      {pairing && <PairModal known={pairing.known} onClose={() => setPairing(null)} />}
    </SettingsCard>
  );
}

const looksLikePhone = (s: string) => /android|iphone|ipad|mobile|tablet/i.test(s);

/** `twin`: another device has the same name (two "Android phone · Chrome"), so the added date shows the time too. */
function DeviceRow({ d, current, readOnly, twin }: { d: Device; current: boolean; readOnly: boolean; twin: boolean }) {
  const inv = useInvalidate();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(d.name);
  const [busy, setBusy] = useState<string | null>(null);
  const phone = looksLikePhone(`${d.ua} ${d.name}`);

  const save = async () => {
    const n = name.trim();
    if (!n || n === d.name) return setEditing(false);
    setBusy('save');
    try {
      await api(`/api/devices/${d.id}`, { method: 'PATCH', body: { name: n } });
      inv('devices', 'bootstrap');
      toast('Device renamed');
      setEditing(false);
    } catch (e) {
      toast(`Couldn't rename: ${errMsg(e)}`, true);
    } finally {
      setBusy(null);
    }
  };
  const revoke = async () => {
    const msg = current
      ? `Revoke “${d.name}”?\n\nThis is the browser you're using right now. It is signed out immediately and must be paired again (on the PC: run “pilotage open”).`
      : `Revoke “${d.name}”?\n\nIt loses access to Pilotage until you pair it again.`;
    if (!window.confirm(msg)) return;
    setBusy('revoke');
    try {
      await api(`/api/devices/${d.id}`, { method: 'DELETE' });
      toast(`“${d.name}” can no longer open Pilotage`);
      inv('devices');
    } catch (e) {
      toast(`Couldn't revoke: ${errMsg(e)}`, true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="lrow device-row">
      <div className="lrow-lead">
        <span className="icon-tile" aria-hidden="true">
          {phone ? <Smartphone size={16} /> : <Monitor size={16} />}
        </span>
      </div>
      <div className="lrow-body">
        {editing ? (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <input
              className="input"
              value={name}
              maxLength={60}
              autoFocus
              aria-label="Device name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setEditing(false);
                }
              }}
            />
            <Button type="submit" size="sm" loading={busy === 'save'} disabled={!name.trim()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <div className="lrow-title">
              <span className="t">{d.name}</span>
              {current && (
                <span className="chip device-this" title="The browser you’re using right now">
                  This device
                </span>
              )}
            </div>
            <Meta
              items={[
                <span title={`Added ${fmtDateTime(d.createdAt)}`}>added {twin ? fmtDateTime(d.createdAt) : fmtDate(d.createdAt)}</span>,
                <span title={`Last seen ${fmtDateTime(d.lastSeenAt)}`}>last seen {current ? 'now' : ago(d.lastSeenAt)}</span>,
                d.via === 'pair' ? 'paired with a QR code' : d.via === 'desktop' ? 'PC sign-in link' : null,
              ]}
            />
          </>
        )}
      </div>
      {!editing && !readOnly && (
        <div className="lrow-trail">
          <IconButton icon={<Pencil />} label={`Rename ${d.name}`} onClick={() => (setName(d.name), setEditing(true))} disabled={!!busy} />
          <IconButton icon={busy === 'revoke' ? <Spinner size={14} /> : <Trash2 />} label={`Revoke ${d.name}`} className="danger-icon" onClick={revoke} disabled={!!busy} />
        </div>
      )}
    </div>
  );
}

function PairModal({ known, onClose }: { known: string[] | null; onClose: () => void }) {
  const [pair, setPair] = useState<PairResp | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [scheme, setScheme] = useState<'http' | 'https' | null>(null);
  const started = useRef(false);
  const knownRef = useRef<Set<string> | null>(known ? new Set(known) : null);
  const a = useNetActions();
  const { net } = useNetStatus();

  const request = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setPair(await api<PairResp>('/api/devices/pair', { method: 'POST' }));
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    request();
  }, [request]);

  // Poll the device list while the modal is open so the new phone shows up.
  const devQ = useQuery({ queryKey: ['devices'], queryFn: () => api<DevicesResp>('/api/devices'), refetchInterval: 3000 });
  useEffect(() => {
    if (!knownRef.current && devQ.data) knownRef.current = new Set(devQ.data.devices.map((d) => d.id));
  }, [devQ.data]);
  const fresh = knownRef.current && devQ.data ? devQ.data.devices.filter((d) => !knownRef.current!.has(d.id)) : [];

  const now = useNow(1000, !!pair);
  const left = pair ? Math.max(0, pair.expiresAt - now) : 0;
  const expired = !!pair && left <= 0;
  const mmss = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
  const direct = !!net?.mode && net.mode !== 'forwarder';
  const fwRunning = direct || (net?.forwarder?.running ?? pair?.forwarder?.running ?? true);
  const fwRule = direct || (net?.firewallRule ?? pair?.firewallRule ?? true);
  const shownScheme = scheme || pair?.scheme || 'http';
  const links = !pair ? [] : shownScheme === (pair.scheme || 'http') || !pair.alt?.length ? pair.urls : pair.alt;

  return (
    <Modal
      title="Pair a phone"
      onClose={onClose}
      wide
      footer={
        <>
          {pair && (
            <Button variant="ghost" icon={<RefreshCw />} loading={loading} onClick={request}>
              New code
            </Button>
          )}
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <div className="modal-body">
        {fresh.length > 0 && (
          <Callout tone="ok" icon={<CheckCircle2 />} title={`${fresh.map((d) => d.name).join(', ')} ${fresh.length === 1 ? 'is' : 'are'} paired`}>
            You can rename it in the device list, then close this window.
          </Callout>
        )}
        <ol className="pair-steps">
          <li>Phone on your trusted home Wi-Fi, or NetBird on.</li>
          <li>Scan the code with the phone's camera.</li>
          <li>{shownScheme === 'https' ? 'In Chrome: menu ⋮, then Install app.' : 'To install it as an app, see “Install Pilotage as an app” in these settings.'}</li>
        </ol>
        {!!pair?.alt?.length && (
          <div className="stack-sm">
            <SegmentedControl
              size="sm"
              label="Link type"
              value={shownScheme}
              onChange={(v) => setScheme(v)}
              options={[
                { value: 'https', label: 'Secure (https)', title: 'Needs the Pilotage certificate on the phone' },
                { value: 'http', label: 'Plain (http)', title: 'Works on any phone' },
              ]}
            />
            <div className="hint">
              {shownScheme === 'https'
                ? 'The https code needs the Pilotage certificate on the phone first (“Install Pilotage as an app”). A phone without it shows a warning: use the http code instead.'
                : 'Works on any phone. Install the certificate later to switch to https and install the app.'}
            </div>
          </div>
        )}
        {!fwRule ? (
          <Callout
            tone="warn"
            icon={<TriangleAlert />}
            title="Phone access isn't enabled yet"
            action={
              <Button size="sm" icon={<ShieldCheck />} loading={a.busy === 'enable'} onClick={a.enable}>
                Enable
              </Button>
            }
          >
            Windows Firewall blocks phones. Enable it once (Windows asks for admin approval), then scan.
          </Callout>
        ) : (
          !fwRunning && (
            <Callout
              tone="warn"
              icon={<TriangleAlert />}
              title="The forwarder isn't running"
              action={
                <Button size="sm" icon={<Play />} loading={a.busy === 'start'} onClick={a.start}>
                  Start
                </Button>
              }
            >
              The phone can't reach this PC until it runs.
            </Callout>
          )
        )}
        {err ? (
          <div className="stack">
            <ErrorBox error={err} />
            <div>
              <Button size="sm" loading={loading} onClick={request}>
                Try again
              </Button>
            </div>
          </div>
        ) : !pair ? (
          <div className="row muted">
            <Spinner /> Creating a pairing code…
          </div>
        ) : (
          <>
            <div className={`pair-timer${expired ? ' expired' : ''}`}>
              <Clock size={15} aria-hidden="true" />
              {expired ? (
                <span>This code has expired.</span>
              ) : (
                <span>
                  Code valid for <span className="num bold">{mmss}</span>
                </span>
              )}
              {expired && (
                <Button size="sm" loading={loading} onClick={request}>
                  Get a new code
                </Button>
              )}
            </div>
            {links.length === 0 ? (
              <Callout tone="warn" icon={<TriangleAlert />} title="No Wi-Fi or NetBird address found">
                <div className="stack">
                  <span>
                    Check that Wi-Fi is connected, or run <code>pilotage status</code>. This link only works on the PC itself:
                  </span>
                  <code className="break">{pair.primary}</code>
                  <div>
                    <CopyButton text={pair.primary} label="Copy link" />
                  </div>
                </div>
              </Callout>
            ) : (
              <div className={`pair-grid${expired ? ' expired' : ''}`}>
                {links.map((u) => (
                  <div key={u.url} className="pair-item">
                    <div className="spread">
                      <span className="medium">{kindLabel(u.kind)}</span>
                      <span className="tiny faint truncate" title={u.adapter}>
                        {u.adapter}
                      </span>
                    </div>
                    {/* SVG is generated server-side by the qrcode library (trusted). */}
                    <div className="qr" role="img" aria-label={`QR code for the ${kindLabel(u.kind)} pairing link`} dangerouslySetInnerHTML={{ __html: u.qr }} />
                    <div className="mono tiny break faint">{u.url}</div>
                    <div>
                      <CopyButton text={u.url} label="Copy link" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="hint">Each code works once and expires after 10 minutes. Use the NetBird code when the phone is away from home.</div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- desktop key
function DesktopKeyCard() {
  const viaLan = useViaLan();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const rotate = async () => {
    if (
      !window.confirm(
        'Rotate the desktop key?\n\nThe pilotage command keeps working. Anything that copied the old key (scripts, old shortcuts) stops working right away. Paired phones are not affected.',
      )
    )
      return;
    setBusy(true);
    try {
      await api('/api/security/rotate-key', { method: 'POST' });
      toast('Desktop key rotated');
    } catch (e) {
      toast(`Couldn't rotate the key: ${errMsg(e)}`, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsCard title="Desktop key" icon={<KeyRound />}>
      <SettingRows>
        <SettingRow label="Rotate desktop key" hint="The pilotage command and the Desktop shortcut sign in with a key stored on this PC. Rotate it if you think it leaked.">
          {viaLan ? (
            <PcOnly />
          ) : (
            <Button variant="danger" icon={<RefreshCw />} loading={busy} onClick={rotate}>
              Rotate key
            </Button>
          )}
        </SettingRow>
      </SettingRows>
    </SettingsCard>
  );
}
