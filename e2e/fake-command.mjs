/**
 * How the specs' stand-in harnesses run a command a model asked for (trace feature C1): read, never handed to a shell,
 * so it runs the same on macOS, Linux and Windows. Its words, split on `;`: `sleep <seconds>` waits, `echo <text>`
 * prints, `exit <n>` ends with that code; anything else is not run, and ends with 127.
 */
export async function runFakeCommand(line) {
  let out = '';
  for (const part of String(line).split(';').map((s) => s.trim()).filter(Boolean)) {
    const sleep = /^sleep ([0-9.]+)$/.exec(part);
    const echo = /^echo (.*)$/.exec(part);
    const exit = /^exit (\d+)$/.exec(part);
    if (sleep) await new Promise((resolve) => setTimeout(resolve, Number(sleep[1]) * 1000));
    else if (echo) out += `${echo[1]}\n`;
    else if (exit) return { out, code: Number(exit[1]) };
    else return { out: `${out}not run: ${part.split(' ')[0]}\n`, code: 127 };
  }
  return { out, code: 0 };
}
