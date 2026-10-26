import { BrowserWindow, protocol, app, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getAppBasePath } from '../utils';
import { MIME_TYPES } from '../constants';
import { localFileServes } from '../utils/window-file-access';
import { titleBarOptions } from '../platform/desktop-shell';
import { installEditContextMenu } from './edit-context-menu';
import { externalUrlToOpen } from '../utils/external-url';

// Global reference to the main window
let mainWindow: BrowserWindow | null = null;

/** Hosts a dev server may legitimately live on. Nothing else is loopback. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Where `npm run dev` serves the renderer. */
const DEFAULT_DEV_URL = 'http://localhost:3000';

/**
 * Is this an unpackaged (development) run?
 *
 * This used to be `process.env.NODE_ENV === 'development'`. NODE_ENV is
 * inherited from whatever shell launched the app, so a developer with
 * `export NODE_ENV=development` in a shell rc file made the *shipped, signed*
 * build take the dev branch: no app:// handler, and the main window - which
 * carries the whole electronAPI preload bridge, pty.create/pty.write included -
 * loaded whatever happened to answer on localhost:3000, DevTools open.
 * `app.isPackaged` is a property of the build itself and cannot be set by the
 * launching environment.
 */
export function isDevBuild(): boolean {
  return !app.isPackaged;
}

/** A plain-http URL on this machine, i.e. the dev server. */
export function isLoopbackHttp(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the dev-server URL for the main window.
 *
 * DOROTHY_DEV_URL used to go to loadURL verbatim, so
 * `DOROTHY_DEV_URL=https://attacker.example ./Tars.app/Contents/MacOS/Tars`
 * pointed the preload-privileged renderer at fully remote content. It is now
 * honoured only in an unpackaged build, and only for a plain-http loopback
 * origin - the same origins hardenWindow() treats as ours. Anything else falls
 * back to the default dev server.
 */
export function resolveDevUrl(raw: string | undefined = process.env.DOROTHY_DEV_URL): string {
  if (!raw) return DEFAULT_DEV_URL;
  if (!isDevBuild()) {
    console.error('DOROTHY_DEV_URL ignored, this is a packaged build:', raw);
    return DEFAULT_DEV_URL;
  }
  if (!isLoopbackHttp(raw)) {
    console.error('DOROTHY_DEV_URL ignored, not a loopback http:// URL:', raw);
    return DEFAULT_DEV_URL;
  }
  return raw;
}

/**
 * Get the main window instance
 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * Bring the main window back, wherever it went: hidden to the tray (Windows
 * closes to it), minimised, or behind another app. The tray menu's Show Tars
 * and a second launch (single instance) both land here.
 */
export function revealMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  // macOS: a window's focus does not bring an app in the background forward (a
  // second launch hands over from the front); `steal` does there, and the
  // others focus the app's window, which the line above did already.
  app.focus({ steal: true });
}

/**
 * Set the main window instance
 */
export function setMainWindow(window: BrowserWindow | null) {
  mainWindow = window;
}

/**
 * Create the main application window
 */
/**
 * Is this run an automated test rather than somebody using the app?
 *
 * Set by the e2e specs. A test run happens while its author is working in
 * another application, and until now it opened a full sized window in front of
 * whatever that was, every time, taking the keyboard with it.
 */
function isE2E(): boolean {
  return process.env.DOROTHY_E2E === '1';
}

export function createWindow() {
  const e2e = isE2E();

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    title: 'Tars',
    // hiddenInset on macOS and Linux. Windows: no frame, the
    // native caption buttons drawn over the window in the theme's background.
    ...titleBarOptions(process.platform),
    backgroundColor: '#121212',
    // A test run stays out of the way: shown without ever being activated, so
    // the window the author is actually typing in keeps the keyboard. Note the
    // window is still shown, and deliberately so. Nothing about how it renders
    // may change, because thirty six reference screenshots are compared
    // against it, and a window that is never composited photographs blank.
    show: !e2e,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // No renderer of ours ever needs to reach out on its own.
      webviewTag: false,
      // An unfocused window is throttled by default, which for a test run
      // means frames arriving late or not at all under the screenshot.
      backgroundThrottling: e2e ? false : undefined,
    },
  });

  if (e2e) {
    // macOS only, and the part that actually stops the interruption: an app
    // with no dock icon is an accessory and cannot become the active
    // application, so the window the author is typing in stays frontmost.
    app.dock?.hide();
    // showInactive, not show: the window appears and paints, and the app never
    // becomes the active one.
    mainWindow.showInactive();
    mainWindow.setAlwaysOnTop(false);
  }

  hardenWindow(mainWindow);

  // Load the Next.js app. The mode comes from the build, never from NODE_ENV -
  // see isDevBuild().
  if (isDevBuild()) {
    mainWindow.loadURL(resolveDevUrl());
    if (!process.env.DOROTHY_E2E) {
      mainWindow.webContents.openDevTools();
    }
  } else {
    // In production, use the custom app:// protocol to properly serve static files
    // This fixes issues with absolute paths like /logo.png not resolving correctly
    mainWindow.loadURL('app://-/index.html');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Handle loading errors
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('Failed to load:', validatedURL, errorCode, errorDescription);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Page loaded successfully');
  });
}

/**
 * Register custom protocol for serving static files
 * This must be called before app.whenReady()
 */
export function registerProtocolSchemes() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        // V8 keeps what it compiled of the renderer's bundle, in userData's
        // Code Cache, and a later launch reads it instead of compiling the
        // whole Next.js bundle again. Standard schemes only.
        codeCache: true,
      },
    },
    {
      scheme: 'local-file',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Setup the custom app:// protocol handler for serving static files
 * This should be called after app.whenReady() and before loading the window
 */
/**
 * Nothing may navigate this window away from the app, and nothing may open a
 * second one.
 *
 * The renderer holds the whole electronAPI bridge. A link in a vault note, a
 * redirect from injected content or a window.open would otherwise land remote
 * content in a renderer that can spawn PTYs and read the filesystem. External
 * links go to the user's browser, where they belong.
 */
export function hardenWindow(window: BrowserWindow): void {
  // A packaged build only ever runs from app://. The loopback origins are the
  // dev server, and whitelisting them in the shipped app let a link surface
  // walk the privileged renderer onto any http://localhost:PORT a user happens
  // to be running.
  const isOurs = (url: string) =>
    url.startsWith('app://') || (isDevBuild() && isLoopbackHttp(url));

  window.webContents.on('will-navigate', (event, url) => {
    if (isOurs(url)) return;
    event.preventDefault();
    const safe = externalUrlToOpen(url);
    if (safe) void shell.openExternal(safe);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const safe = externalUrlToOpen(url);
    if (safe) void shell.openExternal(safe);
    return { action: 'deny' };
  });

  window.webContents.on('will-attach-webview', event => event.preventDefault());

  // Windows: cut, copy, paste and select all on a right click in text (edit-context-menu.ts).
  installEditContextMenu(window.webContents);
}

/**
 * Is `candidate` the root itself, or inside it?
 *
 * Both protocol handlers need this and only one of them had it. Resolve before
 * comparing, and require the separator, so `/base-evil` does not pass as being
 * under `/base`.
 */
function isUnder(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

export function setupProtocolHandler() {
  // Serve local files via local-file:// protocol (for vault image previews etc.)
  // URLs are encoded as: local-file://host/path where host is empty
  // e.g. local-file:///Users/charlie/Desktop/photo.png
  protocol.handle('local-file', async (request) => {
    try {
      // Parse as URL to properly decode path components
      const url = new URL(request.url);
      const filePath = path.resolve(decodeURIComponent(url.pathname));

      // Confined to what a page may show: the vault's attachments, the
      // project-files folders, Claude Code's memory folders, never a secret
      // (utils/window-file-access.ts). Unrestricted, this served ~/.ssh/id_rsa
      // to anything that could put a URL in the renderer; until 2.0.4, all of
      // ~/.tars and ~/.claude, every key app-settings.json held included.
      if (!localFileServes(filePath)) {
        console.error('local-file:// refused, outside the allowed roots:', filePath);
        return new Response('Forbidden', { status: 403 });
      }

      if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
        return new Response(await fs.promises.readFile(filePath), {
          headers: { 'Content-Type': mimeType },
        });
      }
      console.error('local-file:// not found:', filePath);
    } catch (err) {
      console.error('local-file:// error:', err, request.url);
    }
    return new Response('Not Found', { status: 404 });
  });

  // Packaged builds serve the renderer from app://. Deciding this on NODE_ENV
  // meant a stray `export NODE_ENV=development` left the shipped app with no
  // app:// handler at all - see isDevBuild().
  if (!isDevBuild()) {
    const basePath = getAppBasePath();
    console.log('Registering app:// protocol with basePath:', basePath);

    protocol.handle('app', async (request) => {
      // Parse rather than slice. The old form kept the query string and the
      // hash in the path, so `app://-/settings?section=hermes` - the link
      // Kanban and Schedules use for "Sign in to Hermes" - was looked up as a
      // file literally named `settings?section=hermes` and 404'd. Any link
      // carrying a parameter was unreachable in the packaged app.
      let urlPath: string;
      try {
        urlPath = decodeURIComponent(new URL(request.url).pathname);
      } catch {
        urlPath = '/';
      }

      // Default to index.html for directory requests
      if (urlPath === '/' || urlPath === '') {
        urlPath = '/index.html';
      }

      // Handle page routes (e.g., /agents/, /settings/) - serve their index.html
      if (urlPath.endsWith('/')) {
        urlPath = urlPath + 'index.html';
      }

      // Remove leading slash for path.join
      const relativePath = urlPath.startsWith('/') ? urlPath.substring(1) : urlPath;
      const filePath = path.join(basePath, relativePath);

      // Containment, the same rule local-file:// has always had.
      //
      // `new URL()` collapses a literal `..` in the pathname but leaves `%2f`
      // alone, and the decode above happens AFTER the parse, so `..%2f..%2f`
      // came back out as a real traversal that path.join walked straight
      // through. The `app` scheme is registered secure and CORS-enabled, so it
      // is same-origin with the app's own page: a vault note holding
      // `![](app://-/a/..%2f..%2f.tars%2fapp-settings.json)` fetched it the
      // moment the note was opened, with no click, and handed every provider
      // API key to the renderer. Markdown images are never run through
      // isSafeUrl, and a vault document can be written by any agent.
      if (!isUnder(basePath, filePath)) {
        console.error(`app:// refused a path outside the bundle: ${urlPath}`);
        return new Response('Forbidden', { status: 403 });
      }

      // Check if file exists
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

        return new Response(await fs.promises.readFile(filePath), {
          headers: { 'Content-Type': mimeType },
        });
      }

      // If it's a page route without .html, try adding index.html
      const htmlPath = path.join(basePath, relativePath, 'index.html');
      if (isUnder(basePath, htmlPath) && fs.existsSync(htmlPath)) {
        return new Response(await fs.promises.readFile(htmlPath), {
          headers: { 'Content-Type': 'text/html' },
        });
      }

      console.error(`File not found: ${filePath}`);
      return new Response('Not Found', { status: 404 });
    });
  }
}
