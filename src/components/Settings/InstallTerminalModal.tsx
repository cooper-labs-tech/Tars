'use client';

import { useEffect, useRef, useState } from 'react';
import { isElectron } from '@/hooks/useElectron';
import { Button, DialogShell, StatusBadge, StatusSquare } from '@/components/ui';
import {
  createXtermOptions,
  TERMINAL_SURFACE_CLASS,
  useTerminalTheme,
} from '@/lib/terminal-theme';
import { disposeTerminalSafely, stopWheelTyping, stripTerminalReplies } from '@/lib/terminal';
import { addWebLinks } from '@/lib/terminal-links';

interface InstallTerminalModalProps {
  show: boolean;
  command: string;
  onClose: () => void;
  onComplete: () => void;
}

export const InstallTerminalModal = ({ show, command, onClose, onComplete }: InstallTerminalModalProps) => {
  const [installComplete, setInstallComplete] = useState(false);
  const [installExitCode, setInstallExitCode] = useState<number | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<import('xterm').Terminal | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  // Follows the app theme, so the install log is not a black rectangle in light mode
  const terminalTheme = useTerminalTheme();

  // Initialize xterm when modal opens
  useEffect(() => {
    if (!show || !terminalRef.current || xtermRef.current) return;

    const initTerminal = async () => {
      const { Terminal } = await import('xterm');
      const { FitAddon } = await import('xterm-addon-fit');

      const term = new Terminal({
        ...createXtermOptions(),
        fontSize: 13,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 10000,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      void addWebLinks(term);
      term.open(terminalRef.current!);
      stopWheelTyping(term);
      fitAddon.fit();

      xtermRef.current = term;

      // Handle user input - send to PTY. The terminal's own replies to queries
      // from the installer arrive here like a keystroke and must never be
      // forwarded. See stripTerminalReplies.
      term.onData((data) => {
        const cleaned = stripTerminalReplies(data);
        if (!cleaned) return;
        if (ptyIdRef.current && window.electronAPI?.plugin?.installWrite) {
          window.electronAPI.plugin.installWrite({ id: ptyIdRef.current, data: cleaned });
        }
      });

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        if (ptyIdRef.current && window.electronAPI?.plugin?.installResize) {
          window.electronAPI.plugin.installResize({
            id: ptyIdRef.current,
            cols: term.cols,
            rows: term.rows,
          });
        }
      });
      resizeObserver.observe(terminalRef.current!);

      setTerminalReady(true);
    };

    initTerminal();

    return () => {
      // Kill PTY process to prevent zombie processes
      if (ptyIdRef.current && window.electronAPI?.plugin?.installKill) {
        window.electronAPI.plugin.installKill({ id: ptyIdRef.current });
        ptyIdRef.current = null;
      }
      if (xtermRef.current) {
        const term = xtermRef.current;
        xtermRef.current = null;
        disposeTerminalSafely(term);
      }
      setTerminalReady(false);
    };
  }, [show]);

  // Re-paint an open terminal when the app switches between dark and light
  useEffect(() => {
    if (xtermRef.current) xtermRef.current.options.theme = terminalTheme;
  }, [terminalTheme]);

  // Start PTY only after terminal is ready
  useEffect(() => {
    if (!terminalReady || !command || !window.electronAPI?.plugin?.installStart) return;

    const startPty = async () => {
      try {
        const term = xtermRef.current;
        const result = await window.electronAPI?.plugin?.installStart({
          command,
          cols: term?.cols,
          rows: term?.rows,
        });
        if (!result) return;
        ptyIdRef.current = result.id;
      } catch (err) {
        console.error('Failed to start plugin installation:', err);
        onClose();
      }
    };

    startPty();
  }, [terminalReady, command, onClose]);

  // Listen for PTY data
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.plugin?.onPtyData) return;

    const unsubscribe = window.electronAPI.plugin.onPtyData(({ id, data }) => {
      if (id === ptyIdRef.current && xtermRef.current) {
        xtermRef.current.write(data);
      }
    });

    return unsubscribe;
  }, []);

  // Listen for PTY exit
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.plugin?.onPtyExit) return;

    const unsubscribe = window.electronAPI.plugin.onPtyExit(({ id, exitCode }) => {
      if (id === ptyIdRef.current) {
        setInstallComplete(true);
        setInstallExitCode(exitCode);
      }
    });

    return unsubscribe;
  }, []);

  const handleClose = () => {
    if (ptyIdRef.current && window.electronAPI?.plugin?.installKill) {
      window.electronAPI.plugin.installKill({ id: ptyIdRef.current });
    }
    setInstallComplete(false);
    setInstallExitCode(null);
    ptyIdRef.current = null;
    onComplete();
    onClose();
  };

  if (!show) return null;

  const failed = installComplete && installExitCode !== 0;
  const tone = installComplete ? (failed ? 'error' : 'idle') : 'running';

  return (
    <DialogShell
      onClose={handleClose}
      width={860}
      title="Installing"
      subtitle={
        <>
          <span className="font-mono">{command}</span>: this runs in a real terminal, so you see
          exactly what it does.
        </>
      }
      footerRight={
        installComplete ? (
          <Button variant="primary" onClick={handleClose}>
            {failed ? 'Close' : 'Done'}
          </Button>
        ) : (
          <Button variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
        )
      }
    >
      <div ref={terminalRef} className={`h-[400px] ${TERMINAL_SURFACE_CLASS}`} />

      {/* The terminal is interactive, and nothing about a scrolling log says so. */}
      <div className="mt-2 flex items-center justify-between gap-3 bg-bg-tertiary px-3 py-2">
        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <StatusSquare tone={tone} />
          You can type here; it is a real PTY, not a log view.
        </span>
        {!installComplete && <StatusBadge tone="running" className="font-mono" />}
        {failed && (
          <StatusBadge tone="error" className="font-mono">{`error (${installExitCode})`}</StatusBadge>
        )}
      </div>
    </DialogShell>
  );
};
