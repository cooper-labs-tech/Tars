/**
 * The settings' secrets as the window knows them since #466 (2.0.4): not at all. Main hands Settings a mask for a
 * secret that is set and '' for one that is not, with `secretsSet` saying which; a page sets or clears one through
 * secrets.set, which answers set or not and never the value.
 *
 * So a save never carries one back (withoutSecrets): not the mask, which a field could have let the user type into
 * and main would then take for a new key, not a key typed into a page, which belongs to secrets.set, and not '',
 * which would not clear it. And the page's copy never takes one in.
 */

/**
 * Every secret the settings hold, as main's settings-secrets.ts lists them (SECRET_FIELDS, and the Sentry token the
 * window sets too): __tests__/lib/secret-settings.test.ts fails when the two lists part.
 */
export const WINDOW_SECRETS = [
  'slackBotToken', 'slackAppToken', 'slackSigningSecret',
  'discordBotToken',
  'jiraApiToken', 'socialDataApiKey',
  'xApiKey', 'xApiSecret', 'xAccessToken', 'xAccessTokenSecret',
  'ampApiKey', 'cliApiKeys',
  'openRouterApiKey', 'deepSeekApiKey', 'mimoApiKey', 'moonshotApiKey', 'qwenApiKey', 'zhipuApiKey',
  'minimaxApiKey', 'nvidiaApiKey', 'nousPortalApiKey', 'veniceApiKey', 'ollamaCloudApiKey', 'customOpenAIApiKey',
  'hermesGatewayToken', 'memoryGbrainAuthToken', 'memoryHonchoApiKey',
  'sentryAuthToken',
] as const;

export type WindowSecret = typeof WINDOW_SECRETS[number];

/**
 * What main hands the window for a secret that is set, in place of the value (settings-secrets.ts's SECRET_MASK).
 * The one place a page sends it is where main takes it for the secret it keeps: discord:inviteUrl, the invite link
 * made from the saved bot token.
 */
export const SECRET_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

const NEVER_SENT: ReadonlySet<string> = new Set<string>([...WINDOW_SECRETS, 'secretsSet']);

/** What main says of each secret: set or not. */
export type SecretsSet = Partial<Record<string, boolean>>;

/** Settings as a page holds them, as far as secrets go. */
interface WithSecrets { secretsSet?: SecretsSet }

/** A change to the settings with every secret, and `secretsSet`, taken out: what a save may send, and the page keep. */
export function withoutSecrets<T extends object>(updates: T): T {
  return Object.fromEntries(Object.entries(updates).filter(([key]) => !NEVER_SENT.has(key))) as T;
}

/** Whether main holds a secret: `secretsSet` says, never the value the page was shown. */
export function secretIsSet(settings: WithSecrets | null | undefined, field: string): boolean {
  return settings?.secretsSet?.[field] === true;
}

/** The page's copy once secrets.set has answered for `field`: what it said of that one, the others kept. */
export function withSecretState<T extends WithSecrets>(settings: T, field: string, set: boolean): T {
  return { ...settings, secretsSet: { ...settings.secretsSet, [field]: set } };
}
