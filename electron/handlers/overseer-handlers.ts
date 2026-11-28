import { ipcMain, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getMainWindow } from '../core/window-manager';
import { MIME_TYPES } from '../constants';
import {
  askOverseer,
  getOverseerHistory,
  clearOverseerHistory,
  buildFleetSnapshot,
  confirmPendingAction,
  pauseOverseerWatch,
  resumeOverseerWatch,
  isOverseerWatchPaused,
  getLastWatchFailure,
  isOverseerBusy,
  getOverseerSettings,
  setOverseerSettings,
  applyOverseerModel,
  OverseerAction,
  OverseerAttachment,
  OverseerSettings,
} from '../services/overseer';
import { AUTO_ACTION_RULES } from '../services/overseer-auto';
import { usableHermesConnection } from '../services/hermes-config';
import {
  fetchHermesModelOptions,
  uploadHermesAttachment,
  reachingHermes,
  MAX_ATTACHMENT_BYTES,
} from '../services/hermes-client';
import {
  getReasoningEffort,
  setReasoningEffort,
  REASONING_EFFORTS,
} from '../services/hermes-session';

/**
 * Enough to tell the gateway an image from a file, which is the only decision
 * that rides on it: images take the image endpoint, everything else takes the
 * file endpoint. The app's own map covers the common cases; the extras here are
 * the ones a person actually drags into a chat.
 */
const EXTRA_MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.heic': 'image/heic',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
};

function mimeTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || EXTRA_MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * IPC surface for the Chat · Overseer page. Mirrors the shape of
 * hermes-handlers.ts: thin handlers, all the logic lives in the service
 * (electron/services/overseer.ts).
 */
export function registerOverseerHandlers(): void {
  ipcMain.handle('overseer:send', async (
    _event,
    message: string,
    attachments?: OverseerAttachment[],
  ) => {
    const staged = Array.isArray(attachments) ? attachments : [];
    // A message that is only files still says something, so it is not empty.
    if (typeof message !== 'string' || (!message.trim() && staged.length === 0)) {
      return { ok: false, reason: 'error', error: 'Message is empty.' };
    }
    return askOverseer(message.trim(), staged.length ? { attachments: staged } : {});
  });

  /**
   * Pick files and put them on the gateway.
   *
   * The picking and the reading both happen here rather than in the renderer:
   * Electron stopped exposing a real path on the renderer's File objects, and
   * the gateway wants a data URL, so the main process is the only side that can
   * go from "the user chose this" to "the gateway has it" without the file
   * making a pointless detour through the window.
   */
  ipcMain.handle('overseer:attachFiles', async () => {
    const conn = usableHermesConnection();
    if (!conn) return { success: false, error: 'Hermes is not configured. Set it up in Settings.' };

    const win = getMainWindow();
    const picked = await dialog.showOpenDialog(win!, {
      title: 'Attach to the message',
      properties: ['openFile', 'multiSelections'],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { success: true, attachments: [], canceled: true };
    }

    const attachments: OverseerAttachment[] = [];
    const errors: string[] = [];
    for (const filePath of picked.filePaths) {
      const name = path.basename(filePath);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.size > MAX_ATTACHMENT_BYTES) {
          errors.push(`${name} is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB.`);
          continue;
        }
        const buffer = await fs.promises.readFile(filePath);
        const uploaded = await uploadHermesAttachment(conn, {
          name,
          mimeType: mimeTypeFor(filePath),
          base64: buffer.toString('base64'),
          bytes: stat.size,
        });
        if (uploaded.success) attachments.push(uploaded.attachment);
        else errors.push(`${name}: ${uploaded.error}`);
      } catch (err) {
        errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Partial success is the honest answer when three files were picked and one
    // was too big: the two that landed are usable, and the third is named.
    return {
      success: attachments.length > 0 || errors.length === 0,
      attachments,
      ...(errors.length ? { error: errors.join(' ') } : {}),
    };
  });

  /**
   * The same upload, without the dialog: a file pasted or dropped on the page.
   * The renderer has its bytes (File.arrayBuffer()) and no path, so they come
   * over IPC, capped as the dialog's files are.
   */
  ipcMain.handle('overseer:attachData', async (_event, files: unknown) => {
    const conn = usableHermesConnection();
    if (!conn) return { success: false, attachments: [], error: 'Hermes is not configured. Set it up in Settings.' };

    const attachments: OverseerAttachment[] = [];
    const errors: string[] = [];
    for (const file of Array.isArray(files) ? files : []) {
      const f = (file ?? {}) as { name?: unknown; mimeType?: unknown; data?: unknown };
      const name = path.basename(typeof f.name === 'string' && f.name ? f.name : 'file');
      if (!(f.data instanceof Uint8Array)) {
        errors.push(`${name} came without its bytes.`);
        continue;
      }
      if (f.data.byteLength > MAX_ATTACHMENT_BYTES) {
        errors.push(`${name} is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB.`);
        continue;
      }
      try {
        const uploaded = await uploadHermesAttachment(conn, {
          name,
          mimeType: typeof f.mimeType === 'string' && f.mimeType ? f.mimeType : mimeTypeFor(name),
          base64: Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength).toString('base64'),
          bytes: f.data.byteLength,
        });
        if (uploaded.success) attachments.push(uploaded.attachment);
        else errors.push(`${name}: ${uploaded.error}`);
      } catch (err) {
        errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return {
      success: attachments.length > 0 || errors.length === 0,
      attachments,
      ...(errors.length ? { error: errors.join(' ') } : {}),
    };
  });

  ipcMain.handle('overseer:history', async () => ({
    messages: getOverseerHistory(),
    busy: isOverseerBusy(),
  }));

  ipcMain.handle('overseer:clearHistory', async () => {
    if (isOverseerBusy()) {
      return { success: false, cleared: 0, error: 'The overseer is answering right now. Try again in a moment.' };
    }
    return { success: true, ...clearOverseerHistory() };
  });

  ipcMain.handle('overseer:fleet', async () => buildFleetSnapshot());

  ipcMain.handle('overseer:confirmAction', async (_event, params: { action: OverseerAction; approve: boolean }) => {
    return confirmPendingAction(params.action, params.approve);
  });

  ipcMain.handle('overseer:pause', async () => {
    pauseOverseerWatch();
    return { success: true, paused: true };
  });

  ipcMain.handle('overseer:resume', async () => {
    resumeOverseerWatch();
    return { success: true, paused: false };
  });

  ipcMain.handle('overseer:watchStatus', async () => ({
    paused: isOverseerWatchPaused(),
    lastFailure: getLastWatchFailure(),
  }));

  ipcMain.handle('overseer:settings', async () => getOverseerSettings());

  /** The rules that can be turned on, described in the words that decide it. */
  ipcMain.handle('overseer:autoActions', async () =>
    AUTO_ACTION_RULES.map(r => ({ id: r.id, label: r.label, description: r.description })));

  ipcMain.handle('overseer:setSettings', async (_event, patch: Partial<OverseerSettings>) => {
    const settings = setOverseerSettings(patch ?? {});
    // Choosing a model has to reach the gateway, not just this file: the
    // overseer runs on whatever the gateway's main slot is set to. A gateway
    // that gives no answer is a refusal here, as in every overseer channel
    // that calls it (reachingHermes): it was a throw through IPC.
    if ((patch?.provider || patch?.model) && settings.provider && settings.model) {
      const { provider, model } = settings;
      const applied = await reachingHermes(() => applyOverseerModel(provider, model));
      if (!applied.success) return { success: false, settings, error: applied.error };
    }
    return { success: true, settings };
  });

  /**
   * The reasoning effort, read from and written to the gateway rather than
   * stored here.
   *
   * It is `agent.reasoning_effort` in the gateway's own config, which is a
   * property of that install, not of Tars: the same gateway answers the
   * dashboard and Tars with the same effort. Keeping a copy in app-settings
   * would only create two answers to one question.
   */
  ipcMain.handle('overseer:effort', async () => {
    const conn = usableHermesConnection();
    if (!conn) return { success: false, error: 'Hermes is not configured. Set it up in Settings.' };
    return reachingHermes(async () => ({ success: true as const, effort: await getReasoningEffort(conn), options: [...REASONING_EFFORTS] }));
  });

  ipcMain.handle('overseer:setEffort', async (_event, effort: string) => {
    const conn = usableHermesConnection();
    if (!conn) return { success: false, error: 'Hermes is not configured. Set it up in Settings.' };
    if (typeof effort !== 'string' || !effort.trim()) {
      return { success: false, error: 'No effort given.' };
    }
    return reachingHermes(() => setReasoningEffort(conn, effort.trim()));
  });

  /**
   * The models the gateway can actually run. Asked of the gateway rather than
   * compiled in, because which providers it has credentials for is a property
   * of that install, not of Tars.
   */
  ipcMain.handle('overseer:modelOptions', async () => {
    const conn = usableHermesConnection();
    if (!conn) return { success: false, error: 'Hermes is not configured. Set it up in Settings.' };
    return reachingHermes(() => fetchHermesModelOptions(conn));
  });
}
