'use client';

import { useEffect, useState } from 'react';
import { Button, Input, PasswordInput, Select, SegmentedControl, StatusBadge, StatusSquare } from '@/components/ui';
import type { AnyTone } from '@/components/ui';
import { SettingsRow } from './SettingsRow';
import { HermesRelayRow } from './HermesRelayRow';
import type { AppSettings, } from './types';
import type { HermesConnection, HermesMode } from '@/types/electron';

/** Row actions are words, not glyphs: 26px bordered lowercase mono. */
const ROW_ACTION = 'font-mono lowercase';

const MODES: { value: HermesMode; label: string; title: string }[] = [
  { value: 'local', label: 'Local', title: 'Hermes runs on this machine' },
  { value: 'ssh', label: 'SSH', title: 'Tunnel to a box over SSH' },
  { value: 'remote', label: 'Remote', title: 'Reach a gateway by URL (Tailscale, LAN…)' },
  { value: 'cloud', label: 'Cloud', title: 'Hosted gateway with an org' },
];

interface HermesSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
  onUpdateLocalSettings: (updates: Partial<AppSettings>) => void;
}

interface ConnectionInfo {
  apiPort: number;
  webhookPath: string;
  webhookLocalUrl: string;
  webhookTailnetUrl?: string;
  apiToken: string;
  tailscale: { installed: boolean; running: boolean; dnsName?: string; ip?: string; serveConfigured: boolean };
  serveCommand: string;
}

const AUTH_MODES = [
  { value: 'token' as const, label: 'Token' },
  { value: 'oauth' as const, label: 'OAuth' },
];

/**
 * What the Status badge says. A gateway that answered but wants a sign-in is
 * signed out, not unreachable: the page's result is not a success then, and
 * the badge read that as "unreachable" in the error tone. `needsSignIn` is the
 * test's own answer, the one the Chat keys its `needs_sign_in` on. Frame:
 * `row Status · signed out` (zBCak) in `Settings · Connection`.
 */
export function gatewayStatus(
  testing: boolean,
  result: { success: boolean } | null,
  needsSignIn: boolean,
): { word: string; tone: AnyTone } {
  if (testing) return { word: 'checking', tone: result ? (result.success ? 'running' : 'error') : 'idle' };
  if (!result) return { word: 'unknown', tone: 'idle' };
  if (needsSignIn) return { word: 'signed out', tone: 'waiting' };
  return result.success ? { word: 'connected', tone: 'running' } : { word: 'unreachable', tone: 'error' };
}

export const HermesSection = ({ appSettings, onSaveAppSettings }: HermesSectionProps) => {
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const [conn, setConn] = useState<HermesConnection>({ mode: 'local', localPort: 9119, authMode: 'token' });
  const [savedConn, setSavedConn] = useState<string>('');
  const [desktopAvailable, setDesktopAvailable] = useState(false);
  const [gatewayTesting, setGatewayTesting] = useState(false);
  const [gatewayResult, setGatewayResult] = useState<{ success: boolean; message: string } | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  // Until the first probe lands we do not know whether we are signed in, and
  // "unknown" must not render as "signed out".
  const [authChecked, setAuthChecked] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  // The last import came without the token Hermes Desktop keeps encrypted. Said
  // until something answers it: a sign-in, a token typed in, another import.
  const [tokenNotImported, setTokenNotImported] = useState(false);
  const connDirty = JSON.stringify(conn) !== savedConn;

  /**
   * Whether we are signed in is not local knowledge: it depends on the gateway
   * and on the session cookie the main process keeps in
   * ~/.dorothy/hermes-session.json. This effect used to read the connection and
   * stop there, so `signedIn` stayed false until the user pressed Test - which
   * is why leaving this section and coming back offered a sign-in form for a
   * gateway Tars was already signed in to. One probe on mount settles it, and
   * `authChecked` holds the row indeterminate until it lands instead of
   * flashing the sign-in form first.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await window.electronAPI?.hermes?.getConnection();
      if (cancelled) return;
      if (!r) { setAuthChecked(true); return; }
      setConn(r.connection);
      // A base URL comes only with a gateway a connection file names. Without
      // one the form shows the default, which is not saved: Save writes it as
      // it stands, the one way a local Hermes on that port is reached.
      setSavedConn(r.baseUrl ? JSON.stringify(r.connection) : '');
      setDesktopAvailable(r.desktopConfigAvailable);
      // Nothing configured to call yet (no connection file that names a
      // gateway, or remote/cloud without a URL): there is no probe to make, so
      // let the row show its normal form.
      if (!r.baseUrl) { setAuthChecked(true); return; }
      await probeGateway(r.connection);
    })();
    return () => { cancelled = true; };
  }, []);

  function patchConn(patch: Partial<HermesConnection>) {
    setConn(prev => ({ ...prev, ...patch }));
    if (patch.token || (patch.mode && patch.mode !== conn.mode)) setTokenNotImported(false);
    setGatewayResult(null);
  }
  function patchSsh(patch: Partial<NonNullable<HermesConnection['ssh']>>) {
    setConn(prev => ({ ...prev, ssh: { host: '', user: '', ...prev.ssh, ...patch } }));
    setGatewayResult(null);
  }

  async function handleImportDesktop() {
    const r = await window.electronAPI?.hermes?.importDesktopConnection();
    if (r?.success && r.connection) {
      setConn(r.connection);
      setSavedConn(JSON.stringify(r.connection));
      setTokenNotImported(!!r.tokenNotImported);
      setGatewayResult({ success: true, message: `Imported from Hermes Desktop - ${r.baseUrl}` });
    } else {
      setGatewayResult({ success: false, message: r?.error || 'Import failed' });
    }
  }

  async function handleSignIn() {
    setSigningIn(true);
    try {
      const r = await window.electronAPI?.hermes?.signIn({ connection: conn, username, password });
      if (r?.success) {
        setNeedsSignIn(false);
        setSignedIn(true);
        setTokenNotImported(false);
        setPassword('');
        setGatewayResult({ success: true, message: `Signed in - Hermes ${r.version ?? ''} ${r.gatewayState ?? ''}`.trim() });
      } else {
        setGatewayResult({ success: false, message: r?.error || 'Sign-in failed' });
      }
    } finally {
      setSigningIn(false);
    }
  }

  async function handleSaveConn() {
    const r = await window.electronAPI?.hermes?.saveConnection(conn);
    if (r?.success) setSavedConn(JSON.stringify(conn));
    else setGatewayResult({ success: false, message: r?.error || 'Save failed' });
  }

  const refreshInfo = () => {
    setLoading(true);
    window.electronAPI?.hermes?.getConnectionInfo()
      .then(i => setInfo(i))
      .finally(() => setLoading(false));
  };

  useEffect(refreshInfo, []);

  /**
   * The one reading of the gateway, used by the mount probe and by Test, so
   * the two can never disagree about what "signed in" means.
   */
  async function probeGateway(target: HermesConnection) {
    setGatewayTesting(true);
    setGatewayResult(null);
    try {
      const r = await window.electronAPI?.hermes?.testConnection(target);
      if (!r) {
        setSignedIn(false);
        setNeedsSignIn(false);
        setGatewayResult({ success: false, message: 'Electron API unavailable' });
        return;
      }
      // A gateway that answers but demands a sign-in is reachable, not broken:
      // it still reports its version and which sign-in it wants. Keying the
      // early return on `success` swallowed that answer.
      const reachable = !r.error && typeof r.status === 'number' && r.status > 0 && r.status < 500;
      if (!reachable) {
        setSignedIn(false);
        setNeedsSignIn(false);
        setGatewayResult({ success: false, message: `${r.baseUrl || ''} - ${r.error || `HTTP ${r.status}`}` });
        return;
      }
      const bits = [`Hermes ${r.version ?? '?'}`];
      if (r.gatewayState) bits.push(r.gatewayState);
      setNeedsSignIn(!!r.needsSignIn);
      setSignedIn(!!r.signedIn);
      if (r.needsSignIn) bits.push(`sign-in required (${(r.authProviders || []).join(', ') || 'cookie'})`);
      else if (r.authRequired) bits.push('signed in');
      else bits.push('open');
      setGatewayResult({ success: !r.needsSignIn, message: `${r.baseUrl} · ${bits.join(' · ')}` });
    } finally {
      setGatewayTesting(false);
      setAuthChecked(true);
    }
  }

  const handleTestGateway = () => probeGateway(conn);

  const webhookUrl = info?.tailscale.serveConfigured && info.webhookTailnetUrl
    ? info.webhookTailnetUrl
    : info?.webhookTailnetUrl ?? info?.webhookLocalUrl ?? '';

  // The gateway URL is only typed in for remote and cloud; for local and SSH it
  // falls out of the port, so the row shows the address Tars will actually call.
  const derivedUrl = conn.mode === 'ssh'
    ? `http://127.0.0.1:${conn.ssh?.localPort ?? conn.ssh?.remotePort ?? 9119}`
    : `http://127.0.0.1:${conn.localPort ?? 9119}`;
  const typedUrl = conn.mode === 'remote' || conn.mode === 'cloud';

  const { word: statusWord, tone: statusTone } = gatewayStatus(gatewayTesting, gatewayResult, needsSignIn);

  // What Tailscale is doing decides whether a VPS can reach the webhook at all,
  // so it stays - as the row's one muted line, not as a panel of prose.
  const tailscaleLine = !info
    ? 'reading the tailnet…'
    : info.tailscale.serveConfigured
      ? `tailscale serve active${info.tailscale.dnsName ? ` · ${info.tailscale.dnsName}` : ''}`
      : info.tailscale.running
        ? 'tailscale running · the API still only listens on localhost'
        : info.tailscale.installed
          ? 'tailscale installed but not running'
          : 'no tailscale · a VPS cannot reach this machine';

  return (
    <>
      <SettingsRow
        label="Mode"
        description={MODES.find(m => m.value === conn.mode)?.title}
        control={
          <SegmentedControl
            ariaLabel="Hermes connection mode"
            options={MODES}
            value={conn.mode}
            onChange={mode => patchConn({ mode })}
          />
        }
      />

      <SettingsRow
        label="Gateway URL"
        description={typedUrl ? 'Where the Hermes gateway answers.' : 'Derived from the port below. Switch to Remote to type a URL.'}
        wrap
        control={
          <div className="flex items-center gap-2 w-full">
            <Input
              mono
              className="min-w-0 flex-1"
              value={typedUrl ? (conn.url || '') : derivedUrl}
              onChange={e => patchConn({ url: e.target.value })}
              readOnly={!typedUrl}
              placeholder={conn.mode === 'cloud' ? 'https://gateway.hermes.cloud' : 'http://100.x.y.z:9119'}
            />
            {desktopAvailable && (
              <Button
                size="sm"
                variant="ghost"
                className={ROW_ACTION}
                onClick={handleImportDesktop}
                title="Reuse the connection configured in Hermes Desktop"
              >
                import
              </Button>
            )}
          </div>
        }
      />

      {/* Frame: row Import · token not imported, the notice of the template
          import review (JezkD) as a row of its own. */}
      {tokenNotImported && (
        <div className="px-4 py-[11px]">
          <div className="flex items-start gap-2 border border-border bg-secondary px-3 py-2">
            <StatusSquare tone="waiting" className="mt-[5px]" />
            <p className="text-xs text-foreground">Token not imported: Hermes Desktop keeps it encrypted. Sign in or paste it.</p>
          </div>
        </div>
      )}

      {conn.mode === 'local' && (
        <SettingsRow
          label="Gateway port"
          description="The port Hermes listens on here."
          control={
            <Input
              mono
              width="control"
              type="number"
              value={conn.localPort ?? 9119}
              onChange={e => patchConn({ localPort: Number(e.target.value) || 9119 })}
            />
          }
        />
      )}

      {conn.mode === 'ssh' && (
        <>
          <SettingsRow
            label="SSH host"
            description="Tars reads the gateway through the tunnel on 127.0.0.1."
            control={
              <div className="flex items-center gap-2 w-full">
                <Input mono className="min-w-0 flex-1" value={conn.ssh?.host || ''} onChange={e => patchSsh({ host: e.target.value })} placeholder="vps.example.com" />
                <Input mono className="w-24 shrink-0" value={conn.ssh?.user || ''} onChange={e => patchSsh({ user: e.target.value })} placeholder="root" />
              </div>
            }
          />
          <SettingsRow
            label="Ports"
            description="SSH port, remote gateway port, local end of the tunnel."
            control={
              <div className="flex items-center gap-2 w-full">
                <Input mono type="number" title="SSH port" className="min-w-0 flex-1" value={conn.ssh?.port ?? 22} onChange={e => patchSsh({ port: Number(e.target.value) || 22 })} />
                <Input mono type="number" title="Remote port" className="min-w-0 flex-1" value={conn.ssh?.remotePort ?? 9119} onChange={e => patchSsh({ remotePort: Number(e.target.value) || 9119 })} />
                <Input mono type="number" title="Local port" className="min-w-0 flex-1" value={conn.ssh?.localPort ?? conn.ssh?.remotePort ?? 9119} onChange={e => patchSsh({ localPort: Number(e.target.value) || undefined })} />
              </div>
            }
          />
          <SettingsRow
            label="Private key"
            description="Optional - leave empty to use your agent."
            control={
              <Input mono width="control" value={conn.ssh?.keyPath || ''} onChange={e => patchSsh({ keyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" />
            }
          />
        </>
      )}

      {conn.mode === 'cloud' && (
        <SettingsRow
          label="Organisation"
          description="The org this gateway belongs to."
          control={
            <Input mono width="control" value={conn.org || ''} onChange={e => patchConn({ org: e.target.value })} placeholder="my-org" />
          }
        />
      )}

      {typedUrl && (
        <SettingsRow
          label="Auth"
          description={
            (conn.authMode || 'token') === 'oauth'
              ? "The gateway's own sign-in. Use the row below."
              : 'A static session token, sent as X-Hermes-Session-Token.'
          }
          control={
            <div className="flex items-center gap-2 w-full justify-end">
              {/* Two mutually exclusive choices, so a segmented control - not a
                  dropdown you have to open to see what the other option is. */}
              <SegmentedControl
                options={AUTH_MODES}
                value={(conn.authMode || 'token') as 'token' | 'oauth'}
                onChange={value => patchConn({ authMode: value })}
                ariaLabel="Hermes auth mode"
              />
              {/* Only in token mode. Rendering it disabled under OAuth left a
                  dead field with a `show` affordance next to it, which read as
                  a broken button - OAuth has no static token to reveal. */}
              {(conn.authMode || 'token') === 'token' && (
                <PasswordInput
                  className="min-w-0 flex-1"
                  value={conn.token || ''}
                  onChange={e => patchConn({ token: e.target.value })}
                  placeholder="X-Hermes-Session-Token"
                />
              )}
            </div>
          }
        />
      )}

      {/* Cookie-gated gateways need a real sign-in; the session lives in the
          main process and is reused for every Hermes call (kanban included). */}
      <SettingsRow
        label="Sign in"
        description={
          !authChecked
            ? 'Asking the gateway whether this session is still signed in…'
            : signedIn
              ? 'Signed in to this gateway - only the session cookie is kept, in the main process.'
              : needsSignIn
                ? 'This gateway requires a sign-in. Credentials go straight to it and are never stored.'
                : 'Credentials go straight to your gateway and are never stored.'
        }
        control={
          /* Indeterminate until the mount probe answers: rendering the form
             here would claim we are signed out before we have asked. */
          !authChecked ? (
            <StatusBadge tone="idle" className="font-mono">
              <StatusSquare tone="idle" />
              checking
            </StatusBadge>
          ) : signedIn ? (
            <Button
              size="sm"
              variant="ghost"
              className={ROW_ACTION}
              onClick={async () => { await window.electronAPI?.hermes?.signOut(conn); setSignedIn(false); setNeedsSignIn(true); }}
            >
              sign out
            </Button>
          ) : (
            <div className="flex items-center gap-2 w-full">
              <Input
                mono
                className="min-w-0 flex-1"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="user"
              />
              <PasswordInput
                className="min-w-0 flex-1"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSignIn(); }}
                placeholder="password"
              />
              <Button
                variant="primary"
                size="md"
                onClick={handleSignIn}
                disabled={signingIn || !username.trim() || !password}
              >
                {signingIn ? 'Signing in' : 'Sign in'}
              </Button>
            </div>
          )
        }
      />

      <SettingsRow
        label="Status"
        description={gatewayResult?.message ?? 'Not probed yet - test the connection to read the version and the sign-in it demands.'}
        control={
          <div className="flex items-center gap-2 w-full justify-end">
            <StatusBadge tone={statusTone} className="font-mono">
              <StatusSquare tone={statusTone} />
              {statusWord}
            </StatusBadge>
            <Button size="sm" className={ROW_ACTION} onClick={handleTestGateway} disabled={gatewayTesting}>
              {gatewayTesting ? 'testing' : 'test'}
            </Button>
            <Button size="sm" className={ROW_ACTION} onClick={handleSaveConn} disabled={!connDirty}>
              save
            </Button>
          </div>
        }
      />

      <SettingsRow
        label="Incoming webhook"
        description={tailscaleLine}
        control={
          <div className="flex items-center gap-2 w-full">
            <Input
              mono
              readOnly
              className="min-w-0 flex-1"
              value={webhookUrl}
              placeholder={loading ? 'detecting…' : 'unavailable'}
              onFocus={e => e.currentTarget.select()}
            />
            <Button
              size="sm"
              variant="ghost"
              className={ROW_ACTION}
              disabled={!info}
              title="Copy the bearer token Hermes must send in the Authorization header"
              onClick={() => {
                if (!info) return;
                navigator.clipboard.writeText(info.apiToken);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'copied' : 'copy secret'}
            </Button>
          </div>
        }
      />

      {/* Telegram through Hermes, after the webhook as the frame draws it. */}
      <HermesRelayRow
        enabled={appSettings.hermesRelayEnabled === true}
        onSave={on => onSaveAppSettings({ hermesRelayEnabled: on })}
      />
    </>
  );
};
