#!/usr/bin/env node
/**
 * The six bundled MCP servers, as an agent's CLI meets them, recorded before
 * the D4 refactor (refacto-rules: a group's first commit snapshots its
 * contracts, its last proves them byte-identical).
 *
 * Each server is built as the packaged app gets it (`npm ci` when its
 * node_modules is missing, then its own `npm run build`), started over stdio
 * from dist/bundle.js with the environment Tars gives an agent, and asked what
 * a CLI asks: initialize, tools/list, then tools/call for every tool, along
 * every answer it can give (mcp-servers.scenarios.mjs). Tars is a fake HTTP
 * server here, and so are SocialData and X (https-to-fake.mjs): each
 * request a tool makes is recorded, headers and body as sent, next to the
 * answer the tool gave.
 *
 *   node __tests__/mcp/contracts/mcp-servers.contract.mjs            check against the recording
 *   node __tests__/mcp/contracts/mcp-servers.contract.mjs --record   write the recording
 *   --no-build        run the bundles as they are
 *   --only=kanban,x   a few servers (check only)
 *
 * What differs from run to run is written as a placeholder: the sandbox paths,
 * the fake's port, a multipart boundary, and X's OAuth nonce, time and
 * signature, the signature after being checked against the credentials.
 * Needs Node 22 (`nvm use`) and, the first time, the network for `npm ci`.
 */
import { spawn, execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVERS } from "./mcp-servers.scenarios.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const RECORDING = path.join(HERE, "mcp-servers.contract.json");
const PRELOAD = path.join(HERE, "https-to-fake.mjs");

/**
 * On Windows a server's os.homedir() is USERPROFILE, and with none in its
 * environment libuv asks Windows for the account's real profile: HOME alone
 * would have the servers read the real ~/.tars. The same variables
 * __tests__/setup/test-home.ts moves; nothing is added elsewhere.
 */
function windowsHome(home) {
  if (process.platform !== "win32") return {};
  const drive = path.parse(home).root.replace(/[\\/]+$/, "");
  return {
    USERPROFILE: home,
    HOMEDRIVE: drive,
    HOMEPATH: home.slice(drive.length),
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
  };
}
const argv = process.argv.slice(2);
const RECORD = argv.includes("--record");
const BUILD = !argv.includes("--no-build");
const ONLY = (argv.find(a => a.startsWith("--only="))?.slice(7) ?? "").split(",").filter(Boolean);
if (RECORD && ONLY.length) throw new Error("--record writes every server: drop --only");

// ------------------------------------------------------------------- the fake

function startFake() {
  const state = { answers: [], requests: [], held: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const headers = [];
      let to = "tars";
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === "x-contract-host") to = `https://${req.rawHeaders[i + 1]}`;
        else headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      state.requests.push({ to, method: req.method, path: req.url, headers, ...(body ? { body } : {}) });
      const answer = state.answers.shift() ?? { status: 599, json: { error: "the contract scripted no answer for this request" } };
      if (answer.drop) return req.socket.destroy();
      if (answer.hold) return state.held.push(res);
      if (answer.json !== undefined) {
        res.writeHead(answer.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(answer.json));
      } else if (answer.raw !== undefined) {
        res.writeHead(answer.status, { "Content-Type": "text/plain" });
        res.end(answer.raw);
      } else {
        res.writeHead(answer.status);
        res.end();
      }
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })));
}

// ------------------------------------------------------------ an MCP session

class Session {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = "";
    this.seq = 0;
    let buffer = "";
    child.stdout.on("data", data => {
      buffer += data;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const waiter = message.id !== undefined && this.pending.get(message.id);
        if (waiter) {
          this.pending.delete(message.id);
          waiter(message);
        } else {
          this.notifications.push(message);
        }
      }
    });
    child.stderr.on("data", data => { this.stderr += data; });
  }

  request(method, params, timeoutMs) {
    const id = ++this.seq;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ harness: `no answer within ${timeoutMs / 1000} s` });
      }, timeoutMs);
      this.pending.set(id, message => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`);
  }
}

// -------------------------------------------------------------- the servers

function build(server) {
  const dir = path.join(ROOT, server.dir);
  if (!fs.existsSync(path.join(dir, "node_modules"))) {
    execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, stdio: "inherit" });
  }
  execFileSync("npm", ["run", "build"], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
}

/**
 * What went into a bundle, by the path comments esbuild writes above each
 * module. A package from anywhere but the server's own node_modules would be
 * a dependency it does not lock, the root's zod or SDK: refused.
 */
function bundledFrom(server) {
  const bundle = fs.readFileSync(path.join(ROOT, server.dir, "dist", "bundle.js"), "utf8");
  const sources = new Set();
  for (const [, file] of bundle.matchAll(/^\/\/ ((?:\.\.\/)*[\w@.-]+(?:\/[\w@.+-]+)+\.(?:m?js|cjs|ts|json))$/gm)) {
    sources.add(file.startsWith("node_modules/") ? file.split("/").slice(0, file.split("/")[1].startsWith("@") ? 3 : 2).join("/") : path.dirname(file));
  }
  const foreign = [...sources].filter(s => s.startsWith("../") && !s.startsWith("../mcp-shared/"));
  if (foreign.length) throw new Error(`${server.dir}'s bundle holds code from outside its own node_modules: ${foreign.join(", ")}`);
  return [...sources].sort();
}

function writeSettings(home, settings) {
  const file = path.join(home, ".tars", "app-settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (settings === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, typeof settings === "string" ? settings : JSON.stringify(settings, null, 2));
}

/** `<home>` in a scenario's arguments is the sandbox HOME. */
function withHome(value, home) {
  return JSON.parse(JSON.stringify(value ?? {}).replaceAll("<home>", home));
}

async function runVariant(server, variant, fake, sandbox) {
  const home = path.join(sandbox, "home");
  const project = path.join(sandbox, "project");
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  variant.setup?.(home);

  const child = spawn(process.execPath, ["--import", PRELOAD, path.join(ROOT, server.dir, "dist", "bundle.js")], {
    cwd: project,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ...windowsHome(home),
      CLAUDE_MGR_API_URL: `http://127.0.0.1:${fake.port}`,
      CONTRACT_FAKE_PORT: String(fake.port),
      ...variant.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const session = new Session(child);
  const initialize = await session.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tars-mcp-contract", version: "1.0.0" },
  }, 30_000);
  session.notify("notifications/initialized");
  const tools = await session.request("tools/list", {}, 30_000);

  const calls = [];
  for (const scenario of variant.scenarios) {
    fake.state.answers = [...(scenario.tars ?? [])];
    fake.state.requests = [];
    session.notifications = [];
    writeSettings(home, "settings" in scenario ? scenario.settings : (variant.settings ?? null));
    const params = { name: scenario.tool, arguments: withHome(scenario.args, home), ...(scenario.meta ? { _meta: scenario.meta } : {}) };
    // Longer than the longest wait a server has of its own: mcp-kanban's 60 s.
    const answer = await session.request("tools/call", params, 90_000);
    for (const res of fake.state.held.splice(0)) res.socket?.destroy();
    calls.push({
      scenario: scenario.name,
      call: { tool: scenario.tool, arguments: scenario.args ?? {} },
      requests: fake.state.requests.map(r => withOAuthChecked(r, scenario.settings ?? variant.settings)),
      ...(session.notifications.length ? { notifications: session.notifications } : {}),
      answer: answer.result ?? (answer.error ? { error: answer.error } : answer),
      ...(fake.state.answers.length ? { unansweredScripts: fake.state.answers.length } : {}),
    });
  }

  child.stdin.end();
  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
  // What a server logs, without the stack frames under it: they name lines of
  // the bundle and this machine's paths, which move with any edit.
  const stderr = session.stderr.replace(/^\s+at .*\n/gm, "");
  return { variant: variant.name, initialize: initialize.result ?? initialize, tools: tools.result ?? tools, stderr, calls };
}

/**
 * X's requests carry a fresh nonce, the time and a signature over both: the
 * three become placeholders, and the signature is checked, with the
 * credentials the call ran under, before it is.
 */
function withOAuthChecked(request, settings) {
  const i = request.headers.findIndex(h => h.startsWith("Authorization: OAuth "));
  if (i < 0) return request;
  const params = Object.fromEntries([...request.headers[i].matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, decodeURIComponent(v)]));
  const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const signed = Object.keys(params).filter(k => k !== "oauth_signature").sort().map(k => `${enc(k)}=${enc(params[k])}`).join("&");
  const base = [request.method, enc(`${request.to}${request.path}`), enc(signed)].join("&");
  const key = `${enc(settings?.xApiSecret ?? "")}&${enc(settings?.xAccessTokenSecret ?? "")}`;
  const valid = crypto.createHmac("sha1", key).update(base).digest("base64") === params.oauth_signature;
  const headers = [...request.headers];
  headers[i] = headers[i]
    .replace(/oauth_nonce="[^"]*"/, 'oauth_nonce="<nonce>"')
    .replace(/oauth_timestamp="[^"]*"/, 'oauth_timestamp="<time>"')
    .replace(/oauth_signature="[^"]*"/, `oauth_signature="<${valid ? "valid" : "INVALID"} signature>"`);
  return { ...request, headers };
}

function normalize(text, sandbox, port) {
  return text
    .replaceAll(sandbox, "<sandbox>")
    .replaceAll(encodeURIComponent(sandbox), "<sandbox>")
    .replaceAll(`127.0.0.1:${port}`, "127.0.0.1:<port>")
    .replace(/----FormBoundary\d+/g, "----FormBoundary<time>");
}

// ------------------------------------------------------------------ the run

const servers = SERVERS.filter(s => !ONLY.length || ONLY.includes(s.id));
// Its real path: macOS gives a temp directory behind a symlink, and a server
// resolves a relative path through the real one.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tars-mcp-contract-")));
const fake = await startFake();
const recording = {};
try {
  for (const server of servers) {
    if (BUILD) build(server);
    const from = bundledFrom(server);
    console.log(`${server.id}: bundled from ${from.join(", ")}`);
    const variants = [];
    for (const variant of server.variants) variants.push(await runVariant(server, variant, fake, sandbox));
    recording[server.id] = variants;
    console.log(`${server.id}: ${variants.reduce((n, v) => n + v.calls.length, 0)} calls`);
  }
} finally {
  fake.server.close();
  fake.server.closeAllConnections?.();
}

const text = `${normalize(JSON.stringify(recording, null, 2), sandbox, fake.port)}\n`;
fs.rmSync(sandbox, { recursive: true, force: true });

if (RECORD) {
  fs.writeFileSync(RECORDING, text);
  console.log(`recorded ${RECORDING}`);
} else {
  const expected = JSON.parse(fs.readFileSync(RECORDING, "utf8"));
  const wanted = `${JSON.stringify(ONLY.length ? Object.fromEntries(servers.map(s => [s.id, expected[s.id]])) : expected, null, 2)}\n`;
  if (wanted === text) {
    console.log(`identical: ${servers.map(s => s.id).join(", ")}`);
  } else {
    const actual = path.join(os.tmpdir(), `mcp-servers.contract.actual-${process.pid}.json`);
    const want = path.join(os.tmpdir(), `mcp-servers.contract.expected-${process.pid}.json`);
    fs.writeFileSync(actual, text);
    fs.writeFileSync(want, wanted);
    try {
      execFileSync("diff", ["-u", want, actual], { stdio: "inherit" });
    } catch {
      // diff exits 1 when the files differ: that is the answer, printed above.
    }
    console.error(`DIFFERENT: what this run saw is in ${actual}`);
    process.exit(1);
  }
}
