import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { restartPendingLine } from '../../src/components/TerminalsView/components/RestartPendingNotice';
import type { AgentRestartWait } from '../../src/types/electron';

/**
 * The line a panel shows while a changed setting waits to restart its agent
 * (#150). Written by the QA after the Audit's Low on #150: its renderer logic
 * had no test of its own (#131's rule).
 *
 * How this can fail:
 * 1. a wait reads as another one, or falls through to the generic sentence,
 *    and the person at the keyboard is told to wait when they are the one to act;
 * 2. a setting is shown under its code name (`permissionMode`) instead of its word;
 * 3. several settings run together without their `and`;
 * 4. no setting at all leaves an empty "for :".
 */

/** Every wait of electron/core/agent-restart.ts, and the end of the sentence it reads as. */
const WAITS: Record<AgentRestartWait, string> = {
  turn: 'it waits for this turn to end.',
  permission: 'it waits for its permission question to be answered.',
  note: 'it waits for a note owed to it to go in.',
  background: 'it waits for the work it left running to report back.',
  launch: 'it waits for its CLI to finish starting.',
  draft: 'it waits for you: send or clear what is typed in its field.',
  typing: 'it waits until nothing has been typed in its field for five seconds.',
  queued: 'it waits for the messages queued for its field to go in.',
  writing: 'it waits for the message Tars is typing into it to go in.',
};

describe('restartPendingLine', () => {
  it.each(Object.entries(WAITS) as Array<[AgentRestartWait, string]>)('says what a restart waiting on %s waits for', (wait, sentence) => {
    expect(restartPendingLine({ settings: ['model'], waitingFor: wait }).rest).toBe(sentence);
  });

  it('gives every wait a sentence of its own, none of them the fallback', () => {
    const sentences = (Object.keys(WAITS) as AgentRestartWait[]).map(wait => restartPendingLine({ settings: [], waitingFor: wait }).rest);
    expect(new Set(sentences).size).toBe(sentences.length);
    expect(sentences).not.toContain('it waits for the agent to be free.');
  });

  it('falls back to a plain sentence for a wait it does not know', () => {
    expect(restartPendingLine({ settings: ['model'], waitingFor: 'somewhere-new' as AgentRestartWait }).rest)
      .toBe('it waits for the agent to be free.');
  });

  it('names each setting in words, and joins them with a comma and a final and', () => {
    expect(restartPendingLine({ settings: ['model'], waitingFor: 'turn' }).who).toBe('Restart pending for model:');
    expect(restartPendingLine({ settings: ['model', 'effort'], waitingFor: 'turn' }).who).toBe('Restart pending for model and effort:');
    expect(restartPendingLine({ settings: ['model', 'effort', 'permissionMode'], waitingFor: 'turn' }).who)
      .toBe('Restart pending for model, effort and permissions:');
    expect(restartPendingLine({ settings: ['orchestrator', 'secondaryProjectPath', 'obsidianVaultPaths', 'localModel'], waitingFor: 'turn' }).who)
      .toBe('Restart pending for the orchestrator role, the second project, the vaults and the local model:');
  });

  it('keeps a setting it has no word for under its own name', () => {
    expect(restartPendingLine({ settings: ['model', 'somethingNew'], waitingFor: 'turn' }).who).toBe('Restart pending for model and somethingNew:');
  });

  it('says only that a restart is pending when no setting is named', () => {
    expect(restartPendingLine({ settings: [], waitingFor: 'draft' }).who).toBe('Restart pending:');
    expect(restartPendingLine({ settings: undefined as unknown as string[], waitingFor: 'draft' }).who).toBe('Restart pending:');
  });
});
