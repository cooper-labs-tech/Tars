'use client';

import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { createXtermOptions, useTerminalTheme, TERMINAL_SURFACE_CLASS } from '@/lib/terminal-theme';
import { disposeTerminalSafely, stopWheelTyping, stripTerminalReplies } from '@/lib/terminal';
import type { PtyBacklog } from '@/lib/pty-backlog';
import { addWebLinks } from '@/lib/terminal-links';

interface TerminalProps {
  ptyId?: string;
  /** What the PTY wrote before this terminal listened, which its page heard for it (lib/pty-backlog). */
  backlog?: Pick<PtyBacklog, 'take'>;
  onData?: (data: string) => void;
  className?: string;
}

export default function Terminal({ ptyId, backlog, onData, className = '' }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // What the PTY wrote before the xterm was made, a task after the mount
  // (below): the shell's banner and first prompt come meanwhile. Written into
  // it once it is, and kept for the PTY it came from only.
  const earlyRef = useRef<{ id: string; chunks: string[] } | null>(null);

  // Follows the app theme; applied to the live terminal below instead of at
  // init, so a theme flip never tears down the PTY-attached instance.
  const terminalTheme = useTerminalTheme();

  const initTerminal = useCallback(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const term = new XTerm({
      ...createXtermOptions(),
      fontSize: 13,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    void addWebLinks(term);

    term.open(terminalRef.current);
    stopWheelTyping(term);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    const early = earlyRef.current;
    earlyRef.current = null;
    if (early && early.id === ptyId) for (const chunk of early.chunks) term.write(chunk);

    // Handle terminal input. The terminal's own replies to queries from the
    // program in the pty (DA, CPR, DSR, focus, mouse) arrive here exactly like
    // a keystroke, and are dropped before anyone sees them: the parent's
    // callback is no more entitled to them than the pty is.
    // See stripTerminalReplies.
    term.onData((data) => {
      const cleaned = stripTerminalReplies(data);
      if (!cleaned) return;
      onData?.(cleaned);

      // If we have a PTY, send input to it
      if (ptyId && window.electronAPI?.pty) {
        window.electronAPI.pty.write({ id: ptyId, data: cleaned });
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (ptyId && window.electronAPI?.pty) {
        window.electronAPI.pty.resize({
          id: ptyId,
          cols: term.cols,
          rows: term.rows,
        });
      }
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      resizeObserver.disconnect();
      xtermRef.current = null;
      fitAddonRef.current = null;
      disposeTerminalSafely(term);
    };
  }, [ptyId, onData]);

  useEffect(() => {
    // Created on a later task, not in the effect body, and the reason is in
    // xterm rather than here. `term.open()` constructs the Viewport, whose
    // constructor does `requestAnimationFrame(() => this.syncScrollArea())`
    // and keeps no handle for it, so `dispose()` cannot cancel that frame.
    // A terminal opened and disposed in the same tick therefore leaves a
    // callback that runs against a render service that no longer exists, and
    // it throws reading `dimensions`.
    //
    // React mounts an effect, runs its cleanup and runs the effect again in
    // development, so opening the terminal in the effect body made that
    // guaranteed: every open of this dialog threw twice. One task of delay
    // means a cleanup arriving first cancels the creation instead of
    // disposing something already open, and nothing is ever opened that is
    // about to be thrown away.
    let cleanup: (() => void) | undefined;
    const pending = setTimeout(() => { cleanup = initTerminal(); }, 0);
    return () => {
      clearTimeout(pending);
      cleanup?.();
    };
  }, [initTerminal]);

  // Repaint on app theme change
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = terminalTheme;
    }
  }, [terminalTheme]);

  // Listen for PTY data. Until the xterm is made it is kept, and written into
  // it then (initTerminal): dropped, the shell's first lines never showed and
  // the terminal opened empty (the QA's WHEEL-QA.md, 05/10).
  useEffect(() => {
    if (!ptyId || !window.electronAPI?.pty) return;

    const show = (data: string) => {
      if (xtermRef.current) {
        xtermRef.current.write(data);
        return;
      }
      if (earlyRef.current?.id !== ptyId) earlyRef.current = { id: ptyId, chunks: [] };
      earlyRef.current.chunks.push(data);
    };
    const unsubscribe = window.electronAPI.pty.onData(({ id, data }) => {
      if (id === ptyId) show(data);
    });
    // Then what the page heard before this listened: it goes ahead of all
    // this hears, since no chunk can arrive between the line above and this.
    for (const data of backlog?.take(ptyId) ?? []) show(data);

    return unsubscribe;
  }, [ptyId, backlog]);

  // Public method to write to terminal
  const write = useCallback((data: string) => {
    xtermRef.current?.write(data);
  }, []);

  // Expose write method via ref
  useEffect(() => {
    if (terminalRef.current) {
      (terminalRef.current as HTMLDivElement & { terminalWrite?: (data: string) => void }).terminalWrite = write;
    }
  }, [write]);

  return (
    <div
      ref={terminalRef}
      className={`${TERMINAL_SURFACE_CLASS} rounded-none overflow-hidden ${className}`}
      style={{ minHeight: '200px' }}
    />
  );
}

// Hook for using terminal imperatively
export function useTerminalWriter(terminalRef: React.RefObject<HTMLDivElement>) {
  const write = useCallback((data: string) => {
    const el = terminalRef.current as HTMLDivElement & { terminalWrite?: (data: string) => void };
    el?.terminalWrite?.(data);
  }, [terminalRef]);

  return { write };
}
