import * as os from 'os';

/**
 * A message for the window with the owner's home said `~`.
 *
 * Node quotes a file error's absolute path, and the home in it names the
 * account: a file of ~/.tars-private Tars could not write put
 * `/Users/<account>/...` in Settings, Hermes, and a broken connection file put
 * it on Schedules (the Audit's I-2 on #658). Only the home as a whole path
 * segment: another account's folder that starts with the same letters stays.
 */
export function withoutHome(message: string, home = os.homedir()): string {
  if (!home || home.length < 2) return message;
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return message.replace(new RegExp(`${escaped}(?=$|[\\\\/'"\\s,;)])`, 'g'), '~');
}
