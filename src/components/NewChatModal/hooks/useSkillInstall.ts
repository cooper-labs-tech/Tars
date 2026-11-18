import { useState, useEffect, useRef, useCallback } from 'react';
import { isElectron } from '@/hooks/useElectron';
import { createXtermOptions, useTerminalTheme } from '@/lib/terminal-theme';
import { disposeTerminalSafely, stopWheelTyping, stripTerminalReplies } from '@/lib/terminal';
import type { Skill } from '@/lib/skills-database';
import { addWebLinks } from '@/lib/terminal-links';

export interface SkillInstallState {
  showInstallTerminal: boolean;
  installingSkill: { name: string; repo: string } | null;
  installComplete: boolean;
  installExitCode: number | null;
  terminalRef: React.RefObject<HTMLDivElement | null>;
  handleInstallSkill: (skill: Skill) => void;
  closeInstallTerminal: () => void;
}

export function useSkillInstall(onRefreshSkills?: () => void): SkillInstallState {
  const [showInstallTerminal, setShowInstallTerminal] = useState(false);
  const [installingSkill, setInstallingSkill] = useState<{ name: string; repo: string } | null>(null);
  const [installComplete, setInstallComplete] = useState(false);
  const [installExitCode, setInstallExitCode] = useState<number | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const xtermTheme = useTerminalTheme();
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<import('xterm').Terminal | null>(null);
  const ptyIdRef = useRef<string | null>(null);

  // Initialize xterm when install terminal opens
  useEffect(() => {
    if (!showInstallTerminal || !terminalRef.current || xtermRef.current) return;

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

      // Handle user input. This one filtered nothing at all, so every reply the
      // terminal made to the installer went back into it verbatim.
      // See stripTerminalReplies.
      term.onData((data) => {
        const cleaned = stripTerminalReplies(data);
        if (!cleaned) return;
        if (ptyIdRef.current && window.electronAPI?.skill?.installWrite) {
          window.electronAPI.skill.installWrite({ id: ptyIdRef.current, data: cleaned });
        }
      });

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        if (ptyIdRef.current && window.electronAPI?.skill?.installResize) {
          window.electronAPI.skill.installResize({
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
      if (xtermRef.current) {
        const term = xtermRef.current;
        xtermRef.current = null;
        disposeTerminalSafely(term);
      }
      setTerminalReady(false);
    };
  }, [showInstallTerminal]);

  // Follow the app theme: xterm holds literal colours, so re-apply on toggle
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = xtermTheme;
    }
  }, [xtermTheme, terminalReady]);

  // Start PTY after terminal is ready
  useEffect(() => {
    if (!terminalReady || !installingSkill || !window.electronAPI?.skill?.installStart) return;

    const startPty = async () => {
      try {
        const fullRepo = `${installingSkill.repo}/${installingSkill.name}`;
        const result = await window.electronAPI!.skill.installStart({ repo: fullRepo });
        ptyIdRef.current = result.id;
      } catch (err) {
        console.error('Failed to start installation:', err);
        setShowInstallTerminal(false);
        setInstallingSkill(null);
      }
    };

    startPty();
  }, [terminalReady, installingSkill]);

  // Listen for PTY data
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.skill?.onPtyData) return;

    const unsubscribe = window.electronAPI.skill.onPtyData(({ id, data }) => {
      if (id === ptyIdRef.current && xtermRef.current) {
        xtermRef.current.write(data);
      }
    });

    return unsubscribe;
  }, []);

  // Listen for PTY exit
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.skill?.onPtyExit) return;

    const unsubscribe = window.electronAPI.skill.onPtyExit(({ id, exitCode }) => {
      if (id === ptyIdRef.current) {
        setInstallComplete(true);
        setInstallExitCode(exitCode);
        if (exitCode === 0 && onRefreshSkills) {
          onRefreshSkills();
        }
      }
    });

    return unsubscribe;
  }, [onRefreshSkills]);

  const handleInstallSkill = useCallback((skill: Skill) => {
    setInstallingSkill({ name: skill.name, repo: skill.repo });
    setInstallComplete(false);
    setInstallExitCode(null);
    ptyIdRef.current = null;
    setShowInstallTerminal(true);
  }, []);

  const closeInstallTerminal = useCallback(() => {
    if (ptyIdRef.current && !installComplete) {
      window.electronAPI?.skill?.installKill({ id: ptyIdRef.current });
    }
    setShowInstallTerminal(false);
    setInstallingSkill(null);
    ptyIdRef.current = null;
    if (xtermRef.current) {
      const term = xtermRef.current;
      xtermRef.current = null;
      disposeTerminalSafely(term);
    }
  }, [installComplete]);

  return {
    showInstallTerminal,
    installingSkill,
    installComplete,
    installExitCode,
    terminalRef,
    handleInstallSkill,
    closeInstallTerminal,
  };
}
