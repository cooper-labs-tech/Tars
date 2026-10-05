'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { AgentStatus } from '@/types/electron';
import { isElectron } from '@/hooks/useElectron';
import { onAgentMoveLine } from '@/hooks/useClaudeAccounts';
import { attachShiftEnterHandler, connectionLine, disposeTerminalSafely, keySender, passWheelToProgram, stripCursorSequences, stripTerminalReplies, suppressMouseTracking } from '@/lib/terminal';
import { createXtermOptions, useTerminalTheme } from '@/lib/terminal-theme';

interface UseAgentDialogTerminalOptions {
  open: boolean;
  agent: AgentStatus | null;
  isFullscreen: boolean;
  skipHistoricalOutput: boolean;
}

export function useAgentDialogTerminal({
  open,
  agent,
  isFullscreen,
  skipHistoricalOutput,
}: UseAgentDialogTerminalOptions) {
  const [terminalReady, setTerminalReady] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const xtermTheme = useTerminalTheme();
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<import('xterm').Terminal | null>(null);
  const fitAddonRef = useRef<import('xterm-addon-fit').FitAddon | null>(null);
  const agentIdRef = useRef<string | null>(null);
  const isAtBottomRef = useRef(true);

  // Keep agentIdRef current
  useEffect(() => {
    agentIdRef.current = agent?.id || null;
  }, [agent?.id]);

  // Initialize terminal when dialog opens
  useEffect(() => {
    if (!open || !agent) return;

    if (xtermRef.current) {
      const term = xtermRef.current;
      xtermRef.current = null;
      fitAddonRef.current = null;
      disposeTerminalSafely(term);
    }

    // Reset scroll-lock state for new session
    isAtBottomRef.current = true;
    setIsAtBottom(true);

    let cancelled = false;

    const initTerminal = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (cancelled || !terminalRef.current) return;

      const rect = terminalRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        setTimeout(initTerminal, 100);
        return;
      }

      const { Terminal } = await import('xterm');
      const { FitAddon } = await import('xterm-addon-fit');
      // The window may have closed while xterm loaded, which on a first open or
      // under next dev takes a while: its element is gone, and opening the
      // terminal on it threw "Terminal requires a parent element".
      if (cancelled || !terminalRef.current) return;

      const term = new Terminal({
        ...createXtermOptions(),
        fontSize: 13,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 10000,
        convertEol: agent.provider !== 'gemini',
      });

      // Before the first write. Claude Code re-arms mouse tracking on almost
      // every redraw, and honouring it disables xterm's selection service and
      // swallows the wheel, so the pane can neither scroll nor be selected.
      // The "Previous output" replay below carries the same sequences.
      suppressMouseTracking(term);

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      try {
        term.open(terminalRef.current);
        passWheelToProgram(term, input => {
          const id = agentIdRef.current;
          if (id && window.electronAPI?.agent?.sendInput) {
            window.electronAPI.agent.sendInput({ id, input }).catch(() => {});
          }
        });
        if (cancelled) { disposeTerminalSafely(term); return; }

        xtermRef.current = term;
        fitAddonRef.current = fitAddon;

        // Track whether user is at the bottom so we don't hijack scroll position
        term.onScroll(() => {
          const buffer = term.buffer.active;
          const maxY = Math.max(0, buffer.length - term.rows);
          const atBottom = buffer.viewportY >= maxY - 2;
          isAtBottomRef.current = atBottom;
          setIsAtBottom(atBottom);
        });

        const fitAndResize = () => {
          try {
            fitAddon.fit();
            term.scrollToBottom();
            if (window.electronAPI?.agent?.resize && agent?.id) {
              window.electronAPI.agent.resize({ id: agent.id, cols: term.cols, rows: term.rows }).catch(() => {});
            }
          } catch (e) {
            console.warn('Failed to fit terminal:', e);
          }
        };

        fitAndResize();
        setTimeout(fitAndResize, 50);
        setTimeout(fitAndResize, 200);
        // Not an asleep agent's: a key typed into it wakes the agent, Escape
        // included, and the Escape that closes this window would have woken it.
        // A click in the terminal is how to type there. Frame: `Agent asleep ·
        // and how it wakes`.
        setTimeout(() => { fitAndResize(); if (agent.status !== 'asleep') term.focus(); }, 350);

        // Keys that reach no terminal (an idle agent has none since #164) are
        // said so in the panel rather than dropped. See keySender.
        const typeKeys = keySender(term, (input) => {
          const id = agentIdRef.current;
          return id && window.electronAPI?.agent?.sendInput
            ? window.electronAPI.agent.sendInput({ id, input })
            : Promise.resolve(undefined);
        });

        attachShiftEnterHandler(term, typeKeys);

        // The terminal's own replies to queries from the CLI arrive here like a
        // keystroke and must never be forwarded. See stripTerminalReplies.
        term.onData((data) => {
          const cleaned = stripTerminalReplies(data);
          if (!cleaned) return;
          typeKeys(cleaned);
        });

        if (!cancelled) setTerminalReady(true);

        // Connected only to an agent that has a terminal: agent:get names none
        // for an idle agent, whose dialog used to say "Connected" all the same.
        let latestAgent: Awaited<ReturnType<NonNullable<typeof window.electronAPI>['agent']['get']>> | null = null;
        if (window.electronAPI?.agent?.get) {
          try {
            latestAgent = await window.electronAPI.agent.get(agent.id);
          } catch (err) {
            console.error('Failed to fetch agent output:', err);
          }
        }
        if (cancelled) return;
        // Asleep, the window shows the screen its CLI slept on, as it was,
        // and says over it that a key wakes it (AgentTerminalDialog): a line
        // written here would say it is not running, and the screen's reset
        // would wipe it. Frame: `Agent asleep · and how it wakes`.
        const asleep = latestAgent?.status === 'asleep';
        if (!asleep) {
          term.writeln(connectionLine(agent.name || 'Agent', !!latestAgent?.ptyId));
          term.writeln('');
        }

        if (latestAgent?.output?.length) {
          // Since #127 an agent with a live terminal answers with one
          // redraw of its screen, which opens with RIS and places every
          // cell with the very cursor sequences gemini's strip removes.
          // The strip is for raw output only.
          const isSnapshot = latestAgent.output.length === 1 && latestAgent.output[0].startsWith('\x1bc');
          const strip = agent.provider === 'gemini' && !isSnapshot;
          const writeLine = (line: string) => term.write(strip ? stripCursorSequences(line) : line);

          if (asleep) {
            latestAgent.output.forEach(writeLine);
          } else if (skipHistoricalOutput) {
            latestAgent.output.slice(-20).forEach(writeLine);
          } else {
            term.writeln('\x1b[33m--- Previous output ---\x1b[0m');
            latestAgent.output.forEach(writeLine);
          }
          setTimeout(fitAndResize, 50);
        }
      } catch (e) {
        console.error('Failed to initialize terminal:', e);
      }
    };

    initTerminal();

    return () => {
      cancelled = true;
      if (xtermRef.current) {
        const term = xtermRef.current;
        xtermRef.current = null;
        fitAddonRef.current = null;
        disposeTerminalSafely(term);
      }
      setTerminalReady(false);
    };
  }, [open, agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the app theme: xterm holds literal colours, so re-apply on toggle
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = xtermTheme;
    }
  }, [xtermTheme, terminalReady]);

  // Subscribe to live agent output
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.agent?.onOutput || !terminalReady || !agent?.id) return;
    agentIdRef.current = agent.id;
    const unsubOutput = window.electronAPI.agent.onOutput((event) => {
      if (event.agentId === agent.id && xtermRef.current) {
        xtermRef.current.write(event.data);
      }
    });
    // A move by Tars to another Claude account, said in the agent's window.
    const unsubMove = onAgentMoveLine((agentId, line) => {
      if (agentId === agent.id) xtermRef.current?.write(line);
    });
    return () => {
      unsubOutput();
      unsubMove();
    };
  }, [terminalReady, agent?.id]);

  // Resize observer
  useEffect(() => {
    if (!terminalRef.current || !fitAddonRef.current) return;
    const observer = new ResizeObserver(() => {
      if (fitAddonRef.current && xtermRef.current) {
        try {
          fitAddonRef.current.fit();
          // Only scroll to bottom if user was already at the bottom: don't hijack manual scroll position
          if (isAtBottomRef.current) {
            xtermRef.current.scrollToBottom();
          }
          const id = agentIdRef.current;
          if (id && window.electronAPI?.agent?.resize) {
            window.electronAPI.agent.resize({ id, cols: xtermRef.current.cols, rows: xtermRef.current.rows }).catch(() => {});
          }
        } catch (e) {
          console.warn('Failed to fit terminal:', e);
        }
      }
    });
    observer.observe(terminalRef.current);
    return () => observer.disconnect();
  }, [terminalReady]);

  // Re-fit when entering/exiting fullscreen
  useEffect(() => {
    if (!terminalReady || !fitAddonRef.current || !xtermRef.current) return;
    const t1 = setTimeout(() => {
      fitAddonRef.current?.fit();
      if (isAtBottomRef.current) {
        xtermRef.current?.scrollToBottom();
      }
      const id = agentIdRef.current;
      if (id && xtermRef.current && window.electronAPI?.agent?.resize) {
        window.electronAPI.agent.resize({ id, cols: xtermRef.current.cols, rows: xtermRef.current.rows }).catch(() => {});
      }
    }, 50);
    const t2 = setTimeout(() => {
      fitAddonRef.current?.fit();
      if (isAtBottomRef.current) {
        xtermRef.current?.scrollToBottom();
      }
    }, 150);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [isFullscreen, terminalReady]);

  // Exposed scroll-to-bottom: re-anchors viewport and re-enables auto-scroll
  const scrollToBottom = useCallback(() => {
    if (xtermRef.current) {
      xtermRef.current.scrollToBottom();
      isAtBottomRef.current = true;
      setIsAtBottom(true);
    }
  }, []);

  return { terminalReady, terminalRef, xtermRef, agentIdRef, isAtBottom, scrollToBottom };
}
