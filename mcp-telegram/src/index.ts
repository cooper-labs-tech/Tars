#!/usr/bin/env node
/**
 * MCP server that exposes Telegram tools for sending messages, photos, videos, and documents.
 * Works independently - reads its settings from ~/.dorothy/app-settings.json and sends directly to Telegram.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readAppSettings } from "../../mcp-shared/src/settings.js";
import { API_WAIT_MS, noAnswerWithin } from "../../mcp-shared/src/http.js";
import { registerTools, text, tool } from "../../mcp-shared/src/tools.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import type { ClientRequest } from "http";

interface AppSettings {
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramAuthorizedChatIds?: string[];
}

/**
 * What this server is allowed to upload, and to whom.
 *
 * This process runs beside the app, not inside it, and reads app-settings.json
 * itself - so the `isSafeTelegramPath` check on the app's own HTTP routes never
 * applied here. An agent that can call these tools could name any absolute path
 * and any chat id: `send_telegram_document` with
 * `~/.dorothy/app-settings.json` and the attacker's own chat id is a one-call
 * exfiltration of every API key the app holds.
 *
 * Both halves of the guard are enforced here, in the same shape the app uses.
 */
const BLOCKED_DIRS = [
  ".ssh", ".gnupg", ".aws", ".claude", ".dorothy", ".config",
  ".kube", ".docker",
  // What Tars keeps out of the agents' directory: JeanBrasse's conversation with
  // the super chat and the Hermes webhook secret. Blocking .dorothy alone made
  // them sendable again the moment they moved out of it.
  ".tars-private",
];

/**
 * Names that hold credentials wherever they sit.
 *
 * These used to be in BLOCKED_DIRS, which only ever compared the path against
 * `~/<name>`. That covers `~/.env` and nothing else, and Tars runs agents inside
 * cloned project directories, which is exactly where a real `.env` lives. So
 * `~/some-project/.env` sailed through the guard that exists to stop precisely
 * this: one `send_telegram_document` call and the project's secrets are in a
 * chat. Matched on the basename, at any depth.
 */
const BLOCKED_NAMES = new Set([
  ".env", ".netrc", ".git-credentials", ".npmrc", ".pypirc",
  "credentials", "credentials.json", "id_rsa", "id_ed25519", ".pgpass",
]);

/**
 * Where Windows keeps credentials: under %APPDATA% and %LOCALAPPDATA%, not in
 * home dotfiles. The same list as the app's electron/platform/credential-stores.ts
 * (this server is built on its own); a test holds the two equal.
 */
const WINDOWS_ROAMING = [
  "GitHub CLI", "gcloud", "tars", "Microsoft\\Credentials", "Microsoft\\Protect", "Microsoft\\Crypto",
  "Microsoft\\SystemCertificates", "Microsoft\\Vault", "Mozilla", "Opera Software", "Telegram Desktop",
  "discord", "Slack", "Signal", "Bitwarden",
];
const WINDOWS_LOCAL = [
  "Microsoft\\Credentials", "Microsoft\\Vault", "Microsoft\\TokenBroker", "Microsoft\\IdentityCache",
  "Microsoft\\OneAuth", "Google\\Chrome\\User Data", "Microsoft\\Edge\\User Data",
  "BraveSoftware\\Brave-Browser\\User Data", "Chromium\\User Data", "Vivaldi\\User Data", "1Password",
];
const WINDOWS_HOME = [".azure"];

export function windowsCredentialStoreDirs(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const w = path.win32;
  const roaming = [env.APPDATA, w.join(home, "AppData", "Roaming")];
  const local = [env.LOCALAPPDATA, w.join(home, "AppData", "Local")];
  const dirs = [
    ...roaming.filter((d): d is string => !!d).flatMap(base => WINDOWS_ROAMING.map(rel => w.join(base, rel))),
    ...local.filter((d): d is string => !!d).flatMap(base => WINDOWS_LOCAL.map(rel => w.join(base, rel))),
    ...WINDOWS_HOME.map(rel => w.join(home, rel)),
  ];
  const seen = new Set<string>();
  return dirs.filter(d => !seen.has(d.toLowerCase()) && !!seen.add(d.toLowerCase()));
}

/** `inner` is `outer` or inside it, the way Windows compares: any case, either separator. */
function windowsWithin(inner: string, outer: string): boolean {
  const key = (p: string) => path.win32.normalize(p.replace(/\//g, "\\")).replace(/\\+$/, "").toLowerCase();
  const i = key(inner);
  const o = key(outer);
  return i === o || i.startsWith(`${o}\\`);
}

/** `.env.local`, `.env.production` and friends are the same file with a suffix. */
function isBlockedName(name: string): boolean {
  const lower = name.toLowerCase();
  return BLOCKED_NAMES.has(lower) || lower.startsWith(".env.");
}

function assertSendableName(resolved: string, home: string): void {
  if (resolved !== home && !resolved.startsWith(home + path.sep)) {
    throw new Error(`Refused: ${resolved} is outside the home directory`);
  }
  for (const dir of BLOCKED_DIRS) {
    const blocked = path.join(home, dir);
    if (resolved === blocked || resolved.startsWith(blocked + path.sep)) {
      throw new Error(`Refused: ${dir} holds credentials and cannot be sent`);
    }
  }
  if (process.platform === "win32") {
    for (const store of windowsCredentialStoreDirs(home)) {
      if (windowsWithin(resolved, store)) {
        throw new Error(`Refused: ${store} holds credentials and cannot be sent`);
      }
    }
  }
  // Every segment, not just the last: a directory called `.ssh` three levels
  // into a project is still an `.ssh` directory. In any case: the volume macOS
  // ships ignores it, so `.TARS-PRIVATE` opens `.tars-private`.
  for (const segment of resolved.slice(home.length).split(path.sep)) {
    if (!segment) continue;
    if (isBlockedName(segment) || BLOCKED_DIRS.includes(segment.toLowerCase())) {
      throw new Error(`Refused: ${segment} holds credentials and cannot be sent`);
    }
  }
}

function assertSendablePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  assertSendableName(resolved, os.homedir());
  // And the file the name opens: a symlink put a blocked directory under an
  // ordinary name (the audit's lead #21, on the vault's guard). Judged by its
  // real path, against the home's own real path.
  let real: string | undefined;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    // Not there: the send says so after the guard.
  }
  if (real !== undefined) assertSendableName(real, fs.realpathSync.native(os.homedir()));
  // A hard link has no path back to the file it names, so it is looked for by
  // inode, in the two small directories whose files are secrets whole (the
  // audit's gate of #137).
  for (const dir of [".tars-private", ".ssh"]) {
    if (isHardLinkInto(resolved, path.join(os.homedir(), dir))) {
      throw new Error(`Refused: this file is also in ${dir}, which holds credentials and cannot be sent`);
    }
  }
  return resolved;
}

/**
 * Whether `candidate` is another name for a regular file under `dir`, by
 * device and inode. The app's own guard has the same function
 * (electron/utils/path-identity.ts); this server is built on its own. Read as
 * BigInt: a Number holds an inode exactly only below 2^53, and a 64-bit file id
 * past it (NTFS, or a share whose client passes the server's ids through, as
 * Linux's CIFS does by default) can round to its neighbour's.
 */
function isHardLinkInto(candidate: string, dir: string): boolean {
  let file: fs.BigIntStats;
  try {
    file = fs.statSync(candidate, { bigint: true });
  } catch {
    return false;
  }
  if (!file.isFile() || file.nlink < BigInt(2)) return false;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        try {
          const here = fs.lstatSync(full, { bigint: true });
          if (here.dev === file.dev && here.ino === file.ino) return true;
        } catch {
          // Gone since it was listed.
        }
      }
    }
  }
  return false;
}

/**
 * A chat id the user has actually approved. Without this an agent picks the
 * destination, which makes the path guard the only thing standing between a
 * prompt injection and the user's files.
 */
function assertAuthorizedChat(settings: AppSettings, chatId: string): string {
  const allowed = [settings.telegramChatId, ...(settings.telegramAuthorizedChatIds ?? [])]
    .filter((id): id is string => !!id)
    .map(String);

  if (!allowed.includes(String(chatId))) {
    throw new Error(
      `Refused: chat ${chatId} is not in this install's authorized chats. ` +
      `Add it in Settings > Telegram first.`
    );
  }
  return String(chatId);
}

function loadSettings(): AppSettings {
  const settings = readAppSettings((err) => console.error("Failed to load settings:", err));
  return settings === undefined ? {} : (settings as AppSettings);
}

// Telegram Bot API helper
async function telegramApiRequest(
  token: string,
  method: string,
  params: Record<string, string | number>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, String(value));
    });

    const request: ClientRequest = https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.ok) {
              resolve(json.result);
            } else {
              reject(new Error(json.description || "Telegram API error"));
            }
          } catch {
            reject(new Error("Failed to parse Telegram response"));
          }
        });
      })
      .on("error", reject)
      // A silent Telegram is said as such, where the call waited for Claude Code to give up on it.
      .setTimeout(API_WAIT_MS, () => request.destroy(new Error(noAnswerWithin(API_WAIT_MS))));
  });
}

/**
 * The slowest link a file still reaches Telegram over: a poor mobile link,
 * half the 20 KB/s QA measured. Telegram's largest upload, 50 MB, is then
 * given about an hour and a half.
 */
const UPLOAD_FLOOR_BYTES_PER_S = 10_000;

/** How long a request carrying `bytes` to Telegram may take in all: the bytes at the floor rate, then the minute any answer gets. */
function uploadDeadlineMs(bytes: number): number {
  return API_WAIT_MS + Math.ceil(bytes / UPLOAD_FLOOR_BYTES_PER_S) * 1000;
}

// Send file via multipart form data
async function sendFile(
  token: string,
  chatId: string,
  method: string,
  filePath: string,
  fileField: string,
  caption?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      reject(new Error(`File not found: ${filePath}`));
      return;
    }

    const boundary = `----FormBoundary${Date.now()}`;
    const fileName = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);

    // Build multipart form data
    let body = "";
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;

    if (caption) {
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="caption"\r\n\r\n👑 ${caption}\r\n`;
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="parse_mode"\r\n\r\nMarkdown\r\n`;
    }

    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\n`;
    body += `Content-Type: application/octet-stream\r\n\r\n`;

    const bodyStart = Buffer.from(body, "utf-8");
    const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
    const fullBody = Buffer.concat([bodyStart, fileContent, bodyEnd]);

    const options = {
      hostname: "api.telegram.org",
      path: `/bot${token}/${method}`,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": fullBody.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.ok) {
            resolve();
          } else {
            reject(new Error(json.description || "Telegram API error"));
          }
        } catch {
          reject(new Error("Failed to parse Telegram response"));
        }
      });
    });

    req.on("error", reject);
    // No timer of silence on a file: Node hands the body to the kernel's send
    // buffer (up to 4 MB on macOS) and sees nothing while a slow link drains
    // it, so a minute of silence ran from the last byte handed over and cut
    // uploads Telegram was still reading (QA's gate of #227: 3 MB read at
    // 20 KB/s, cut at 116 s with 2.31 MB received). A deadline for the whole
    // request instead, which grows with the file.
    const deadline = uploadDeadlineMs(fullBody.length);
    const timer = setTimeout(() => req.destroy(new Error(noAnswerWithin(deadline))), deadline);
    req.on("close", () => clearTimeout(timer));
    req.write(fullBody);
    req.end();
  });
}

// Create MCP server
const server = new McpServer({
  name: "claude-mgr-telegram",
  version: "1.0.0",
});

/**
 * The bot and the approved chat a send goes to: the chat asked for, or the
 * default one.
 */
function destination(chat_id: string | undefined): { token: string; chatId: string } {
  const settings = loadSettings();
  if (!settings.telegramBotToken) {
    throw new Error("Telegram not configured - missing bot token in settings");
  }

  // Use provided chat_id, or fall back to default from settings
  const requestedChatId = chat_id || settings.telegramChatId;
  if (!requestedChatId) {
    throw new Error("No chat_id provided and no default chat ID configured");
  }
  return { token: settings.telegramBotToken, chatId: assertAuthorizedChat(settings, requestedChatId) };
}

/** A photo, a video or a document, past both guards. */
async function sendAFile(
  method: string,
  field: string,
  noun: string,
  filePath: string,
  caption: string | undefined,
  chat_id: string | undefined
) {
  const { token, chatId } = destination(chat_id);
  await sendFile(token, chatId, method, assertSendablePath(filePath), field, caption);
  return text(`${noun} sent to Telegram chat ${chatId}: ${filePath}${caption ? ` with caption: "${caption.slice(0, 50)}..."` : ""}`);
}

registerTools(server, [
  tool({
    name: "send_telegram",
    description: "Send a text message to Telegram. IMPORTANT: When responding to a Telegram message, you MUST include the chat_id from the original request to ensure the response goes to the correct chat.",
    schema: {
      message: z.string().describe("The message to send to Telegram"),
      chat_id: z.coerce.string().optional().describe("The chat ID to send to. REQUIRED when responding to a specific Telegram chat. Use the chat_id from the incoming Telegram message."),
    },
    failure: "sending to Telegram",
    async run({ message, chat_id }) {
      const { token, chatId } = destination(chat_id);
      await telegramApiRequest(token, "sendMessage", {
        chat_id: chatId,
        text: `👑 ${message}`,
        parse_mode: "Markdown",
      });
      return text(`Message sent to Telegram chat ${chatId}: "${message.slice(0, 100)}${message.length > 100 ? "..." : ""}"`);
    },
  }),
  tool({
    name: "send_telegram_photo",
    description: "Send a photo/image to Telegram. Use this to share screenshots, images, or visual content with the user.",
    schema: {
      photo_path: z.string().describe("The absolute file path to the photo/image to send (e.g., /Users/name/image.png)"),
      caption: z.string().optional().describe("Optional caption text to include with the photo"),
      chat_id: z.coerce.string().optional().describe("The chat ID to send to. Use the chat_id from the incoming Telegram message."),
    },
    failure: "sending photo to Telegram",
    run: ({ photo_path, caption, chat_id }) => sendAFile("sendPhoto", "photo", "Photo", photo_path, caption, chat_id),
  }),
  tool({
    name: "send_telegram_video",
    description: "Send a video to Telegram. Use this to share video content, screen recordings, or animations with the user.",
    schema: {
      video_path: z.string().describe("The absolute file path to the video to send (e.g., /Users/name/video.mp4)"),
      caption: z.string().optional().describe("Optional caption text to include with the video"),
      chat_id: z.coerce.string().optional().describe("The chat ID to send to. Use the chat_id from the incoming Telegram message."),
    },
    failure: "sending video to Telegram",
    run: ({ video_path, caption, chat_id }) => sendAFile("sendVideo", "video", "Video", video_path, caption, chat_id),
  }),
  tool({
    name: "send_telegram_document",
    description: "Send a document/file to Telegram. Use this to share PDFs, text files, or any other documents with the user.",
    schema: {
      document_path: z.string().describe("The absolute file path to the document to send (e.g., /Users/name/report.pdf)"),
      caption: z.string().optional().describe("Optional caption text to include with the document"),
      chat_id: z.coerce.string().optional().describe("The chat ID to send to. Use the chat_id from the incoming Telegram message."),
    },
    failure: "sending document to Telegram",
    run: ({ document_path, caption, chat_id }) => sendAFile("sendDocument", "document", "Document", document_path, caption, chat_id),
  }),
]);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Telegram server running on stdio");
}

main().catch(console.error);
