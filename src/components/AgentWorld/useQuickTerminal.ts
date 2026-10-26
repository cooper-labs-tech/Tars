'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { isElectron } from '@/hooks/useElectron';
import { attachShiftEnterHandler, disposeTerminalSafely, passWheelToProgram, stripTerminalReplies, suppressMouseTracking } from '@/lib/terminal';
import { createXtermTheme, getTerminalFontFamily, useTerminalTheme } from '@/lib/terminal-theme';
import { addWebLinks, terminalLinkHandler } from '@/lib/terminal-links';
// The main process's own trim logic for agent.output, imported rather than
// copied: it has no dependency outside itself.
import { carriedByTrim } from '../../../electron/utils/terminal-modes';
import type { PanelType } from './AgentDialogTypes';

// Module-level map: persist PTY sessions across dialog open/close
export const persistentTerminals = new Map<string, { ptyId: string; outputBuffer: string[] }>();

/** Output events a quick shell keeps for its replay when the window reopens. */
const QUICK_OUTPUT_EVENTS = 1000;

interface UseQuickTerminalOptions {
  agentId: string | undefined;
  projectPath: string;
  open: boolean;
  expandedPanels: Set<PanelType>;
  onCollapseTerminal: () => void;
}

export function useQuickTerminal({
  agentId,
  projectPath,
  open,
  expandedPanels,
  onCollapseTerminal,
}: UseQuickTerminalOptions) {
  const [quickTerminalReady, setQuickTerminalReady] = useState(false);
  const quickTerminalRef = useRef<HTMLDivElement>(null);
  const quickXtermRef = useRef<import('xterm').Terminal | null>(null);
  const quickFitAddonRef = useRef<import('xterm-addon-fit').FitAddon | null>(null);
  const quickPtyIdRef = useRef<string | null>(null);

  // App theme, as an xterm theme, re-applied below so the terminal follows light mode
  const xtermTheme = useTerminalTheme();

  const hasActiveTerminal = agentId ? persistentTerminals.has(agentId) : false;

  // Initialize quick terminal when "Shell" panel opens
  useEffect(() => {
    const isOpen = expandedPanels.has('terminal');
    if (!isOpen || !agentId || !projectPath) return;
    if (quickXtermRef.current && quickPtyIdRef.current) return;

    let cancelled = false;

    const init = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (cancelled || !quickTerminalRef.current || quickXtermRef.current) return;

      const rect = quickTerminalRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        setTimeout(init, 100);
        return;
      }

      const { Terminal } = await import('xterm');
      const { FitAddon } = await import('xterm-addon-fit');

      const term = new Terminal({
        // Read at creation time so a theme switch mid-session cannot go stale
        theme: createXtermTheme(),
        linkHandler: terminalLinkHandler,
        fontSize: 12,
        fontFamily: getTerminalFontFamily(),
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 5000,
        convertEol: true,
      });

      // Before the first write. A full-screen program re-arms mouse tracking on
      // almost every redraw, and honouring it disables xterm's selection service
      // and swallows the wheel, so the pane can neither scroll nor be selected.
      // The buffered output replayed below carries the same sequences.
      suppressMouseTracking(term);

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      void addWebLinks(term);

      try {
        term.open(quickTerminalRef.current);
        passWheelToProgram(term, data => {
          if (quickPtyIdRef.current && window.electronAPI?.pty?.write) {
            window.electronAPI.pty.write({ id: quickPtyIdRef.current, data }).catch(() => {});
          }
        });
        if (cancelled) { disposeTerminalSafely(term); return; }

        quickXtermRef.current = term;
        quickFitAddonRef.current = fitAddon;

        fitAddon.fit();
        term.scrollToBottom();
        setTimeout(() => { fitAddon.fit(); term.scrollToBottom(); }, 100);
        setTimeout(() => { fitAddon.fit(); term.scrollToBottom(); term.focus(); }, 250);

        const existing = persistentTerminals.get(agentId);

        if (existing) {
          quickPtyIdRef.current = existing.ptyId;
          existing.outputBuffer.forEach((data) => term.write(data));
          if (window.electronAPI?.pty?.resize) {
            window.electronAPI.pty.resize({ id: existing.ptyId, cols: term.cols, rows: term.rows });
          }
          setQuickTerminalReady(true);
        } else if (window.electronAPI?.pty?.create) {
          const { id: ptyId } = await window.electronAPI.pty.create({ cwd: projectPath, cols: term.cols, rows: term.rows });
          if (!cancelled) {
            quickPtyIdRef.current = ptyId;
            persistentTerminals.set(agentId, { ptyId, outputBuffer: [] });
            setQuickTerminalReady(true);
          }
        }

        attachShiftEnterHandler(term, (data) => {
          if (quickPtyIdRef.current && window.electronAPI?.pty?.write) {
            window.electronAPI.pty.write({ id: quickPtyIdRef.current, data }).catch(() => {});
          }
        });

        // The terminal's own replies to queries from the shell arrive here like
        // a keystroke and must never be forwarded. See stripTerminalReplies.
        term.onData(async (data) => {
          const cleaned = stripTerminalReplies(data);
          if (!cleaned) return;
          if (quickPtyIdRef.current && window.electronAPI?.pty?.write) {
            await window.electronAPI.pty.write({ id: quickPtyIdRef.current, data: cleaned });
          }
        });

        term.onResize(({ cols, rows }) => {
          if (quickPtyIdRef.current && window.electronAPI?.pty?.resize) {
            window.electronAPI.pty.resize({ id: quickPtyIdRef.current, cols, rows });
          }
        });
      } catch (e) {
        console.error('Failed to initialize quick terminal:', e);
      }
    };

    init();

    return () => {
      cancelled = true;
      if (quickXtermRef.current) {
        const term = quickXtermRef.current;
        quickXtermRef.current = null;
        quickFitAddonRef.current = null;
        disposeTerminalSafely(term);
      }
      setQuickTerminalReady(false);
    };
  }, [expandedPanels, agentId, projectPath]);  

  // Follow the app theme without tearing down the PTY session
  useEffect(() => {
    if (quickXtermRef.current) quickXtermRef.current.options.theme = xtermTheme;
  }, [xtermTheme]);

  // Dispose xterm UI when dialog closes (keep PTY alive in persistentTerminals)
  useEffect(() => {
    if (!open) {
      if (quickXtermRef.current) {
        const term = quickXtermRef.current;
        quickXtermRef.current = null;
        quickFitAddonRef.current = null;
        disposeTerminalSafely(term);
      }
      setQuickTerminalReady(false);
    }
  }, [open]);

  // Route incoming PTY data to xterm and buffer it
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.pty?.onData) return;
    return window.electronAPI.pty.onData((event) => {
      if (!agentId) return;
      const existing = persistentTerminals.get(agentId);
      if (!existing || event.id !== existing.ptyId) return;

      // Bounded like agent.output, and trimmed the same way: what is dropped
      // leaves behind the modes it set, so a reopened shell replays into the
      // alternate screen, the mouse request and the bracketed paste the
      // program asked for, not into a terminal that has forgotten them.
      existing.outputBuffer.push(event.data);
      if (existing.outputBuffer.length > QUICK_OUTPUT_EVENTS) {
        const carried = carriedByTrim(existing.outputBuffer.splice(0, existing.outputBuffer.length - QUICK_OUTPUT_EVENTS));
        if (carried) existing.outputBuffer.unshift(carried);
      }
      quickXtermRef.current?.write(event.data);
    });
  }, [agentId]);

  const closeQuickTerminal = useCallback(() => {
    if (agentId) {
      const existing = persistentTerminals.get(agentId);
      if (existing && window.electronAPI?.pty?.kill) {
        window.electronAPI.pty.kill({ id: existing.ptyId });
        persistentTerminals.delete(agentId);
      }
    }
    if (quickXtermRef.current) {
      const term = quickXtermRef.current;
      quickXtermRef.current = null;
      quickFitAddonRef.current = null;
      disposeTerminalSafely(term);
    }
    quickPtyIdRef.current = null;
    setQuickTerminalReady(false);
    onCollapseTerminal();
  }, [agentId, onCollapseTerminal]);

  return {
    quickTerminalReady,
    quickTerminalRef,
    quickXtermRef,
    hasActiveTerminal,
    closeQuickTerminal,
  };
}
