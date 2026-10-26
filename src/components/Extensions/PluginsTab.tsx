'use client';

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Puzzle,
  Search,
  CheckCircle,
  XCircle,
  Filter,
  ChevronDown,
  Terminal as TerminalIcon,
  X,
  ExternalLink,
  Info,
  Code2,
  Globe,
  Wrench,
  Palette,
  Shield,
  Zap,
  Tag,
  User,
} from 'lucide-react';
import { useClaude } from '@/hooks/useClaude';
import { isElectron } from '@/hooks/useElectron';
import { usePluginsDatabase, type Plugin, type Marketplace } from '@/lib/plugins-database';
import { createXtermOptions, useTerminalTheme, TERMINAL_SURFACE_CLASS } from '@/lib/terminal-theme';
import { disposeTerminalSafely, stopWheelTyping, stripTerminalReplies } from '@/lib/terminal';
import { BrandSpinner, Button, DialogShell, ErrorState, LoadingPanel } from '@/components/ui';
// Import xterm CSS
import 'xterm/css/xterm.css';
import { addWebLinks } from '@/lib/terminal-links';

const CATEGORY_ICONS: Record<string, typeof Code2> = {
  'Code Intelligence': Code2,
  'External Integrations': Globe,
  'Development Workflows': Wrench,
  'Output Styles': Palette,
  'Security': Shield,
  'Productivity': Zap,
};

// The merged catalogue is ~700 plugins across the seven marketplaces, so the
// unpaged grid used to commit tens of thousands of DOM nodes in one synchronous
// pass every time this tab mounted (or the filters were cleared) - hundreds of
// milliseconds of blocked main thread for a container that shows ~9 cards.
// Page it like SkillsTab does. Multiple of 3 so the xl grid stays flush.
const PAGE_SIZE = 48;

const CATEGORY_COLORS: Record<string, string> = {
  'Code Intelligence': 'text-primary bg-primary/20',
  'External Integrations': 'text-primary bg-primary/20',
  'Development Workflows': 'text-warning bg-warning/20',
  'Output Styles': 'text-primary bg-primary/20',
  'Security': 'text-danger bg-danger/20',
  'Productivity': 'text-primary bg-primary/20',
};

// ── Memoized plugin card ──

interface PluginCardProps {
  plugin: Plugin;
  installed: boolean;
  isCustom: boolean;
  marketplaceName: string;
  justCopied: boolean;
  isInstalling: boolean;
  hasElectron: boolean;
  onInstall: (plugin: Plugin) => void;
  onCopy: (plugin: Plugin) => void;
}

const PluginCard = React.memo(function PluginCard({
  plugin,
  installed,
  isCustom,
  marketplaceName,
  justCopied,
  isInstalling,
  hasElectron,
  onInstall,
  onCopy,
}: PluginCardProps) {
  const Icon = CATEGORY_ICONS[plugin.category] || Puzzle;
  const colorClass = CATEGORY_COLORS[plugin.category] || 'text-muted-foreground bg-secondary';

  return (
    <div className="border border-border bg-card p-4 hover:border-foreground/30 transition-colors">
      <div className="flex items-start gap-3 mb-3">
        <div className={`w-10 h-10 flex items-center justify-center shrink-0 ${installed ? 'bg-primary/10' : colorClass.split(' ')[1]}`}>
          {installed ? (
            <CheckCircle className="w-5 h-5 text-primary" />
          ) : (
            <Icon className={`w-5 h-5 ${colorClass.split(' ')[0]}`} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium text-sm truncate">{plugin.name}</h3>
            {isCustom && (
              <span className="text-[10px] px-1.5 py-0.5 bg-primary/20 text-primary font-medium">
                Custom
              </span>
            )}
            {installed && (
              <span className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary">
                Installed
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isCustom ? plugin.marketplace : marketplaceName}
          </p>
        </div>
      </div>

      <p className="text-xs text-muted-foreground mb-3 line-clamp-2">
        {plugin.description}
      </p>

      {plugin.binaryRequired && (
        <div className="flex items-center gap-1.5 text-[10px] text-warning mb-3">
          <Info className="w-3 h-3" />
          <span>Requires: <code className="bg-warning/15 text-warning px-1 py-0.5">{plugin.binaryRequired}</code></span>
        </div>
      )}

      {plugin.tags && plugin.tags.filter(t => t !== 'custom' && t !== 'installed').length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {plugin.tags.filter(t => t !== 'custom' && t !== 'installed').slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="text-[10px] px-1.5 py-0.5 bg-secondary text-muted-foreground flex items-center gap-1"
            >
              <Tag className="w-2.5 h-2.5" />
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 mt-auto pt-2 border-t border-border">
        {installed ? (
          <span className="flex-1 text-center text-xs text-primary py-1.5">
            Already installed
          </span>
        ) : (
          <>
            <Button
              variant="primary"
              size="sm"
              onClick={() => onInstall(plugin)}
              disabled={isInstalling}
              className="flex-1"
            >
              {isInstalling ? (
                <>
                  <BrandSpinner size={14} />
                  Installing
                </>
              ) : hasElectron ? (
                'Install'
              ) : (
                'Copy Command'
              )}
            </Button>
            {/* The word, not a clipboard glyph - the two states read out loud. */}
            <Button
              size="sm"
              onClick={() => onCopy(plugin)}
              className="font-mono"
              title="Copy install command"
            >
              {justCopied ? 'copied' : 'copy'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
});

export default function PluginsTab() {
  const { data, loading } = useClaude();
  const { plugins: PLUGINS_DATABASE, categories: PLUGIN_CATEGORIES, marketplaces: MARKETPLACES, authors: AUTHORS, loading: pluginsLoading, error: pluginsError, refresh: refreshPlugins } = usePluginsDatabase();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedMarketplace, setSelectedMarketplace] = useState<string | null>(null);
  const [selectedAuthor, setSelectedAuthor] = useState<string | null>(null);
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const [showMarketplaceDropdown, setShowMarketplaceDropdown] = useState(false);
  const [showAuthorDropdown, setShowAuthorDropdown] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [copiedPlugin, setCopiedPlugin] = useState<string | null>(null);
  const [showToast, setShowToast] = useState<{ message: string; type: 'success' | 'info' | 'error' } | null>(null);
  const [selectedPlugin, setSelectedPlugin] = useState<Plugin | null>(null);
  const [hasElectron, setHasElectron] = useState(false);
  const [installingPlugin, setInstallingPlugin] = useState<string | null>(null);

  // Terminal modal for installation
  const [showInstallTerminal, setShowInstallTerminal] = useState(false);
  const [currentInstallCommand, setCurrentInstallCommand] = useState('');
  const [currentInstallPtyId, setCurrentInstallPtyId] = useState<string | null>(null);
  const [installComplete, setInstallComplete] = useState(false);
  const [installExitCode, setInstallExitCode] = useState<number | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const [pendingInstallCommand, setPendingInstallCommand] = useState<string | null>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<import('xterm').Terminal | null>(null);
  const ptyIdRef = useRef<string | null>(null);

  // Follows the app theme; applied to the live terminal below instead of at
  // init, so a theme flip never tears down the PTY-attached instance.
  const terminalTheme = useTerminalTheme();

  useEffect(() => {
    setHasElectron(isElectron());
  }, []);

  // Initialize xterm when terminal modal opens
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

      // Handle user input - send to PTY. This one filtered nothing at all, so
      // every reply the terminal made to the installer went back into it
      // verbatim. See stripTerminalReplies.
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

      // Terminal is ready - signal that we can start the PTY
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

  // Repaint on app theme change
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = terminalTheme;
    }
  }, [terminalTheme]);

  // Start PTY only after terminal is ready
  useEffect(() => {
    if (!terminalReady || !pendingInstallCommand || !window.electronAPI?.plugin?.installStart) return;

    const startPty = async () => {
      try {
        const result = await window.electronAPI?.plugin?.installStart({ command: pendingInstallCommand });
        if (!result) {
          throw new Error('Failed to start installation');
        }
        setCurrentInstallPtyId(result.id);
        ptyIdRef.current = result.id;
        setPendingInstallCommand(null);
      } catch (err) {
        setShowToast({
          message: `Failed to start installation: ${err instanceof Error ? err.message : 'Unknown error'}`,
          type: 'error',
        });
        setInstallingPlugin(null);
        setShowInstallTerminal(false);
        setTimeout(() => setShowToast(null), 4000);
      }
    };

    startPty();
  }, [terminalReady, pendingInstallCommand]);

  // Listen for PTY data - always subscribe when in electron
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.plugin?.onPtyData) return;

    const unsubscribe = window.electronAPI.plugin.onPtyData(({ id, data }) => {
      if (id === ptyIdRef.current && xtermRef.current) {
        xtermRef.current.write(data);
      }
    });

    return unsubscribe;
  }, []);

  // Listen for PTY exit - always subscribe when in electron
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.plugin?.onPtyExit) return;

    const unsubscribe = window.electronAPI.plugin.onPtyExit(({ id, exitCode }) => {
      if (id === ptyIdRef.current) {
        setInstallComplete(true);
        setInstallExitCode(exitCode);
        setInstallingPlugin(null);
      }
    });

    return unsubscribe;
  }, []);

  // Debounced search handler
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearch(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setDebouncedSearch(value), 200);
  }, []);

  // Get installed plugins from settings
  const installedPlugins = useMemo(() => {
    const enabledPlugins = data?.settings?.enabledPlugins || {};
    return Object.keys(enabledPlugins).filter(key => enabledPlugins[key]);
  }, [data?.settings?.enabledPlugins]);

  // Pre-compute O(1) lookup structures for installed checks
  const installedLookup = useMemo(() => {
    const exact = new Set<string>();
    const lower = new Set<string>();
    const byName = new Set<string>();
    for (const p of installedPlugins) {
      exact.add(p);
      lower.add(p.toLowerCase());
      const atIdx = p.indexOf('@');
      if (atIdx > 0) byName.add(p.substring(0, atIdx));
    }
    return { exact, lower, byName };
  }, [installedPlugins]);

  const isPluginInstalled = useCallback((pluginName: string, marketplace: string): boolean => {
    const fullName = `${pluginName}@${marketplace}`;
    return (
      installedLookup.exact.has(fullName) ||
      installedLookup.lower.has(fullName.toLowerCase()) ||
      installedLookup.byName.has(pluginName)
    );
  }, [installedLookup]);

  // Create custom plugin entries for installed plugins not in the database
  const customInstalledPlugins = useMemo((): Plugin[] => {
    const dbNames = new Set<string>();
    const dbKeys = new Set<string>();
    const dbKeysLower = new Set<string>();
    for (const p of PLUGINS_DATABASE) {
      dbNames.add(p.name);
      const key = `${p.name}@${p.marketplace}`;
      dbKeys.add(key);
      dbKeysLower.add(key.toLowerCase());
    }

    return installedPlugins
      .filter(pluginKey => {
        const [name] = pluginKey.split('@');
        return !dbNames.has(name) && !dbKeys.has(pluginKey) && !dbKeysLower.has(pluginKey.toLowerCase());
      })
      .map(pluginKey => {
        const [name, marketplace] = pluginKey.split('@');
        return {
          name: name || pluginKey,
          description: 'Custom installed plugin',
          category: 'Productivity' as const,
          marketplace: marketplace || 'custom',
          tags: ['custom', 'installed'],
        };
      });
  }, [PLUGINS_DATABASE, installedPlugins]);

  // Filter plugins (uses debouncedSearch to avoid re-filtering on every keystroke)
  const filteredPlugins = useMemo(() => {
    let plugins: Plugin[] = [...PLUGINS_DATABASE, ...customInstalledPlugins];

    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      plugins = plugins.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q) ||
          p.tags?.some(t => t.toLowerCase().includes(q))
      );
    }

    if (selectedCategory) {
      plugins = plugins.filter((p) => p.category === selectedCategory);
    }

    if (selectedMarketplace) {
      plugins = plugins.filter((p) => p.marketplace === selectedMarketplace);
    }

    if (selectedAuthor) {
      plugins = plugins.filter((p) => p.author === selectedAuthor);
    }

    // Sort installed plugins first using O(1) Set lookups
    plugins.sort((a, b) => {
      const aInstalled = isPluginInstalled(a.name, a.marketplace);
      const bInstalled = isPluginInstalled(b.name, b.marketplace);
      if (aInstalled && !bInstalled) return -1;
      if (!aInstalled && bInstalled) return 1;
      return 0;
    });

    return plugins;
  }, [PLUGINS_DATABASE, debouncedSearch, selectedCategory, selectedMarketplace, selectedAuthor, isPluginInstalled, customInstalledPlugins]);

  // Pre-compute per-card metadata to avoid repeated lookups in render
  const cardData = useMemo(() => {
    const customSet = new Set(
      customInstalledPlugins.map(p => `${p.name}@${p.marketplace}`)
    );
    const marketplaceNames = new Map(
      MARKETPLACES.map(m => [m.id, m.name])
    );
    return filteredPlugins.map(plugin => ({
      plugin,
      installed: isPluginInstalled(plugin.name, plugin.marketplace),
      isCustom: customSet.has(`${plugin.name}@${plugin.marketplace}`),
      marketplaceName: marketplaceNames.get(plugin.marketplace) || plugin.marketplace,
    }));
  }, [filteredPlugins, customInstalledPlugins, MARKETPLACES, isPluginInstalled]);

  // Only the first `visibleCount` cards are mounted; "Load more" grows the slice.
  // The window is reset during render (not in an effect) whenever the filters
  // change, so a filter reset can never commit the previous, larger slice first.
  const filterKey = `${debouncedSearch}\u0000${selectedCategory}\u0000${selectedMarketplace}\u0000${selectedAuthor}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey);
    setVisibleCount(PAGE_SIZE);
  }

  const visibleCards = useMemo(
    () => cardData.slice(0, visibleCount),
    [cardData, visibleCount]
  );
  const remainingCount = Math.max(0, cardData.length - visibleCards.length);

  const getInstallCommand = useCallback((plugin: Plugin) => {
    // The catalogue command registers the marketplace first: installing by
    // name alone fails whenever that marketplace was never added.
    return plugin.installCommand || `/plugin install ${plugin.name}@${plugin.marketplace}`;
  }, []);

  const copyInstallCommand = useCallback(async (plugin: Plugin) => {
    try {
      await navigator.clipboard.writeText(getInstallCommand(plugin));
      setCopiedPlugin(plugin.name);
      setShowToast({
        message: `Command copied! Run in Claude Code to install "${plugin.name}"`,
        type: 'success',
      });
      setTimeout(() => {
        setCopiedPlugin(null);
        setShowToast(null);
      }, 3000);
    } catch {
      setShowToast({
        message: 'Failed to copy to clipboard',
        type: 'error',
      });
      setTimeout(() => setShowToast(null), 3000);
    }
  }, [getInstallCommand]);

  const handleInstall = useCallback(async (plugin: Plugin) => {
    const installCommand = getInstallCommand(plugin);

    if (hasElectron && window.electronAPI?.plugin?.installStart) {
      setInstallingPlugin(plugin.name);
      setCurrentInstallCommand(installCommand);
      setInstallComplete(false);
      setInstallExitCode(null);
      setShowInstallTerminal(true);
      setPendingInstallCommand(installCommand);
    } else {
      await copyInstallCommand(plugin);
    }
  }, [hasElectron, getInstallCommand, copyInstallCommand]);

  const closeInstallTerminal = () => {
    if (ptyIdRef.current && window.electronAPI?.plugin?.installKill) {
      window.electronAPI.plugin.installKill({ id: ptyIdRef.current });
    }
    setShowInstallTerminal(false);
    setCurrentInstallCommand('');
    setCurrentInstallPtyId(null);
    setInstallComplete(false);
    setInstallExitCode(null);
    setInstallingPlugin(null);
    ptyIdRef.current = null;
  };

  if ((loading && !data) || pluginsLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <LoadingPanel what="Reading the plugin marketplaces" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex flex-col gap-3 shrink-0">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-muted-foreground text-xs lg:text-sm hidden sm:block">
            Extend Claude Code with plugins for code intelligence, integrations, and workflows
          </p>
          <a
            href="https://code.claude.com/docs/en/discover-plugins"
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-8 items-center justify-center gap-2 px-3 bg-secondary text-muted-foreground hover:text-foreground border border-border hover:bg-secondary/80 transition-colors text-sm shrink-0"
          >
            <ExternalLink className="w-4 h-4" />
            <span className="hidden sm:inline">Documentation</span>
            <span className="sm:hidden">Docs</span>
          </a>
        </div>

        {/* Claude-only banner */}
        <div className="flex rounded-lg items-center gap-2 px-3 py-2 bg-primary/10 border border-primary/10 text-xs text-primary">
          <Info className="w-3.5 h-3.5 shrink-0" />
          <span>Plugins are only available for <strong>Claude Code</strong>. Codex and Gemini CLI do not support plugins.</span>
        </div>

        {/* Stats row */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-xs lg:text-sm text-muted-foreground">
            <span className="font-medium">{PLUGINS_DATABASE.length + customInstalledPlugins.length}</span> plugins
          </div>
          <div className="text-xs lg:text-sm text-muted-foreground">
            <span className="font-medium">{installedPlugins.length}</span> installed
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      <AnimatePresence>
        {showToast && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={`p-4 border flex items-center justify-between mt-4 ${showToast.type === 'success'
              ? 'bg-primary/10 border-primary/30 text-primary'
              : showToast.type === 'error'
                ? 'bg-danger/10 border-danger/30 text-danger'
                : 'bg-secondary border-border text-foreground'
              }`}
          >
            <div className="flex items-center gap-3">
              {showToast.type === 'error' ? (
                <XCircle className="w-5 h-5" />
              ) : showToast.type === 'success' ? (
                <CheckCircle className="w-5 h-5" />
              ) : (
                <TerminalIcon className="w-5 h-5" />
              )}
              <p className="text-sm">{showToast.message}</p>
            </div>
            <button onClick={() => setShowToast(null)} className="p-1 hover:opacity-70">
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Search & Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mt-4 shrink-0">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={handleSearchChange}
            placeholder="Search plugins by name, description, or tags..."
            className="w-full h-8 pl-9 pr-3 text-sm bg-secondary border border-border focus:border-foreground focus:outline-none"
          />
        </div>

        {/* Category Filter */}
        <div className="relative">
          <button
            onClick={() => {
              setShowCategoryDropdown(!showCategoryDropdown);
              setShowMarketplaceDropdown(false);
              setShowAuthorDropdown(false);
            }}
            className="flex h-8 items-center gap-2 px-3 bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors w-full sm:w-auto sm:min-w-[160px] text-sm"
          >
            <Filter className="w-4 h-4" />
            {selectedCategory || 'All Categories'}
            <ChevronDown className="w-4 h-4 ml-auto" />
          </button>

          {showCategoryDropdown && <div className="fixed inset-0 z-10" onClick={() => setShowCategoryDropdown(false)} />}
          <AnimatePresence>
            {showCategoryDropdown && (
              <motion.div
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 5 }}
                className="absolute top-full mt-2 right-0 w-48 bg-card border border-border rounded-none z-20 py-2 max-h-80 overflow-y-auto"
              >
                <button
                  onClick={() => {
                    setSelectedCategory(null);
                    setShowCategoryDropdown(false);
                  }}
                  className={`w-full text-left px-4 py-2 text-sm hover:bg-secondary ${!selectedCategory ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                >
                  All Categories
                </button>
                {PLUGIN_CATEGORIES.map((cat) => {
                  const Icon = CATEGORY_ICONS[cat] || Puzzle;
                  return (
                    <button
                      key={cat}
                      onClick={() => {
                        setSelectedCategory(cat);
                        setShowCategoryDropdown(false);
                      }}
                      className={`w-full text-left px-4 py-2 text-sm hover:bg-secondary flex items-center gap-2 ${selectedCategory === cat ? 'text-foreground' : 'text-muted-foreground'
                        }`}
                    >
                      <Icon className="w-4 h-4" />
                      {cat}
                    </button>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Marketplace Filter */}
        <div className="relative">
          <button
            onClick={() => {
              setShowMarketplaceDropdown(!showMarketplaceDropdown);
              setShowCategoryDropdown(false);
              setShowAuthorDropdown(false);
            }}
            className="flex h-8 items-center gap-2 px-3 bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors w-full sm:w-auto sm:min-w-[160px] text-sm"
          >
            <Puzzle className="w-4 h-4" />
            {selectedMarketplace ? MARKETPLACES.find(m => m.id === selectedMarketplace)?.name : 'All Sources'}
            <ChevronDown className="w-4 h-4 ml-auto" />
          </button>

          {showMarketplaceDropdown && <div className="fixed inset-0 z-10" onClick={() => setShowMarketplaceDropdown(false)} />}
          <AnimatePresence>
            {showMarketplaceDropdown && (
              <motion.div
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 5 }}
                className="absolute top-full mt-2 right-0 w-56 bg-card border border-border rounded-none z-20 py-2"
              >
                <button
                  onClick={() => { setSelectedMarketplace(null); setShowMarketplaceDropdown(false); }}
                  className={`w-full text-left px-4 py-2 text-sm hover:bg-secondary ${!selectedMarketplace ? 'text-foreground' : 'text-muted-foreground'}`}
                >
                  All Sources
                </button>
                {MARKETPLACES.map((marketplace) => (
                  <button
                    key={marketplace.id}
                    onClick={() => { setSelectedMarketplace(marketplace.id); setShowMarketplaceDropdown(false); }}
                    className={`w-full text-left px-4 py-2.5 text-sm hover:bg-secondary ${selectedMarketplace === marketplace.id ? 'text-foreground' : 'text-muted-foreground'}`}
                  >
                    <div className="font-medium">{marketplace.name}</div>
                    <div className="text-xs text-muted-foreground">{marketplace.description}</div>
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Author Filter */}
        <div className="relative">
          <button
            onClick={() => {
              setShowAuthorDropdown(!showAuthorDropdown);
              setShowCategoryDropdown(false);
              setShowMarketplaceDropdown(false);
            }}
            className="flex h-8 items-center gap-2 px-3 bg-secondary border border-border text-muted-foreground hover:text-foreground transition-colors w-full sm:w-auto sm:min-w-[160px] text-sm"
          >
            <User className="w-4 h-4" />
            {selectedAuthor || 'All Authors'}
            <ChevronDown className="w-4 h-4 ml-auto" />
          </button>

          {showAuthorDropdown && <div className="fixed inset-0 z-10" onClick={() => setShowAuthorDropdown(false)} />}
          <AnimatePresence>
            {showAuthorDropdown && (
              <motion.div
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 5 }}
                className="absolute top-full mt-2 right-0 w-56 bg-card border border-border rounded-none z-20 py-2 max-h-80 overflow-y-auto"
              >
                <button
                  onClick={() => { setSelectedAuthor(null); setShowAuthorDropdown(false); }}
                  className={`w-full text-left px-4 py-2 text-sm hover:bg-secondary ${!selectedAuthor ? 'text-foreground' : 'text-muted-foreground'}`}
                >
                  All Authors
                </button>
                {AUTHORS.map((author) => (
                  <button
                    key={author}
                    onClick={() => { setSelectedAuthor(author); setShowAuthorDropdown(false); }}
                    className={`w-full text-left px-4 py-2 text-sm hover:bg-secondary truncate ${selectedAuthor === author ? 'text-foreground' : 'text-muted-foreground'}`}
                  >
                    {author}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Plugins Grid */}
      <div className="flex-1 overflow-y-auto mt-4">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {visibleCards.map(({ plugin, installed, isCustom, marketplaceName }) => (
            <PluginCard
              key={`${plugin.marketplace}-${plugin.name}`}
              plugin={plugin}
              installed={installed}
              isCustom={isCustom}
              marketplaceName={marketplaceName}
              justCopied={copiedPlugin === plugin.name}
              isInstalling={installingPlugin === plugin.name}
              hasElectron={hasElectron}
              onInstall={handleInstall}
              onCopy={copyInstallCommand}
            />
          ))}
        </div>

        {remainingCount > 0 && (
          <div className="flex justify-center py-6 border-t border-border/50 mt-4">
            <Button onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>
              {`Load More (${remainingCount.toLocaleString()} remaining)`}
            </Button>
          </div>
        )}

        {/* An empty catalogue and an unreachable one looked identical: when every
            marketplace failed to fetch, the page offered "Clear filters" for a
            list that was never loaded. The hook has always returned the error;
            nothing read it. */}
        {cardData.length === 0 && pluginsError && (
          <ErrorState
            title="Could not reach the plugin marketplaces."
            detail={pluginsError}
            onRetry={refreshPlugins}
          />
        )}

        {cardData.length === 0 && !pluginsError && (
          <div className="flex flex-col items-center justify-center h-64">
            <Puzzle className="w-12 h-12 text-muted-foreground/30 mb-4" />
            <p className="text-muted-foreground">No plugins found matching your search</p>
            <button
              onClick={() => {
                setSearch('');
                setDebouncedSearch('');
                setSelectedCategory(null);
                setSelectedMarketplace(null);
                setSelectedAuthor(null);
              }}
              className="mt-3 text-sm text-foreground hover:underline"
            >
              Clear filters
            </button>
          </div>
        )}
      </div>

      {/* Plugin Details Modal */}
      {selectedPlugin && (
        <DialogShell
          title={selectedPlugin.name}
          onClose={() => setSelectedPlugin(null)}
          footerRight={
            <>
              <Button onClick={() => setSelectedPlugin(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  handleInstall(selectedPlugin);
                  setSelectedPlugin(null);
                }}
              >
                {hasElectron ? 'Install Plugin' : 'Copy Install Command'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted-foreground mb-4">{selectedPlugin.description}</p>
          <div className="p-3 bg-secondary border border-border font-mono text-xs">
            {getInstallCommand(selectedPlugin)}
          </div>
        </DialogShell>
      )}

      {/* Installation Terminal Modal */}
      {showInstallTerminal && (
        <DialogShell
          title="Installing plugin"
          subtitle={<span className="font-mono">{currentInstallCommand}</span>}
          width={860}
          onClose={closeInstallTerminal}
          footerLeft={
            // Raw status word, coloured by the status token - no pill.
            <span
              className={`text-xs font-mono ${!installComplete
                ? 'text-status-running'
                : installExitCode === 0
                  ? 'text-status-idle'
                  : 'text-status-error'
                }`}
            >
              {!installComplete
                ? 'running'
                : installExitCode === 0
                  ? 'completed'
                  : `failed (${installExitCode})`}
            </span>
          }
          footerRight={<Button onClick={closeInstallTerminal}>Close</Button>}
        >
          {/* The wrapper behind the canvas is painted separately from it. */}
          <div ref={terminalRef} className={`h-[400px] p-2 ${TERMINAL_SURFACE_CLASS}`} />
        </DialogShell>
      )}
    </div>
  );
}
