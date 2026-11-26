/**
 * The local API's /api/local-file address for a file, on this Tars's own port (electronAPI.apiPort, which main hands
 * the window): the one API route the window's policy allows as a picture, on that port alone. null when the port is
 * not known, in a window Tars's main did not open: never another port, so never the user's other Tars on 31415.
 */
export function localFileUrl(filePath: string): string | null {
  const port = typeof window === 'undefined' ? null : window.electronAPI?.apiPort ?? null;
  if (!port) return null;
  return `http://127.0.0.1:${port}/api/local-file?path=${encodeURIComponent(filePath)}`;
}
