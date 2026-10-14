import * as fs from 'fs';
import * as path from 'path';
import { isPlainAbsolute, resolveCliBinary } from './cli-binary';
import { realFs, type Env, type FsProbe } from './fs-probe';

const ABSOLUTE = "cliPath must be the absolute path of the CLI's executable file";

/**
 * Why `cliPath` cannot be an agent's CLI on this platform, or null: the CLI an
 * agent names for a new agent (create_agent, 2.0.2). Read from process.platform
 * at each call.
 *
 * win32: a plain absolute path (a drive or UNC one) that resolveCliBinary
 * starts, the way the launch will: a .exe or .com, a name PATHEXT completes, or
 * an npm .cmd shim it reads through. Windows has no execute bit to read.
 * darwin and linux: an absolute path to a regular file with an execute bit.
 */
export function cliPathProblem(cliPath: unknown, disk: FsProbe = realFs, env: Env = process.env): string | null {
  if (typeof cliPath !== 'string' || !cliPath.trim()) return ABSOLUTE;
  if (process.platform === 'win32') {
    if (!isPlainAbsolute(cliPath)) return `${ABSOLUTE} (C:\\... or \\\\server\\share\\...)`;
    const started = resolveCliBinary(cliPath, env, 'win32', disk);
    return started.ok ? null : `cliPath: ${started.detail}`;
  }
  if (!path.posix.isAbsolute(cliPath)) return ABSOLUTE;
  let st: fs.Stats;
  try {
    st = fs.statSync(cliPath);
  } catch {
    return `cliPath: there is no file at ${cliPath}`;
  }
  if (!st.isFile()) return `cliPath: ${cliPath} is not a file`;
  try {
    fs.accessSync(cliPath, fs.constants.X_OK);
  } catch {
    return `cliPath: ${cliPath} is not executable`;
  }
  return null;
}
