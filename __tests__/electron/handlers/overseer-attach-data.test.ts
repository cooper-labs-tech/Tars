import '../../setup/home-guard';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * overseer:attachData, what a paste or a drop on the Hermes page needs (#124,
 * contract 3): the upload overseer:attachFiles does, without its dialog.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. It opens the file dialog anyway, so a paste asks the person to pick the
 *    file they just pasted.
 * 2. The bytes reach the gateway altered: anything but their exact base64.
 * 3. A file over the 12 MB cap goes up anyway, or sinks the ones beside it.
 * 4. Something that is not bytes (a string, an object) is sent as if it were.
 * 5. With Hermes not configured it says nothing about why.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const showOpenDialog = vi.fn();
const upload = vi.fn();
let connection: object | null = { url: 'http://hermes.test', token: 't' };

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); } },
  dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) },
}));
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));
vi.mock('../../../electron/services/hermes-config', () => ({ usableHermesConnection: () => connection }));
vi.mock('../../../electron/services/hermes-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/services/hermes-client')>()),
  uploadHermesAttachment: (...args: unknown[]) => upload(...args),
}));

type Result = { success: boolean; error?: string; attachments: Array<{ name: string; path: string; bytes: number; isImage: boolean }> };
const attachData = (files: unknown) => handlers.get('overseer:attachData')!(null, files) as Promise<Result>;

beforeEach(async () => {
  handlers.clear();
  showOpenDialog.mockReset();
  upload.mockReset();
  upload.mockImplementation(async (_conn: unknown, file: { name: string; mimeType: string; bytes: number }) => ({
    success: true,
    attachment: { name: file.name, path: `~/.hermes/uploads/${file.name}`, bytes: file.bytes, isImage: file.mimeType.startsWith('image/') },
  }));
  connection = { url: 'http://hermes.test', token: 't' };
  const { registerOverseerHandlers } = await import('../../../electron/handlers/overseer-handlers');
  registerOverseerHandlers();
});

describe('a file pasted or dropped on the Hermes page', () => {
  it('goes up with its exact bytes, and no dialog', async () => {
    const result = await attachData([{ name: 'shot.png', mimeType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) }]);

    expect(result.success, result.error).toBe(true);
    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][1]).toMatchObject({
      name: 'shot.png', mimeType: 'image/png', bytes: 4, base64: Buffer.from([137, 80, 78, 71]).toString('base64'),
    });
    expect(result.attachments).toEqual([{ name: 'shot.png', path: '~/.hermes/uploads/shot.png', bytes: 4, isImage: true }]);
  });

  it('refuses what is too large or not bytes, names it, and sends the rest', async () => {
    const result = await attachData([
      { name: 'big.bin', mimeType: 'application/octet-stream', data: new Uint8Array(12 * 1024 * 1024 + 1) },
      { name: 'odd.txt', mimeType: 'text/plain', data: 'hello' },
      { name: 'ok.txt', mimeType: 'text/plain', data: new Uint8Array([104, 105]) },
    ]);

    expect(result.success).toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(result.attachments.map(a => a.name)).toEqual(['ok.txt']);
    expect(result.error).toMatch(/big\.bin/);
    expect(result.error).toMatch(/odd\.txt/);
  });

  it('says Hermes is not configured when it is not', async () => {
    connection = null;
    const result = await attachData([{ name: 'a.txt', mimeType: 'text/plain', data: new Uint8Array([1]) }]);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not configured/i);
    expect(upload).not.toHaveBeenCalled();
  });
});
