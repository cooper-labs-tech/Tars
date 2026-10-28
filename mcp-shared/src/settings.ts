import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Tars's data folder, by pickDataDir's rule (electron/core/data-dir-move.ts): ~/.tars when it is a folder, else ~/.dorothy; of two different folders, ~/.dorothy only when it alone holds Tars's records. */
export function dataDir(): string {
  const tars = path.join(os.homedir(), ".tars");
  const old = path.join(os.homedir(), ".dorothy");
  const folder = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const present = (p: string): boolean => { try { fs.lstatSync(p); return true; } catch { return false; } };
  const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };
  const records = (d: string): boolean => ["agents.json", "app-settings.json"].some((f) => { try { return fs.statSync(path.join(d, f)).isFile(); } catch { return false; } });
  if (!folder(tars)) return present(tars) || folder(old) ? old : tars;
  if (!folder(old) || real(tars) === real(old)) return tars;
  return records(old) && !records(tars) ? old : tars;
}

/**
 * Tars's settings file (~/.tars/app-settings.json) as it is at this call:
 * what it parses to, or undefined when there is none or it cannot be read.
 * It holds no key since 2.0.4 (they are in ~/.tars-private, which nothing
 * handed to an agent reads): the X server reads its Posting switch here, and
 * Tars makes its calls.
 */
export function readAppSettings(onError?: (error: unknown) => void): unknown {
  const file = path.join(dataDir(), "app-settings.json");
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    onError?.(error);
  }
  return undefined;
}
