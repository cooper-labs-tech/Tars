import * as https from "https";
import { API_WAIT_MS, send } from "../../../mcp-shared/src/http.js";
import { readAppSettings } from "../../../mcp-shared/src/settings.js";
import { generateOAuthHeader, type OAuthCredentials } from "./oauth.js";

const X_API_HOST = "api.x.com";

/** Tars's settings as they are now, or nothing when the file cannot be read. */
function readSettings(): Record<string, unknown> | null | undefined {
  return readAppSettings() as Record<string, unknown> | null | undefined;
}

/**
 * Refuse unless Posting is on in Settings > X (Twitter), as the settings are
 * at this call.
 *
 * The switch has been on that page, off by default, since this server shipped,
 * and nothing read it: every agent handed these tools could publish and delete
 * on the account whatever it said (the audit's lead #12), and the privacy
 * policy says Tars posts only when JeanBrasse has turned it on. Only the switch's own
 * `true` turns it on; a file with no value for it, or one that cannot be read,
 * is off.
 */
export function assertPostingEnabled(): void {
  if (readSettings()?.xPostingEnabled !== true) {
    throw new Error(
      "Posting is off in Tars Settings > X (Twitter), so nothing was sent. The user turns it on there when agents may post, reply and delete."
    );
  }
}

function getCredentials(): OAuthCredentials {
  const settings = readSettings();
  if (
    settings?.xApiKey &&
    settings.xApiSecret &&
    settings.xAccessToken &&
    settings.xAccessTokenSecret
  ) {
    return {
      apiKey: String(settings.xApiKey),
      apiSecret: String(settings.xApiSecret),
      accessToken: String(settings.xAccessToken),
      accessTokenSecret: String(settings.xAccessTokenSecret),
    };
  }
  throw new Error(
    "X API credentials not configured. Please add your API keys in Tars Settings > X (Twitter)."
  );
}

export async function xApiRequest(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const creds = getCredentials();
  const url = `https://${X_API_HOST}${endpoint}`;
  const bodyStr = body ? JSON.stringify(body) : undefined;
  const authHeader = generateOAuthHeader(method, url, creds, bodyStr);

  const { status, data } = await send(https, {
    hostname: X_API_HOST,
    port: 443,
    path: endpoint,
    method,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout: API_WAIT_MS,
  }, bodyStr, (err) => new Error(`X API request failed: ${err.message}`));

  // An error whose body is JSON null reads as unparseable, as it always has:
  // its .detail is read inside the try.
  let refused: Error;
  try {
    const parsed = JSON.parse(data);
    if (!(status && status >= 400)) return parsed;
    const errorDetail =
      parsed.detail ||
      parsed.errors?.[0]?.message ||
      JSON.stringify(parsed);
    refused = new Error(`X API error (HTTP ${status}): ${errorDetail}`);
  } catch {
    if (status === 204) {
      return { success: true };
    }
    throw new Error(`Failed to parse X API response: ${data.slice(0, 500)}`);
  }
  throw refused;
}
