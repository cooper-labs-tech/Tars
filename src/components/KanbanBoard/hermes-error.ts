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

/**
 * The gateway as a sentence names it: its protocol, host and path, never the saved URL whole, whose user name,
 * password, query and hash may hold a credential or a token. The shape of the main process's own sentence (#660,
 * noAnswerSentence). Only an http: or https: URL is quoted, the rule of the main process's gatewayUrl (#660), mirrored
 * here: a value that does not parse, or parses with any other scheme ("user:s3cretpw" reads as the scheme user:), is
 * not quoted at all, since what was saved there may be a credential or a token pasted in the wrong field.
 */
function gatewayOf(baseUrl: string | null): string {
  if (!baseUrl) return '';
  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return ` at ${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

export function describeHermesFailure(raw: string, baseUrl: string | null): HermesFailure {
  const where = gatewayOf(baseUrl);
  const detail = unwrap(raw);

  if (/Invalid gateway URL/i.test(raw) || (!baseUrl && /ERR_INVALID_URL/i.test(raw))) {
    return {
      message: 'No Hermes gateway is configured yet, so there is no board to read.',
      detail,
    };
  }
  // An answer Hermes began and never ended (#660): the main process says it in words of its own. The gateway is up,
  // so neither is worded as a refusal, nor as the idle wait. Frame: `Shell · Kanban · Hermes broke off its answer`.
  if (/answer was cut off before the end/i.test(raw)) {
    return {
      message: `Hermes began to answer${where}, but the answer was cut off before the end. Try again; if it keeps happening, check the tunnel or the network to the gateway.`,
      detail,
    };
  }
  const deadline = /answer did not end within (\d+)\s*s\b/i.exec(raw);
  if (deadline) {
    return {
      message: `Hermes began to answer${where}, but did not finish within ${deadline[1]} s. The gateway may be busy: try again in a moment.`,
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
