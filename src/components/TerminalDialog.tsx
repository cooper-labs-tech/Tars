'use client';
import React, { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, XCircle, X, Link2 } from 'lucide-react';
import { isElectron } from '@/hooks/useElectron';
import ProviderBadge, { PROVIDER_CONFIG } from '@/components/ui/ProviderBadge';
import { BrandSpinner, Button } from '@/components/ui';
import { createXtermOptions, useTerminalTheme, TERMINAL_SURFACE_CLASS } from '@/lib/terminal-theme';
import { disposeTerminalSafely, stopWheelTyping, stripTerminalReplies } from '@/lib/terminal';
import 'xterm/css/xterm.css';
import { addWebLinks } from '@/lib/terminal-links';

interface TerminalDialogProps {
  open: boolean;
  repo: string;
  title: string;
  onClose: (success?: boolean) => void;
  availableProviders?: string[];
  /** When set, runs this shell command via plugin:install-start instead of skill:install-start */
  command?: string;
}

export default function TerminalDialog({ open, repo, title, onClose, availableProviders = ['claude'], command }: TerminalDialogProps) {
  // command mode uses plugin.* APIs, skill mode uses skill.* APIs
  const isCommandMode = !!command;
  const [installComplete, setInstallComplete] = useState(false);
  const [installExitCode, setInstallExitCode] = useState<number | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const [selectedProviders, setSelectedProviders] = useState<Set<string>>(new Set(['claude']));
  const [linkingStatus, setLinkingStatus] = useState<Record<string, 'pending' | 'done' | 'error'>>({});
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<import('xterm').Terminal | null>(null);
  const ptyIdRef = useRef<string | null>(null);

  // Follows the app theme; applied to the live terminal below instead of at
  // init, so a theme flip never tears down the PTY-attached instance.
  const terminalTheme = useTerminalTheme();

  // Reset state when opening with new repo
  useEffect(() => {
    if (open) {
      setInstallComplete(false);
      setInstallExitCode(null);
      setTerminalReady(false);
      setSelectedProviders(new Set(['claude']));
      setLinkingStatus({});
    }
  }, [open, repo]);

  // Initialize xterm when dialog opens
  useEffect(() => {
    if (!open || !terminalRef.current || xtermRef.current) return;

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
        if (!ptyIdRef.current) return;
        if (isCommandMode) {
          window.electronAPI?.plugin?.installWrite({ id: ptyIdRef.current, data: cleaned });
        } else {
          window.electronAPI?.skill?.installWrite({ id: ptyIdRef.current, data: cleaned });
        }
      });

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        if (!ptyIdRef.current) return;
        const dims = { id: ptyIdRef.current, cols: term.cols, rows: term.rows };
        if (isCommandMode) {
          window.electronAPI?.plugin?.installResize(dims);
        } else {
          window.electronAPI?.skill?.installResize(dims);
        }
      });
      resizeObserver.observe(terminalRef.current!);

      // Terminal is ready - signal that we can start the PTY
      setTerminalReady(true);
    };

    initTerminal();

    return () => {
      // Kill PTY process to prevent zombie processes
      if (ptyIdRef.current) {
        if (isCommandMode) {
          window.electronAPI?.plugin?.installKill({ id: ptyIdRef.current });
        } else {
          window.electronAPI?.skill?.installKill({ id: ptyIdRef.current });
        }
        ptyIdRef.current = null;
      }
      if (xtermRef.current) {
        const term = xtermRef.current;
        xtermRef.current = null;
        disposeTerminalSafely(term);
      }
      setTerminalReady(false);
    };
  }, [open]);

  // Repaint the live terminal when the app theme flips
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = terminalTheme;
    }
  }, [terminalTheme]);

  // Start PTY only after terminal is ready
  useEffect(() => {
    if (!terminalReady) return;

    if (isCommandMode) {
      if (!command || !window.electronAPI?.plugin?.installStart) return;
      const startPty = async () => {
        try {
          const term = xtermRef.current;
          const result = await window.electronAPI!.plugin!.installStart({
            command: command!,
            cols: term?.cols,
            rows: term?.rows,
          });
          if (result) ptyIdRef.current = result.id;
        } catch (err) {
          xtermRef.current?.writeln(
            `Failed to start: ${err instanceof Error ? err.message : 'Unknown error'}`
          );
          setInstallComplete(true);
          setInstallExitCode(1);
        }
      };
      startPty();
    } else {
      if (!repo || !window.electronAPI?.skill?.installStart) return;
      const startPty = async () => {
        try {
          const result = await window.electronAPI!.skill.installStart({ repo });
          ptyIdRef.current = result.id;
        } catch (err) {
          xtermRef.current?.writeln(
            `Failed to start installation: ${err instanceof Error ? err.message : 'Unknown error'}`
          );
          setInstallComplete(true);
          setInstallExitCode(1);
        }
      };
      startPty();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalReady, repo, command]);

  // Listen for PTY data on both channels - ID filtering ensures correctness
  useEffect(() => {
    if (!isElectron()) return;

    const handler = ({ id, data }: { id: string; data: string }) => {
      if (id === ptyIdRef.current && xtermRef.current) {
        xtermRef.current.write(data);
      }
    };

    const unsub1 = window.electronAPI?.plugin?.onPtyData(handler);
    const unsub2 = window.electronAPI?.skill?.onPtyData(handler);

    return () => { unsub1?.(); unsub2?.(); };
   
  }, []);

  // Track command mode in a ref so the exit handler always has the current value
  const isCommandModeRef = useRef(isCommandMode);
  // Written in an effect, not during render: a ref assignment during render
  // is unsafe under concurrent rendering, and every reader of this one runs
  // after commit (a callback, a subscription), so the timing is the same.
  useEffect(() => {
    isCommandModeRef.current = isCommandMode;
  }, [isCommandMode]);

  // Declared above the effect that calls it. It used to sit below, which
  // worked only because the handler fires long after the component body
  // has run: the reference was in its temporal dead zone at the point the
  // effect closed over it.
  const linkToAdditionalProviders = async () => {
    // Extract skill name from repo (last segment after last /)
    const parts = repo.split('/');
    const skillName = parts.length >= 3 ? parts.slice(2).join('/') : parts[parts.length - 1];

    const additionalProviders = Array.from(selectedProviders).filter(p => p !== 'claude');
    if (additionalProviders.length === 0) return;

    for (const providerId of additionalProviders) {
      setLinkingStatus(prev => ({ ...prev, [providerId]: 'pending' }));
      try {
        const result = await window.electronAPI!.skill.linkToProvider({ skillName, providerId });
        setLinkingStatus(prev => ({ ...prev, [providerId]: result.success ? 'done' : 'error' }));
      } catch {
        setLinkingStatus(prev => ({ ...prev, [providerId]: 'error' }));
      }
    }
  };

  // Listen for PTY exit on both channels
  useEffect(() => {
    if (!isElectron()) return;

    const handler = ({ id, exitCode }: { id: string; exitCode: number }) => {
      if (id === ptyIdRef.current) {
        setInstallComplete(true);
        setInstallExitCode(exitCode);

        // On success, symlink to additional providers (skill mode only)
        if (exitCode === 0 && !isCommandModeRef.current) {
          linkToAdditionalProviders();
        }
      }
    };

    const unsub1 = window.electronAPI?.plugin?.onPtyExit(handler);
    const unsub2 = window.electronAPI?.skill?.onPtyExit(handler);

    return () => { unsub1?.(); unsub2?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleProvider = (id: string) => {
    if (id === 'claude') return; // Claude is always selected (primary installer)
    setSelectedProviders(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleClose = () => {
    if (ptyIdRef.current && !installComplete) {
      if (isCommandMode) {
        window.electronAPI?.plugin?.installKill({ id: ptyIdRef.current });
      } else {
        window.electronAPI?.skill?.installKill({ id: ptyIdRef.current });
      }
    }
    ptyIdRef.current = null;
    if (xtermRef.current) {
      const term = xtermRef.current;
      xtermRef.current = null;
      disposeTerminalSafely(term);
    }
    onClose(installComplete && installExitCode === 0);
  };

  const nonClaudeProviders = availableProviders.filter(p => p !== 'claude');

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-scrim z-[70] flex items-center justify-center p-4"
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-4xl bg-card border border-border rounded-none overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-none flex items-center justify-center ${
                  installComplete
                    ? installExitCode === 0
                      ? 'bg-success/20'
                      : 'bg-danger/20'
                    : 'bg-secondary'
                }`}>
                  {installComplete ? (
                    installExitCode === 0 ? (
                      <CheckCircle className="w-4 h-4 text-success" />
                    ) : (
                      <XCircle className="w-4 h-4 text-danger" />
                    )
                  ) : (
                    <BrandSpinner size={14} />
                  )}
                </div>
                <div>
                  <h3 className="font-semibold">
                    {installComplete
                      ? installExitCode === 0
                        ? 'Installation Complete'
                        : 'Installation Failed'
                      : title || 'Installing'}
                  </h3>
                  <p className="text-xs text-muted-foreground font-mono">{command || repo}</p>
                </div>
              </div>
              <button
                onClick={handleClose}
                className="p-2 hover:bg-secondary rounded-none"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Provider Selector - skill mode only */}
            {!isCommandMode && nonClaudeProviders.length > 0 && (
              <div className="px-5 py-3 border-b border-border flex items-center gap-3">
                <span className="text-xs text-muted-foreground">Install to:</span>
                {availableProviders.map(id => {
                  const config = PROVIDER_CONFIG[id];
                  if (!config) return null;
                  const isSelected = selectedProviders.has(id);
                  const isClaude = id === 'claude';
                  const status = linkingStatus[id];
                  const icon = config.icon;
                  return (
                    <button
                      key={id}
                      onClick={() => toggleProvider(id)}
                      disabled={isClaude || installComplete}
                      className={`inline-flex items-center gap-1.5 h-[26px] px-2.5 text-xs font-medium transition-colors border ${
                        isSelected
                          ? 'border-border-accent bg-secondary text-foreground'
                          : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
                      } ${isClaude ? 'opacity-90 cursor-default' : ''}`}
                    >
                      {typeof icon === 'string' ? (
                        <img src={icon} alt={config.label} className="w-3 h-3 object-contain" />
                      ) : (
                        React.createElement(icon, { className: 'w-3 h-3' })
                      )}
                      <span>{config.label}</span>
                      {status === 'done' && <CheckCircle className="w-3 h-3" />}
                      {status === 'error' && <XCircle className="w-3 h-3 text-danger" />}
                      {status === 'pending' && <BrandSpinner size={14} />}
                    </button>
                  );
                })}
                {installComplete && installExitCode === 0 && Object.keys(linkingStatus).length > 0 && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Link2 className="w-3 h-3" />
                    Linked via symlink
                  </span>
                )}
              </div>
            )}

            <div className="p-4">
              <p className="text-xs text-muted-foreground mb-3">
                This is an interactive terminal. Type your responses and press Enter when prompted.
              </p>
              <div
                ref={terminalRef}
                className={`${TERMINAL_SURFACE_CLASS} rounded-none overflow-hidden`}
                style={{ height: '400px' }}
              />
            </div>

            <div className="px-5 py-4 border-t border-border flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                {installComplete
                  ? `Exited with code ${installExitCode}`
                  : 'Waiting for installation to complete...'}
              </p>
              <Button
                variant={installComplete ? 'primary' : 'danger'}
                size="md"
                onClick={handleClose}
              >
                {installComplete ? 'Close' : 'Cancel'}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
