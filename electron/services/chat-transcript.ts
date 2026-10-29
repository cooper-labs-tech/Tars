/**
 * A chat's conversation, read from its runner's transcripts (ORCHESTRATOR-PER-CHAT.md
 * v2.2, 4.5): the transcripts are the source of truth, and this is the one
 * parser of them for the chat page. What the window shows of a chat:
 *
 * - the user's messages, and the lines Tars typed, each said to be from who
 *   sent it (`message` from an agent or a channel, `note` from Tars or from
 *   Claude Code itself);
 * - the runner's text;
 * - its tool calls, folded to one line each (`delegate_task -> Backend`);
 * - a divider where the conversation was compacted, or a new session began;
 * - and anything Tars does not know, as one raw line: a newer Claude Code's
 *   line is shown, never dropped.
 *
 * What it leaves out, by name: a tool's output, the runner's thinking, the
 * meta and compaction-summary user lines, the attachments Claude Code keeps
 * for the model (a message typed in during a turn excepted: it is a
 * `queued_command`), and its own bookkeeping lines (KNOWN_SKIPPED).
 *
 * Every item's id is its line's uuid (`:n` for the n-th part of a line after
 * the first), so the window can tell what it already shows.
 */

export type ChatItemKind = 'user' | 'message' | 'note' | 'text' | 'tool' | 'divider' | 'raw';

export interface ChatItem {
  id: string;
  sessionId: string;
  /** ISO, as the transcript has it; null for a line that carries none. */
  at: string | null;
  kind: ChatItemKind;
  text: string;
  /** Who a `message` or a `note` is from: an agent's name, a channel, Tars, Claude Code. */
  from?: string;
}

export interface ParseOptions {
  /** An agent's name, by id, for a tool line that names one (delegate_task -> Backend). */
  nameOf?: (agentId: string) => string | undefined;
  /**
   * The index in its file of the text's first line, for a text that is the
   * rest of a file read before (chat-history.ts reads what a transcript
   * gained): a line with no uuid is named by its index in the file.
   */
  firstLine?: number;
}

/** Lines Claude Code keeps for itself, by `type`. Anything else unknown is raw. */
const KNOWN_SKIPPED = new Set([
  'attachment', 'mode', 'permission-mode', 'ai-title', 'last-prompt', 'atis-latch', 'pr-link',
  'file-history-snapshot', 'file-history-delta', 'queue-operation', 'cost-state', 'summary', 'custom-title',
]);
/** `system` lines that are bookkeeping: a compaction is the one shown. */
const SYSTEM_SKIPPED = new Set(['turn_duration', 'stop_hook_summary', 'informational', 'local_command', 'api_error']);

const TOOL_LINE_MAX = 120;
const RAW_MAX = 200;

const oneLine = (text: string, max: number): string => {
  const first = text.split(/\r?\n|\r/).find((l) => l.trim()) ?? '';
  const chars = Array.from(first.trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
};

const tag = (text: string, name: string): string | undefined => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();

/** The envelope Tars types before a message (core/pty-manager.ts senderLine), with the line break that ends it since 2.0.6. */
const AGENT_ENVELOPE = /^Message from agent ("(?:[^"\\]|\\.)*") \("(?:[^"\\]|\\.)*"\)(?:, task t-[0-9a-f]{8})?: \n?/;
const OTHER_ENVELOPE = /^Message from (Tars|the user via [A-Za-z]+|[A-Z][A-Za-z]+)(?:, task t-[0-9a-f]{8})?: \n?/;

/** A user line's words, said as who they are from. Undefined: not conversation. */
function userItem(text: string): Pick<ChatItem, 'kind' | 'text' | 'from'> | undefined {
  const t = text.trimStart();
  if (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-stderr>')) return undefined;
  if (t.startsWith('<task-notification>')) {
    const status = tag(t, 'status');
    const summary = tag(t, 'summary');
    return { kind: 'note', from: 'Claude Code', text: `background task${status ? ` ${status}` : ''}${summary ? `: ${summary}` : ''}` };
  }
  const command = tag(t, 'command-name');
  if (command) {
    const args = tag(t, 'command-args');
    return { kind: 'user', text: `${command}${args ? ` ${args}` : ''}` };
  }
  const agent = AGENT_ENVELOPE.exec(t);
  if (agent) {
    let name: string;
    try { name = JSON.parse(agent[1]) as string; } catch { name = agent[1]; }
    return { kind: 'message', from: name, text: t.slice(agent[0].length) };
  }
  const other = OTHER_ENVELOPE.exec(t);
  if (other) {
    const body = t.slice(other[0].length);
    if (other[1] === 'Tars') return { kind: 'note', from: 'Tars', text: body };
    const via = /^the user via (.+)$/.exec(other[1]);
    return { kind: 'message', from: via ? via[1] : other[1], text: body };
  }
  if (t.startsWith('[Tars]')) return { kind: 'note', from: 'Tars', text: t };
  return { kind: 'user', text };
}

/** A tool call, as one short line. */
function toolLine(name: string, input: Record<string, unknown>, opts: ParseOptions): string {
  const short = name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
  const str = (k: string) => (typeof input[k] === 'string' ? input[k] as string : undefined);
  const agentId = str('id') ?? str('agentId');
  let line: string;
  if (agentId && /^(delegate_task|send_message|start_agent|stop_agent|wait_for_agent|get_agent|get_agent_output|remove_agent)$/.test(short)) {
    line = `${short} -> ${opts.nameOf?.(agentId) ?? agentId}`;
  } else if (short === 'Bash') {
    line = `Bash: ${oneLine(str('command') ?? '', TOOL_LINE_MAX)}`;
  } else if (str('file_path')) {
    line = `${short} ${str('file_path')}`;
  } else {
    const first = Object.values(input).find((v): v is string => typeof v === 'string');
    line = first ? `${short}: ${oneLine(first, TOOL_LINE_MAX)}` : short;
  }
  return oneLine(line, TOOL_LINE_MAX);
}

/** One raw line for what Tars cannot read or does not know. */
const raw = (id: string, sessionId: string, at: string | null, text: string): ChatItem =>
  ({ id, sessionId, at, kind: 'raw', text: oneLine(text, RAW_MAX) });

/** One transcript's items, in its order. */
export function transcriptItems(text: string, sessionId: string, opts: ParseOptions = {}): ChatItem[] {
  const items: ChatItem[] = [];
  const lines = text.split('\n');
  // The last line, unterminated, may still be being written: it waits.
  if (!text.endsWith('\n')) lines.pop();
  const first = opts.firstLine ?? 0;
  lines.forEach((line, i) => {
    const index = first + i;
    if (!line.trim()) return;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      items.push(raw(`${sessionId}:line:${index}`, sessionId, null, `an unreadable line: ${line}`));
      return;
    }
    if (!o || typeof o !== 'object') return;
    const type = typeof o.type === 'string' ? o.type : '';
    const id = typeof o.uuid === 'string' ? o.uuid : `${sessionId}:line:${index}`;
    const at = typeof o.timestamp === 'string' ? o.timestamp : null;
    const push = (n: number, item: Pick<ChatItem, 'kind' | 'text' | 'from'>) =>
      items.push({ id: n === 0 ? id : `${id}:${n}`, sessionId, at, ...item });

    if (type === 'user') {
      if (o.isMeta || o.isCompactSummary) return;
      const content = (o.message as { content?: unknown } | undefined)?.content;
      if (typeof content === 'string') {
        const item = userItem(content);
        if (item) push(0, item);
        return;
      }
      if (Array.isArray(content)) {
        // Tool results are folded; the words of a message with parts are its text parts.
        const words = content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text as string).join('\n');
        const images = content.filter((p) => p?.type === 'image').length;
        if (!words && !images) return;
        const item = userItem(words || '');
        if (item) push(0, { ...item, text: `${item.text}${images ? `${item.text ? ' ' : ''}[${images} image${images > 1 ? 's' : ''}]` : ''}` });
      }
      return;
    }
    if (type === 'assistant') {
      const content = (o.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) return;
      let n = 0;
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) push(n++, { kind: 'text', text: part.text });
        else if (part?.type === 'tool_use' && typeof part.name === 'string') {
          push(n++, { kind: 'tool', text: toolLine(part.name, (part.input && typeof part.input === 'object' ? part.input : {}) as Record<string, unknown>, opts) });
        }
      }
      return;
    }
    if (type === 'attachment') {
      const attachment = o.attachment as { type?: unknown; prompt?: unknown } | undefined;
      if (attachment?.type === 'queued_command' && typeof attachment.prompt === 'string') {
        const item = userItem(attachment.prompt);
        if (item) push(0, item);
      }
      return;
    }
    if (type === 'system') {
      if (o.subtype === 'compact_boundary') push(0, { kind: 'divider', text: 'compacted' });
      else if (!SYSTEM_SKIPPED.has(String(o.subtype))) items.push(raw(id, sessionId, at, `system ${String(o.subtype)}`));
      return;
    }
    if (KNOWN_SKIPPED.has(type)) return;
    items.push(raw(id, sessionId, at, `${type || 'untyped'} ${line}`));
  });
  return items;
}

/**
 * A chat's items across its sessions, in their order. A session after the
 * first starts with a divider; the history a resumed or forked session copies
 * from the one before is shown once (by uuid); a session whose transcript is
 * gone says so, and the others are read.
 */
export function chatItems(sessions: Array<{ sessionId: string; text: string | null }>, opts: ParseOptions = {}): ChatItem[] {
  return joinSessions(sessions.map(({ sessionId, text }) => ({ sessionId, items: text === null ? null : transcriptItems(text, sessionId, opts) })));
}

/**
 * The same, from each session's items as already read. `items` null: no
 * transcript. That says "gone", unless the session may still be written:
 * Claude Code creates a session's file lazily, so the runner's newest session
 * is in the chat before its file is, and reading it as gone, then as its
 * lines, shifted the items after it (the gate of #371, M1). Such a session
 * reads as empty until its file appears.
 */
export function joinSessions(sessions: Array<{ sessionId: string; items: ChatItem[] | null; mayBeWritten?: boolean }>): ChatItem[] {
  const seen = new Set<string>();
  const out: ChatItem[] = [];
  sessions.forEach(({ sessionId, items, mayBeWritten }, index) => {
    if (index > 0) out.push({ id: `${sessionId}:start`, sessionId, at: null, kind: 'divider', text: 'session' });
    if (items === null) {
      if (!mayBeWritten) out.push({ id: `${sessionId}:gone`, sessionId, at: null, kind: 'raw', text: `session ${sessionId}: its transcript is gone` });
      return;
    }
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  });
  return out;
}
