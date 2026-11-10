// The file the fake Messages API's `RUNWRITE <tag> <n>` asks Claude Code to write, n numbered lines, shared with the
// spec that reads it back (e2e/approve-everywhere.live.spec.ts).
export const writtenContent = (tag, n) => `${Array.from({ length: n }, (_, i) => `${tag} line ${i + 1} of ${n}`).join('\n')}\n`;
