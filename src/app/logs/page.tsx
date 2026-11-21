'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { lastPathPart, pathName } from '@/lib/display-path';
import { Search } from 'lucide-react';
import { PageHeader, Panel, PanelCaption, BrandSpinner, LoadingState, StatusSquare } from '@/components/ui';
import { SquareGrid } from '@/components/Splash';
import type { AgentNotice, FleetEntry, LogLine } from '@/types/electron';
import { useAllAgentNotices } from '@/hooks/useAgentNotices';
import { logMatcher, noticeTone, noticeWho, resultsWithNotices, tailWithNotices } from '@/lib/agent-notices';

/**
 * One of Tars's notices among an agent's lines: who wrote it and when, its tone, the line, as text. Frame: `Agent
 * notices (2.0.7) · in its panel and in Logs`. Only a notice Tars kept is drawn so (lib/agent-notices.ts).
 */
function NoticeLine({ notice }: { notice: AgentNotice }) {
  return (
    <span data-log-notice={notice.id} className="flex items-center gap-2.5 px-2 py-1 bg-secondary">
      <StatusSquare tone={noticeTone(notice.kind)} />
      <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{noticeWho(notice)}</span>
      <span className="min-w-0 text-[11.5px] text-foreground break-words">{notice.line}</span>
    </span>
  );
}

/** The agents main reads from a running terminal's screen, as it reads them now: those with a terminal. */
async function screenAgents(): Promise<ReadonlySet<string>> {
  const list = await window.electronAPI?.agent?.list?.().catch(() => undefined);
  return new Set((list ?? []).filter(a => !!a.ptyId).map(a => a.id));
}

/**
 * One search box for the whole fleet.
 *
 * Each agent's output lived only in its own terminal, so finding which agent
 * hit an error meant opening every one of them. A plain substring works, and
 * /regex/ is honoured when the query is delimited.
 */

const STATUS_TONE: Record<string, string> = {
  running: 'text-status-running',
  waiting: 'text-status-waiting',
  error: 'text-status-error',
  idle: 'text-status-idle',
};

export default function LogsPage() {
  const [query, setQuery] = useState('');
  const [fleet, setFleet] = useState<FleetEntry[]>([]);
  // False until the first fleet read answers: before that, no agent is known
  // to have produced nothing.
  const [fleetLoaded, setFleetLoaded] = useState(false);
  const [results, setResults] = useState<LogLine[] | null>(null);
  // The query those results answer: the notices are matched by it, not by what is typed since.
  const [searched, setSearched] = useState('');
  // The agents whose hits came from a screen, read with them: none of their lines is Tars's.
  const [screens, setScreens] = useState<ReadonlySet<string>>(() => new Set());
  const notices = useAllAgentNotices();
  const [scanned, setScanned] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [tail, setTail] = useState<{ lines: string[]; agentName: string; screen: boolean } | null>(null);
  const debounce = useRef<NodeJS.Timeout | null>(null);
  // Bumped on every search kicked off; a resolving search whose id no longer
  // matches is stale and must not overwrite a newer one's results.
  const searchSeq = useRef(0);

  const loadFleet = useCallback(async () => {
    try {
      const res = await window.electronAPI?.logs?.fleet();
      setFleet(res?.agents ?? []);
    } finally {
      setFleetLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadFleet();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void loadFleet();
    }, 10_000);
    return () => clearInterval(id);
  }, [loadFleet]);

  /** The project an agent belongs to, as a name rather than a path. */
  const projectOf = (a: { projectPath: string }) =>
    pathName(a.projectPath) || a.projectPath;

  // Grouped by project, then by name, so the headings below are contiguous.
  const sortedFleet = useMemo(
    () => [...fleet].sort(
      (a, b) => projectOf(a).localeCompare(projectOf(b)) || a.agentName.localeCompare(b.agentName),
    ),
    [fleet],
  );

  const runSearch = useCallback(async (q: string) => {
    const seq = ++searchSeq.current;
    if (!q.trim()) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      const [res, onScreen] = await Promise.all([window.electronAPI?.logs?.search(q, { limit: 300 }), screenAgents()]);
      if (seq !== searchSeq.current) return; // a newer search or an agent click superseded this one
      setResults(res?.lines ?? []);
      setSearched(q);
      setScreens(onScreen);
      setScanned(res?.scannedAgents ?? 0);
      setTruncated(!!res?.truncated);
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void runSearch(query), 250);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [query, runSearch]);

  const openAgent = useCallback(async (agentId: string) => {
    // Invalidate any in-flight/pending search so it can't clobber the tail
    // view we're about to show, and drop out of the results branch so the
    // render actually switches to the tail (results !== null wins otherwise).
    searchSeq.current++;
    setSearching(false);
    setResults(null);
    setFocused(agentId);
    const [res, onScreen] = await Promise.all([window.electronAPI?.logs?.tail(agentId, 300), screenAgents()]);
    setTail(res ? { ...res, screen: onScreen.has(agentId) } : null);
  }, []);

  // Tars's notices among the hits and the tail: a replayed `[Tars] ` line that claims a kept notice as that notice,
  // every other line as the agent's, and the notices no line holds as a group of their own (lib/agent-notices.ts).
  const rows = useMemo(
    () => (results === null ? null : resultsWithNotices(results, notices, fleet, logMatcher(searched), screens)),
    [results, notices, fleet, searched, screens],
  );
  const tailRows = useMemo(
    () => (tail ? tailWithNotices(tail.lines, notices.filter(n => n.agentId === focused), tail.screen) : null),
    [tail, notices, focused],
  );

  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-44px)] flex flex-col">
      <PageHeader
        title="Logs"
        subtitle="Search every agent's output at once. Wrap the query in slashes for a regex."
      />

      {/* The query and what it found share one row: the count is about the
          search, so it reads at the end of the thing it counts. */}
      <div className="relative mb-3 shrink-0">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="error, ECONNREFUSED, /TypeError.*undefined/"
          className="w-full h-8 pl-8 pr-56 bg-secondary border border-border text-[15px] focus:border-primary/40 focus:outline-none"
        />
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-2">
          {searching && <BrandSpinner size={14} label="Searching" />}
          {rows !== null && (
            <span className="text-[11px] text-muted-foreground truncate">
              {rows.length} match{rows.length === 1 ? '' : 'es'} across {scanned} agent
              {scanned === 1 ? '' : 's'}
              {truncated ? ' (showing the first 300)' : ''}
            </span>
          )}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex gap-3">
        {/* Fleet */}
        <Panel fill className="w-[250px] shrink-0">
          <PanelCaption>
            {fleetLoaded ? `${fleet.length} agent${fleet.length === 1 ? '' : 's'}` : 'agents'}
          </PanelCaption>
          <div className="flex-1 min-h-0 overflow-y-auto mt-2 space-y-2">
            {sortedFleet.map((a, i) => (
              <div key={`g-${a.agentId}`} className="space-y-2">
              {/* The project name once, above its agents. A flat list of names
                  across three projects is unreadable, which is the same
                  problem Review had. */}
              {(i === 0 || projectOf(sortedFleet[i - 1]) !== projectOf(a)) && (
                <p
                  className={`font-mono text-[10px] font-medium text-text-secondary truncate ${i === 0 ? '' : 'pt-2'}`}
                  title={a.projectPath}
                >
                  {projectOf(a).toUpperCase()}
                </p>
              )}
              <button
                key={a.agentId}
                onClick={() => openAgent(a.agentId)}
                className={`w-full text-left h-[52px] px-2.5 flex flex-col justify-center gap-1 border transition-colors ${
                  a.agentId === focused
                    ? 'bg-secondary border-border-accent'
                    : 'bg-card border-border hover:border-border-accent'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-xs text-foreground truncate">{a.agentName}</span>
                  <span className={`text-[10px] shrink-0 ${STATUS_TONE[a.status] ?? 'text-muted-foreground'}`}>
                    {a.status}
                  </span>
                </span>
                <span className="block text-[10px] text-muted-foreground truncate font-mono">
                  {a.branch || projectOf(a)} · {a.lines} chunks
                </span>
              </button>
              </div>
            ))}
            {!fleetLoaded ? (
              <LoadingState loading what="Still reading your agents' output…" detail="listing every agent's terminal" />
            ) : fleet.length === 0 && (
              <p className="text-xs text-muted-foreground">No agent has produced output yet.</p>
            )}
          </div>
        </Panel>

        {/* Results or tail */}
        <Panel fill padded={false} className="flex-1 min-w-0">
          <div className="flex-1 min-h-0 overflow-auto p-4">
            {rows !== null ? (
              <div className="space-y-1">
                {rows.map(line => (
                  <button
                    key={line.key}
                    onClick={() => openAgent(line.agentId)}
                    className="w-full text-left px-2 py-1 hover:bg-secondary/60 transition-colors"
                  >
                    <span className="flex items-center gap-2 mb-0.5">
                      <span className="text-[10px] text-primary">{line.agentName}</span>
                      <span className="text-[10px] text-muted-foreground font-mono truncate">
                        {line.branch || lastPathPart(line.projectPath)}
                      </span>
                    </span>
                    {line.tars ? (
                      <NoticeLine notice={line.tars.notice} />
                    ) : (
                      <span className="block text-[11px] font-mono text-foreground break-all">{line.line}</span>
                    )}
                  </button>
                ))}
                {rows.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Nothing matched. Only what agents have produced this session is searchable.
                  </p>
                )}
              </div>
            ) : tail && tailRows ? (
              <>
                <p className="text-xs font-mono text-foreground mb-2">{tail.agentName}: last {tail.lines.length} lines</p>
                {/* The notices no line holds: a group of their own, by time, above the lines, which carry no time.
                    Frame: `Agent notices (2.0.7)`, a running agent's tail. */}
                {tailRows.group.length > 0 && (
                  <div data-log-notices-group className="mb-2 pb-2 border-b border-border">
                    <p className="font-mono text-[10px] text-muted-foreground pb-1">Tars&apos;s notices, by time</p>
                    {tailRows.group.map(n => <NoticeLine key={n.id} notice={n} />)}
                  </div>
                )}
                {tailRows.rows.map((row, i) =>
                  row.kind === 'notice' ? (
                    <NoticeLine key={row.notice.id} notice={row.notice} />
                  ) : (
                    <pre key={i} className="text-[11px] font-mono text-muted-foreground leading-relaxed whitespace-pre-wrap break-all">
                      {row.line}
                    </pre>
                  ),
                )}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                {/* The mark is the square grid, never a terminal prompt glyph:
                    a >_ here read as an old logo left behind. */}
                <SquareGrid filled={0} size={34} />
                <p className="text-sm text-muted-foreground">Search, or pick an agent to read its tail.</p>
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
