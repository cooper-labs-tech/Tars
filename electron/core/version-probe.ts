import { probeCli, endCliProbes } from './cli-probe';

export { endProbe } from './cli-probe';

/**
 * `<binary> --version`, run so that the quit ends it.
 *
 * Settings asks each CLI for its version (`shell:version`: amp, gemini, codex
 * and the rest) and Settings > System asks claude, with an 8 s timeout. Those
 * were plain execFile calls the quit knew nothing of: amp, started just before
 * a quit, kept writing into the home after Tars was gone (the Audit's gate of
 * #298, measured by QA's bench). Each probe runs in a process group of its own,
 * so what it starts ends with it, and the quit's first pass ends every group
 * still running. One asked for during the quit is refused. Since 20/11 it is
 * one of the CLI probes of cli-probe.ts, which every one-shot probe goes through
 * (the Audit's report on probe orphans).
 */
export function probeVersion(
  binary: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 8000,
): Promise<{ stdout: string; stderr: string }> {
  return probeCli(binary, ['--version'], { env, timeoutMs });
}

/** Ends every CLI probe still running and what it started, the version probes among them (endCliProbes). */
export function endVersionProbes(): void {
  endCliProbes();
}
