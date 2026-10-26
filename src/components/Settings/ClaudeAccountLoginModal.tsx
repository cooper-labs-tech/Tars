'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, DialogShell, FieldError, Input, Label, StatusSquare } from '@/components/ui';
import type { ElectronAPI } from '@/types/electron';
import { useClaudeAccounts } from '@/hooks/useClaudeAccounts';
import { suggestLabel } from '@/lib/claude-accounts';
import { createXtermOptions, TERMINAL_SURFACE_CLASS, useTerminalTheme } from '@/lib/terminal-theme';
import { disposeTerminalSafely, stopWheelTyping, stripTerminalReplies } from '@/lib/terminal';
import { addWebLinks } from '@/lib/terminal-links';

type LoginBridge = Pick<NonNullable<ElectronAPI['claudeAccounts']>,
  'loginStart' | 'loginWrite' | 'loginResize' | 'loginKill' | 'onLoginData' | 'onLoginExit'>;

/** What the wiring needs of an xterm Terminal. */
interface LoginTerminal {
  cols: number;
  rows: number;
  write: (data: string) => void;
  onData: (listener: (data: string) => void) => { dispose: () => void };
}

/**
 * Ties one terminal to one account's `claude auth login --claudeai`, run by
 * main (#263): its output in, the user's keys out, and the run killed when the
 * terminal goes while it still runs. Output that arrives before main has said
 * which pty is ours is held, then shown if it was ours.
 */
export function connectLoginTerminal(api: LoginBridge, id: string, term: LoginTerminal, onExit: (exitCode: number) => void) {
  let ptyId: string | null = null;
  let ended = false;
  let disposed = false;
  const early: Array<{ ptyId: string; data?: string; exitCode?: number }> = [];

  const exit = (code: number) => { ended = true; onExit(code); };
  const offData = api.onLoginData(e => {
    if (ptyId === null) early.push(e);
    else if (e.ptyId === ptyId) term.write(e.data);
  });
  const offExit = api.onLoginExit(e => {
    if (ptyId === null) early.push(e);
    else if (e.ptyId === ptyId) exit(e.exitCode);
  });
  // The terminal's own answers to a query from the CLI arrive here like a key
  // and must never be forwarded (stripTerminalReplies).
  const typing = term.onData(data => {
    const typed = stripTerminalReplies(data);
    if (typed && ptyId && !ended) void api.loginWrite({ ptyId, data: typed });
  });

  void api.loginStart({ id, cols: term.cols, rows: term.rows }).then(r => {
    if (!r.success) {
      term.write(`\r\n${r.error}\r\n`);
      exit(-1);
      return;
    }
    ptyId = r.ptyId;
    for (const e of early.splice(0)) {
      if (e.ptyId !== ptyId) continue;
      if (e.data !== undefined) term.write(e.data);
      if (e.exitCode !== undefined) exit(e.exitCode);
    }
    if (disposed && !ended) void api.loginKill({ ptyId });
  });

  return {
    resize(cols: number, rows: number) {
      if (ptyId && !ended) void api.loginResize({ ptyId, cols, rows });
    },
    dispose() {
      disposed = true;
      offData();
      offExit();
      typing.dispose();
      if (ptyId && !ended) void api.loginKill({ ptyId });
    },
  };
}

/**
 * Adding a Claude account, or signing one in again: a terminal on the
 * account's own folder where Claude Code's own sign-in runs. Tars never sees
 * it. Frames: `Settings · Claude accounts · states` > ADDING AN ACCOUNT.
 */
export function ClaudeAccountLoginModal({ accountId, onClose }: {
  /** The account to sign in. Absent: name a new one, add it, then sign it in. */
  accountId?: string;
  onClose: () => void;
}) {
  const { view, actions } = useClaudeAccounts();
  const [id, setId] = useState<string | undefined>(accountId);
  // What was typed; until then, the first free "Account N" of main's view,
  // which may arrive after the dialog opens.
  const [typed, setTyped] = useState<string | null>(null);
  const label = typed ?? (view ? suggestLabel(view) : '');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const theme = useTerminalTheme();
  const themeRef = useRef(theme);
  const xterm = useRef<import('xterm').Terminal | null>(null);

  const account = id ? view?.accounts.find(a => a.id === id) : undefined;

  const add = async () => {
    const clean = label.trim();
    if (!clean) { setRefusal('An account needs a label.'); return; }
    setAdding(true);
    const r = await actions.add({ label: clean });
    setAdding(false);
    if (!r.success) { setRefusal(r.error); return; }
    setRefusal(null);
    setId(r.account.id);
  };

  // The terminal, once there is an account to sign in and a place to draw it.
  useEffect(() => {
    const bridge = window.electronAPI?.claudeAccounts;
    if (!id || !container.current || !bridge) return;
    let cancelled = false;
    let wiring: ReturnType<typeof connectLoginTerminal> | null = null;
    let observer: ResizeObserver | null = null;
    void (async () => {
      const { Terminal } = await import('xterm');
      const { FitAddon } = await import('xterm-addon-fit');
      if (cancelled || !container.current) return;
      const term = new Terminal({ ...createXtermOptions(), theme: themeRef.current, fontSize: 13, cursorBlink: true, cursorStyle: 'bar', scrollback: 2000 });
      const fit = new FitAddon();
      term.loadAddon(fit);
      void addWebLinks(term);
      term.open(container.current);
      stopWheelTyping(term);
      fit.fit();
      xterm.current = term;
      wiring = connectLoginTerminal(bridge, id, term, setExitCode);
      observer = new ResizeObserver(() => { fit.fit(); wiring?.resize(term.cols, term.rows); });
      observer.observe(container.current);
    })();
    return () => {
      cancelled = true;
      observer?.disconnect();
      wiring?.dispose();
      if (xterm.current) {
        disposeTerminalSafely(xterm.current);
        xterm.current = null;
      }
    };
  }, [id]);

  // Follows the app between dark and light, like every other terminal.
  useEffect(() => {
    themeRef.current = theme;
    if (xterm.current) xterm.current.options.theme = theme;
  }, [theme]);

  const signedIn = account?.signedIn === true;
  const name = account?.label ?? label.trim();
  const status = signedIn
    ? { tone: 'running' as const, text: account?.email ? `Signed in as ${account.email}.` : 'Signed in.' }
    : exitCode !== null && exitCode !== 0
      ? { tone: 'error' as const, text: `Claude Code's sign-in ended without signing in (exit ${exitCode}).` }
      : { tone: 'waiting' as const, text: `Waiting for the sign-in. ${name} is in the list already, and reads signed in once Claude Code says so.` };

  return (
    <DialogShell
      onClose={onClose}
      width={620}
      title={id ? (accountId ? `Sign in ${name}` : 'Add a Claude account') : 'Add a Claude account'}
      subtitle="Claude Code's own sign-in runs below, in a folder of its own. Tars never sees it."
      footerLeft={id ? (
        <span className="flex items-center gap-2 text-[11.5px] text-text-secondary">
          <StatusSquare tone={status.tone} />
          {status.text}
        </span>
      ) : undefined}
      footerRight={id ? (
        signedIn
          ? <Button variant="primary" onClick={onClose}>Done</Button>
          : <Button variant="secondary" onClick={onClose}>Close</Button>
      ) : (
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { void add(); }} disabled={adding}>Add and sign in</Button>
        </>
      )}
    >
      {!id && (
        <div className="flex flex-col gap-1">
          <Label>Name</Label>
          <Input
            autoFocus
            maxLength={40}
            aria-label="Name"
            value={label}
            error={!!refusal}
            onChange={e => { setTyped(e.target.value); setRefusal(null); }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
          />
          {refusal
            ? <FieldError>{refusal}</FieldError>
            : <p className="text-[11px] text-text-secondary">What your agents show when they run on it.</p>}
        </div>
      )}
      {id && (
        <div className="flex flex-col gap-1">
          <Label>Sign in</Label>
          <div ref={container} className={`h-[300px] p-2 border border-border ${TERMINAL_SURFACE_CLASS}`} />
        </div>
      )}
    </DialogShell>
  );
}
