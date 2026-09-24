import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DATA_DIR } from '../constants';
import { MAX_ATTACHMENT_BYTES, safeUploadName } from './hermes-client';
import type { BusAttachment } from '../types';

/**
 * Files for a room: what the composer's + (or a paste, or a drop) hands the
 * agents in it. The renderer has bytes and no path, and an agent needs a path:
 * the bytes are written under ~/.dorothy (in every agent's `--add-dir`), one
 * folder per file so two of the same name never meet, and the message names
 * each by its absolute path. Staged in memory until a message takes them; one
 * nobody sends stays on disk, named to no one.
 */

/** Where staged files live. A function so a test's DATA_DIR is read when used. */
export function busFilesDir(): string {
  return path.join(DATA_DIR, 'bus-files');
}

const staged = new Map<string, { roomId: string; attachment: BusAttachment }>();

const IMAGE = /^image\//;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i;

export interface StagedFiles {
  attachments: BusAttachment[];
  errors: string[];
}

/** Files in one call, and so in one message: a person drops a few, not a folder. */
export const MAX_FILES_PER_STAGE = 10;
/** How long a staged file is kept, sent or not: an agent reads it within its turn. */
export const STAGED_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The folder, made sure of: a real directory, not a link. Every agent can
 * write under ~/.dorothy, and one that replaced bus-files with a link sent the
 * next file wherever it pointed (the Audit, gate of #169). Null when it is not.
 */
function stagingRoot(): string | null {
  const root = busFilesDir();
  try {
    const stat = fs.lstatSync(root);
    return stat.isDirectory() && !stat.isSymbolicLink() ? root : null;
  } catch {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return root;
  }
}

/** Staged files older than STAGED_FILE_TTL_MS go, each in its own folder. */
function pruneStaged(root: string): void {
  const cutoff = Date.now() - STAGED_FILE_TTL_MS;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      if (fs.lstatSync(dir).mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        for (const [id, s] of staged) if (path.dirname(s.attachment.path) === dir) staged.delete(id);
      }
    } catch (err) {
      console.warn('[bus] could not prune a staged file:', err);
    }
  }
}

/** Write each file, or name why it was refused. The same cap as Hermes's. */
export function stageFiles(roomId: string, files: unknown): StagedFiles {
  const attachments: BusAttachment[] = [];
  const errors: string[] = [];
  const root = stagingRoot();
  if (!root) return { attachments, errors: [`${busFilesDir()} is not a plain folder (a link?): nothing was staged.`] };
  pruneStaged(root);
  const list = Array.isArray(files) ? files : [];
  for (const extra of list.slice(MAX_FILES_PER_STAGE)) {
    const name = (extra as { name?: unknown } | null)?.name;
    errors.push(`${safeUploadName(typeof name === 'string' ? name : 'file')} was not staged: ${MAX_FILES_PER_STAGE} files at most at a time.`);
  }
  for (const file of list.slice(0, MAX_FILES_PER_STAGE)) {
    const f = (file ?? {}) as { name?: unknown; mimeType?: unknown; data?: unknown };
    const name = safeUploadName(typeof f.name === 'string' ? f.name : 'file');
    if (!(f.data instanceof Uint8Array)) {
      errors.push(`${name} came without its bytes.`);
      continue;
    }
    if (f.data.byteLength > MAX_ATTACHMENT_BYTES) {
      errors.push(`${name} is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB.`);
      continue;
    }
    const id = uuidv4();
    const dir = path.join(root, id);
    const file_ = path.join(dir, name);
    try {
      // A folder of its own, made here, and a file that must not exist yet: no
      // link planted in advance is followed.
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.writeFileSync(file_, f.data, { flag: 'wx' });
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const mimeType = typeof f.mimeType === 'string' ? f.mimeType : '';
    const attachment: BusAttachment = {
      id, name, path: file_, bytes: f.data.byteLength, isImage: IMAGE.test(mimeType) || IMAGE_EXT.test(name),
    };
    staged.set(id, { roomId, attachment });
    attachments.push(attachment);
  }
  return { attachments, errors };
}

/**
 * The staged files these ids name, for a message in this room, or the reason
 * one cannot be sent: an id nobody staged, or staged for another room. Taken
 * off the staged list only once the message is recorded (forgetStaged).
 */
export function stagedFor(roomId: string, ids: unknown): { attachments: BusAttachment[] } | { error: string } {
  if (ids === undefined) return { attachments: [] };
  if (!Array.isArray(ids)) return { error: 'attachments must be a list of staged file ids' };
  const attachments: BusAttachment[] = [];
  for (const id of ids) {
    const entry = typeof id === 'string' ? staged.get(id) : undefined;
    if (!entry || entry.roomId !== roomId) return { error: 'An attached file was not staged for this room: stage it again.' };
    attachments.push(entry.attachment);
  }
  return { attachments };
}

export function forgetStaged(attachments: BusAttachment[]): void {
  for (const a of attachments) staged.delete(a.id);
}

/** What a target receives: the text, then each file by its absolute path. */
export function withAttachmentPaths(text: string, attachments?: BusAttachment[]): string {
  if (!attachments?.length) return text;
  const lines = attachments.map(a => `- ${a.path} (${a.name}, ${a.bytes} bytes)`);
  return `${text}\n\nAttached files, readable at these paths:\n${lines.join('\n')}`;
}
