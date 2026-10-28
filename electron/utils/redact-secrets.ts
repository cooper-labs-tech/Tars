/**
 * Take the secrets out of text that is about to leave this machine.
 *
 * Agent output goes two places Tars does not control: a Telegram chat, and the
 * prompt sent to a Hermes gateway that may be anywhere on a tailnet. Both took
 * the raw PTY buffer, stripped ANSI, and sent it. An agent's environment holds
 * `ANTHROPIC_API_KEY`, and for every provider except the local ones that is the
 * user's real vendor key, so one `env`, one verbose curl, or one stack trace
 * that prints its config put it in a chat.
 *
 * This is a net, not a proof. It cannot know every shape a secret takes, so it
 * is not a licence to send more than necessary: keep the buffers short and keep
 * this in front of them. What it does catch is the shapes that actually turn up
 * in terminal output.
 */

/** How much of a match to keep, so a redaction is still recognisable. */
const KEEP = 4;

function mask(secret: string): string {
  if (secret.length <= KEEP * 2) return '[redacted]';
  return `${secret.slice(0, KEEP)}[redacted]${secret.slice(-KEEP)}`;
}

interface Rule {
  name: string;
  pattern: RegExp;
  /** Which capture group holds the secret itself. 0 means the whole match. */
  group?: number;
}

const RULES: Rule[] = [
  // Vendor-prefixed keys. The prefixes are what make these recognisable at all,
  // so they come first and are matched whole.
  { name: 'anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'openai', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'google', pattern: /\bAIza[A-Za-z0-9_-]{20,}/g },
  { name: 'github', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'slack', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'openrouter', pattern: /\bsk-or-v1-[A-Za-z0-9]{20,}/g },
  { name: 'aws', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'telegram-bot', pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}/g },
  // The bot's id in base64 (it starts M, N or O), a six-character timestamp, the signature.
  { name: 'discord-bot', pattern: /\b[MNO][A-Za-z0-9_-]{22,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g },

  // A URL's password, as a database command line or a clone carries it (scheme://user:password@host).
  { name: 'url-password', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi, group: 1 },
  // A bearer token or an api-key header, wherever it appears.
  { name: 'bearer', pattern: /\b[Bb]earer\s+([A-Za-z0-9._~+/=-]{16,})/g, group: 1 },
  { name: 'api-key-header', pattern: /\b[Xx]-[Aa]pi-[Kk]ey:\s*([^\s"']{12,})/g, group: 1 },

  // An assignment whose left-hand side names a secret. This is the one that
  // catches `ANTHROPIC_API_KEY=...` in an `env` dump, and the shape a config
  // print takes. The value stops at whitespace or a quote, so a sentence
  // mentioning the word is not swallowed.
  {
    name: 'assignment',
    pattern: /\b([A-Z0-9_]*(?:API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi,
    group: 2,
  },

  // A JSON field named like a secret, which is how app-settings.json reads.
  {
    name: 'json-field',
    pattern: /"[A-Za-z0-9_]*(?:apiKey|api_key|secret|token|password)[A-Za-z0-9_]*"\s*:\s*"([^"]{8,})"/gi,
    group: 1,
  },
];

/** Values that are obviously not secrets, so a redaction does not read as noise. */
const PLACEHOLDERS = new Set([
  'undefined', 'null', 'none', 'empty', 'false', 'true',
  'placeholder', 'redacted', 'your-api-key', 'xxx', 'changeme', 'not-set',
]);

function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  if (PLACEHOLDERS.has(lower)) return true;
  // A path or a URL under a secret-sounding name is a location, not a secret.
  if (lower.startsWith('/') || lower.startsWith('~/') || lower.startsWith('http')) return true;
  // All one repeated character, the shape of a hand-written stand-in.
  return /^(.)\1+$/.test(value);
}

/**
 * Redact every secret-shaped run in `text`.
 *
 * Returns the text with each match masked down to its first and last four
 * characters, so a user can still tell which key it was without the key being
 * usable. Known non-secrets are left alone.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match, ...groups) => {
      const index = (rule.group ?? 0) - 1;
      const secret = index < 0 ? match : String(groups[index] ?? '');
      if (!secret || looksLikePlaceholder(secret)) return match;
      return match.replace(secret, mask(secret));
    });
  }
  return out;
}

/** True when redaction changed anything, for callers that want to say so. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
