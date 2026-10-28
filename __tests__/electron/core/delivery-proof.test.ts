import { describe, it, expect } from 'vitest';
import { deliveryVerdict, taskOnRecord } from '../../../electron/core/delivery-proof';

/**
 * A task goes into an agent once (the DB brief fix-twin-deliveries-2810.md): electron/core/delivery-proof.ts, which
 * the delivery check reads before it types a task again or says it never began.
 *
 * Measured over 23 to 28/10: three launch tasks retyped by Tars into a session that already held them (300 s, 894 s
 * and 3899 s later), each run twice; the check typed it again 15 s after the session registered, by the clock alone,
 * while the CLI's UserPromptSubmit hooks still ran (36 s under load), and then said `error`, "never began".
 *
 * How it fails, written before the code:
 * D1 a turn that began after the session registered is not taken as the task in;
 * D2 the task on record in the CLI's transcript (its prompt's entry, or a copy the CLI queued itself) is not taken as
 *    in, so it is typed again;
 * D3 a CLI that has not said it is idle at its prompt since it registered (its hooks still running, a slow start) has
 *    the task typed again, or is said never to have begun, by the clock alone;
 * D4 a CLI idle at its prompt with nothing of the task on record is never given it again;
 * D5 typed again, then idle at its prompt with nothing of it on record still, it is not said never to have begun; or
 *    it is typed a third time;
 * D6 typed again, and not idle since, it is said never to have begun, or typed again;
 * R1 the record reads the task where it is not (another task's words, an assistant quoting nothing), or misses it in
 *    a prompt entry, a queued command or the CLI's own queue, or in JSON's escaping of quotes and line breaks.
 */

const T0 = 1_000_000;
const facts = (o: Partial<Parameters<typeof deliveryVerdict>[0]>) => ({
  registeredAt: T0, turnStartedAt: undefined, idlePromptAt: undefined, retypedAt: undefined, onRecord: false, ...o,
});

describe('deliveryVerdict', () => {
  it('D1: a turn after the registration is the task in', () => {
    expect(deliveryVerdict(facts({ turnStartedAt: T0 + 40_000 }))).toBe('taken');
    expect(deliveryVerdict(facts({ turnStartedAt: T0 - 1 }))).not.toBe('taken');
  });
  it('D2: the task on record is in, late', () => {
    expect(deliveryVerdict(facts({ onRecord: true }))).toBe('taken');
    expect(deliveryVerdict(facts({ onRecord: true, idlePromptAt: T0 + 70_000 }))).toBe('taken');
  });
  it('D3: not idle since it registered, it waits: never typed again, never said not begun', () => {
    expect(deliveryVerdict(facts({}))).toBe('wait');
    expect(deliveryVerdict(facts({ idlePromptAt: T0 - 5 }))).toBe('wait');
  });
  it('D4: idle at its prompt with nothing of it on record, it is given the task again', () => {
    expect(deliveryVerdict(facts({ idlePromptAt: T0 + 3_000 }))).toBe('retype');
  });
  it('D5: typed again and idle since with nothing on record, it never began; never typed a third time', () => {
    expect(deliveryVerdict(facts({ idlePromptAt: T0 + 80_000, retypedAt: T0 + 20_000 }))).toBe('never-began');
  });
  it('D6: typed again and not idle since, it waits', () => {
    expect(deliveryVerdict(facts({ idlePromptAt: T0 + 3_000, retypedAt: T0 + 20_000 }))).toBe('wait');
  });
});

const entry = (o: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-10-28T12:00:00.000Z', ...o });
describe('taskOnRecord', () => {
  const task = 'Read your brief "lot2" first,\nthen do it';
  it('R1: found in a prompt entry, a queued command and the CLI\'s own queue, escaped as JSON escapes it', () => {
    expect(taskOnRecord(entry({ type: 'user', message: { role: 'user', content: `[Tars: you are agent "x"]\n\n${task}` } }), task)).toBe(true);
    expect(taskOnRecord(entry({ type: 'attachment', attachment: { type: 'queued_command', prompt: `Message from Tars: ${task}` } }), task)).toBe(true);
    expect(taskOnRecord(entry({ type: 'queue-operation', operation: 'enqueue', content: task }), task)).toBe(true);
  });
  it('R1: not in another task\'s words, nor in what the model writes', () => {
    expect(taskOnRecord(entry({ type: 'user', message: { role: 'user', content: 'Read your brief "lot3" first' } }), task)).toBe(false);
    expect(taskOnRecord(entry({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: task }] } }), task)).toBe(false);
    expect(taskOnRecord('', task)).toBe(false);
    expect(taskOnRecord(entry({ type: 'user', message: { role: 'user', content: task } }), '   ')).toBe(false);
  });
});
