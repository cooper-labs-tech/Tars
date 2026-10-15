import * as fs from 'fs';
import { randomBytes, timingSafeEqual } from 'crypto';
import { HERMES_WEBHOOK_SECRET_FILE, HERMES_WEBHOOK_SECRET_LEGACY_FILE } from '../constants';
import { describeSecretFileError, writeSecretFileSync } from '../utils/secret-file';

/**
 * The Hermes webhook secret: the one credential Tars hands to something off
 * this machine, and the only one that opens `POST /api/webhooks/hermes`.
 *
 * Through that route Hermes dispatches to any agent of any project, named by
 * id or by name, because a cron job goes wherever JeanBrasse points it. That is the
 * reach of JeanBrasse's own chat, so the secret is kept where his conversation is
 * kept, in the directory no agent is handed.
 *
 * It was minted into `~/.dorothy`, which every agent is started with, one
 * `cat` away. The lot that stopped the shared token from driving agents left
 * this one there, and the audit of that lot found the webhook still taking the
 * shared token as well: refusing the one and leaving the other in the agents'
 * directory would only have changed which file an agent reads to drive the
 * fleet. It moves at startup with its value unchanged, so the Hermes jobs that
 * hold it keep working. An agent that read it before the move still has it:
 * rotating it is deleting the private file, opening Settings > Hermes for a
 * new one, and giving Hermes that.
 *
 * What the move is not: an agent that goes looking for the private directory
 * still reads it, as it reads JeanBrasse's conversation there. See SECURITY.md.
 */

function readTrimmed(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * Take the secret out of `~/.dorothy`.
 *
 * Copied, read back, and only then deleted, as the conversation is. When both
 * files exist the private one is the secret and the old one opens nothing, so
 * it is deleted too. When the copy cannot be made, the old file is left where
 * it is and nothing opens the webhook until it can: a secret that cannot leave
 * the agents' directory is not honoured from inside it.
 */
export function migrateWebhookSecretOutOfAgentReach(): void {
  if (!fs.existsSync(HERMES_WEBHOOK_SECRET_LEGACY_FILE)) return;
  try {
    if (!fs.existsSync(HERMES_WEBHOOK_SECRET_FILE)) {
      const secret = readTrimmed(HERMES_WEBHOOK_SECRET_LEGACY_FILE);
      if (secret) {
        writeSecretFileSync(HERMES_WEBHOOK_SECRET_FILE, secret);
        if (readTrimmed(HERMES_WEBHOOK_SECRET_FILE) !== secret) {
          fs.rmSync(HERMES_WEBHOOK_SECRET_FILE, { force: true });
          console.error('[hermes] the webhook secret did not copy across; the webhook stays shut until it does');
          return;
        }
      }
    }
    fs.unlinkSync(HERMES_WEBHOOK_SECRET_LEGACY_FILE);
    console.log('[hermes] the webhook secret is out of the directory the agents are handed');
  } catch (err) {
    console.error(`[hermes] could not move the webhook secret out of the data directory: ${describeSecretFileError(err)}`);
  }
}

/** The secret, or '' when none is configured. Only the private file counts. */
export function readWebhookSecret(): string {
  migrateWebhookSecretOutOfAgentReach();
  return readTrimmed(HERMES_WEBHOOK_SECRET_FILE);
}

/** The secret Settings shows for Hermes, minted the first time it is asked for. */
export function provisionWebhookSecret(): string {
  const existing = readWebhookSecret();
  if (existing) return existing;
  try {
    const secret = randomBytes(32).toString('hex');
    writeSecretFileSync(HERMES_WEBHOOK_SECRET_FILE, secret);
    return secret;
  } catch (err) {
    console.error(`[hermes] cannot provision the webhook secret: ${describeSecretFileError(err)}`);
    return '';
  }
}

/**
 * Whether `presented` is the webhook secret.
 *
 * Never when there is none. The route used to compare only when a secret file
 * existed, so on an install where Settings > Hermes had never been opened its
 * check was skipped and anything the door let in went through. An absent
 * secret is a shut door, not an open one.
 */
export function isWebhookSecret(presented: string): boolean {
  if (!presented) return false;
  const expected = readWebhookSecret();
  if (!expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
