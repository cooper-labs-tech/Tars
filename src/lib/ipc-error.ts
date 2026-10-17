import { flat } from '@/lib/stop-line';

/**
 * The reason a call to the main process failed, as a dialog shows it: what was
 * thrown, on one line, without the words Electron puts before every error that
 * crosses from main ("Error invoking remote method '<channel>': Error: "), or
 * the fallback when it says nothing. Its failures are listed, and pinned, in
 * __tests__/lib/ipc-error.test.ts.
 */

const ELECTRONS_WORDS = /^Error invoking remote method '[^']+':\s*(Error:\s*)?/;

export function ipcReason(thrown: unknown, fallback: string): string {
  const message = typeof thrown === 'string'
    ? thrown
    : thrown && typeof thrown === 'object' && typeof (thrown as { message?: unknown }).message === 'string'
      ? (thrown as { message: string }).message
      : '';
  return flat(message.replace(ELECTRONS_WORDS, '')) || fallback;
}
