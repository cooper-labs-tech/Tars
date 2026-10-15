/**
 * The shell a terminal Tars opens runs: SHELL when it is set, otherwise the
 * platform's own default. /bin/zsh on macOS (its default since Catalina) and
 * /bin/bash elsewhere: six launches fell back to /bin/zsh, which a Linux
 * install often lacks, and failed to spawn there (JeanBrasse, 2026-09-24: "l'app doit
 * rester compatible linux").
 */
export function defaultShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}
