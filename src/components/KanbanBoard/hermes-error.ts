/**
 * Turning a Hermes transport failure into something a user can act on.
 *
 * The failure this replaces: when the gateway was down, `hermesRequest` in the
 * main process rejected, Electron serialised the rejection, and the Kanban page
 * printed the raw
 *   "Error invoking remote method 'hermes:kanban:board': Error: connect
 *    ECONNREFUSED 127.0.0.1:9119"
 * Kanban is now the Hermes board with no local board to fall back to, so an
 * unreachable gateway has to name itself and say what to do about it.
 *
 * Kept in a plain module (not the .tsx) so it can be unit tested without React.
 */

export interface HermesFailure {
  /** Plain-language sentence shown to the user. */
  message: string;
  /** The underlying reason, shown small and monospaced under the message. */
  detail: string;
}

/** Strip Electron's IPC wrapper so the detail line reads as the real cause. */
function unwrap(raw: string): string {
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim();
}

export function describeHermesFailure(raw: string, baseUrl: string | null): HermesFailure {
  const where = baseUrl ? ` at ${baseUrl}` : '';
  const detail = unwrap(raw);

  if (/Invalid gateway URL/i.test(raw) || (!baseUrl && /ERR_INVALID_URL/i.test(raw))) {
    return {
      message: 'No Hermes gateway is configured yet, so there is no board to read.',
      detail,
    };
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return {
      message: `Hermes is not answering${where}. Nothing is listening on that address, so the gateway is probably not running or the tunnel is down.`,
      detail,
    };
  }
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|\btimeout\b/i.test(raw)) {
    return {
      message: `Hermes did not answer in time${where}. The gateway may be offline or off the network route.`,
      detail,
    };
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return {
      message: `The Hermes host could not be resolved${where}. Check the gateway URL in settings.`,
      detail,
    };
  }
  if (/CERT|SSL|self.signed|DEPTH_ZERO/i.test(raw)) {
    return {
      message: `Hermes refused the TLS handshake${where}. Check the gateway certificate, or use http for a tunnelled port.`,
      detail,
    };
  }
  return { message: `Could not reach Hermes${where}.`, detail };
}

/**
 * No Hermes at all, which is not a failure (2.0.7, H3; frame `First run (2.0.7) · states`, its row `Kanban, with no
 * Hermes gateway`): main answers its not-configured sentence (hermes-handlers.ts) when no gateway is set up. A
 * gateway set up and silent is still a failure, said by describeHermesFailure.
 */
export function isHermesAbsent(error: string): boolean {
  return /^Hermes is not configured\b/.test(error);
}

export const HERMES_ABSENT_TEXT =
  'Tars\'s kanban board is a Hermes gateway\'s, a tool installed apart. Without it, the rest of Tars works: your agents keep their split of the work in their delegations and their reports. To have the board: install Hermes, start its gateway, then connect it in Settings, Hermes.';
