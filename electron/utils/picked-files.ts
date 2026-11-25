import * as path from 'path';

/**
 * The files the user picked in Tars's own open dialog this run (dialog:open-files), kept in the main process.
 * vault:attachFile copies only one of these (2.0.7): the copy lands in ~/.tars/vault/attachments, which every agent
 * reads. The Vault page attaches only what the dialog returned.
 */
const picked = new Set<string>();

export function rememberPicked(paths: readonly string[]): void {
  for (const p of paths) if (typeof p === 'string' && p) picked.add(path.resolve(p));
}

export function wasPicked(p: unknown): p is string {
  return typeof p === 'string' && !!p && picked.has(path.resolve(p));
}
