'use client';

import { useEffect, useRef } from 'react';
import { attachShiftEnterHandler, disposeTerminalSafely, keySender, passWheelToProgram, stripTerminalReplies, suppressMouseTracking } from '@/lib/terminal';
import { createXtermOptions, useTerminalTheme } from '@/lib/terminal-theme';
import { addWebLinks } from '@/lib/terminal-links';

interface UseTrayTerminalProps {
  agentId: string;
  // Callback-ref pattern: React sets this to the DOM element once mounted,
  // guaranteeing the element already has its CSS dimensions.
  container: HTMLDivElement | null;
}


export function useTrayTerminal({ agentId, container }: UseTrayTerminalProps) {
  const terminalTheme = useTerminalTheme();
  const xtermRef = useRef<import('xterm').Terminal | null>(null);
  const fitAddonRef = useRef<import('xterm-addon-fit').FitAddon | null>(null);
  const agentIdRef = useRef(agentId);
  // Written in an effect, not during render: a ref assignment during render
  // is unsafe under concurrent rendering, and every reader of this one runs
  // after commit (a callback, a subscription), so the timing is the same.
  useEffect(() => {
    agentIdRef.current = agentId;
  }, [agentId]);

  useEffect(() => {
    // container is null until the div mounts (callback-ref sets it).
    // When it is non-null, the element is already in the DOM with its CSS dimensions.
    if (!container) return;

    let cancelled = false;
    let unsubOutput: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const fitTimers: ReturnType<typeof setTimeout>[] = [];

    const init = async () => {
      // Wait for the container to be fully laid out (matches the approach used
      // in useAgentDialogTerminal which works correctly).
      await new Promise(resolve => setTimeout(resolve, 150));
      if (cancelled) return;

      if (container.getBoundingClientRect().width === 0) {
        setTimeout(init, 100);
        return;
      }

      const { Terminal } = await import('xterm');
      const { FitAddon } = await import('xterm-addon-fit');
      if (cancelled) return;

      const term = new Terminal({
        ...createXtermOptions(),
        fontSize: 11,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 3000,
        convertEol: true,
        overviewRulerWidth: 0,
      });

      // Before the first write. Claude Code re-arms mouse tracking on almost
      // every redraw, and honouring it disables xterm's selection service and
      // swallows the wheel, so the pane can neither scroll nor be selected.
      // The replayed transcript below carries the same sequences.
      suppressMouseTracking(term);

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      void addWebLinks(term);
      term.open(container);
      passWheelToProgram(term, input => {
        window.electronAPI?.agent?.sendInput({ id: agentIdRef.current, input });
      });

      if (cancelled) { disposeTerminalSafely(term); return; }

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;

      const doFitAndResize = () => {
        if (cancelled) return;
        fitAddon.fit();
        window.electronAPI?.agent?.resize({
          id: agentIdRef.current,
          cols: term.cols,
          rows: term.rows,
        }).catch(() => {});
      };

      doFitAndResize();
      fitTimers.push(
        setTimeout(() => { if (!cancelled) doFitAndResize(); }, 50),
        setTimeout(() => { if (!cancelled) doFitAndResize(); }, 200),
        setTimeout(() => { if (!cancelled) doFitAndResize(); }, 350),
      );

      // Replay full session output with cursor sequences intact: xterm is a
      // proper terminal emulator and processes them correctly, rendering the
      // final screen state just like live output does.
      // Do NOT strip sequences: stripping causes duplicated/garbled text.
      setTimeout(async () => {
        if (cancelled) return;
        try {
          const agentData = await window.electronAPI?.agent?.get(agentId);
          if (!cancelled && agentData?.output?.length) {
            agentData.output.forEach(chunk => term.write(chunk));
            term.scrollToBottom();
            doFitAndResize();
            term.focus();
          }
        } catch { /* ignore */ }
      }, 400);

      // Keys that reach no terminal (an idle agent has none since #164) are
      // said so in the panel rather than dropped. See keySender.
      const typeKeys = keySender(term, input => window.electronAPI?.agent?.sendInput
        ? window.electronAPI.agent.sendInput({ id: agentIdRef.current, input })
        : Promise.resolve(undefined));

      attachShiftEnterHandler(term, typeKeys);

      // The terminal's own replies to queries from the CLI arrive here like a
      // keystroke and must never be forwarded. See stripTerminalReplies.
      term.onData((data) => {
        const cleaned = stripTerminalReplies(data);
        if (!cleaned) return;
        typeKeys(cleaned);
      });

      resizeObserver = new ResizeObserver(() => {
        if (!cancelled) doFitAndResize();
      });
      resizeObserver.observe(container);

      if (window.electronAPI?.agent?.onOutput) {
        unsubOutput = window.electronAPI.agent.onOutput((event) => {
          if (event.agentId === agentIdRef.current && xtermRef.current) {
            xtermRef.current.write(event.data);
          }
        });
      }
    };

    init();

    return () => {
      cancelled = true;
      fitTimers.forEach(clearTimeout);
      unsubOutput?.();
      resizeObserver?.disconnect();
      if (xtermRef.current) {
        const term = xtermRef.current;
        xtermRef.current = null;
        fitAddonRef.current = null;
        disposeTerminalSafely(term);
      }
    };
  }, [container, agentId]);

  // Follow the app theme without tearing the terminal down and losing scrollback.
  useEffect(() => {
    if (xtermRef.current) xtermRef.current.options.theme = terminalTheme;
  }, [terminalTheme]);
}
