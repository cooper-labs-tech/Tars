import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The e2e suite starts the app only through launchSandboxed.
 *
 * HOME never moved Electron's profile. Launched with HOME alone, every e2e run
 * until 2026-09-16 opened ~/Library/Application Support/tars, which on a
 * case-insensitive disk is the installed Tars's own profile, while that app was
 * running. launchSandboxed in e2e/fixture.mjs moves the profile and then asks the
 * running app where its folders landed, so it cannot be fooled by a flag that
 * stopped working; what it cannot do is catch a spec that never calls it. This
 * does: a direct `.launch(` anywhere in e2e/ is a spec reaching past the sandbox.
 */

const E2E = path.join(__dirname, '..', 'e2e');

/** Every script under e2e/, however deep, except what Playwright generates. */
function e2eSources(): string[] {
  return (fs.readdirSync(E2E, { recursive: true }) as string[])
    .filter(name => /\.(ts|mts|js|mjs|cjs)$/.test(name))
    .filter(name => !name.split(path.sep).some(part => part === 'report' || part === '__screenshots__'));
}

describe('e2e launches of the app', () => {
  it('reads real spec files, so an empty scan cannot pass for a clean one', () => {
    expect(e2eSources()).toEqual(expect.arrayContaining(['fixture.mjs', 'surfaces.spec.ts', 'chat-rooms.spec.ts']));
  });

  it('go through launchSandboxed, and nothing launches Electron directly', () => {
    const direct: string[] = [];
    for (const name of e2eSources()) {
      if (name === 'fixture.mjs') continue;
      fs.readFileSync(path.join(E2E, name), 'utf-8').split('\n').forEach((line, index) => {
        if (/\.launch\(/.test(line)) direct.push(`e2e/${name}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(direct, 'launch the app with launchSandboxed from e2e/fixture.mjs').toEqual([]);
  });

  it('with the one launch in fixture.mjs moving the profile out of the real home', () => {
    const fixture = fs.readFileSync(path.join(E2E, 'fixture.mjs'), 'utf-8');
    expect(fixture.match(/\.launch\(/g)).toHaveLength(1);
    expect(fixture).toContain('`--user-data-dir=${path.join(sandboxHome, ');
    expect(fixture).toContain('CFFIXED_USER_HOME: sandboxHome');
  });
});

describe('the renderer server the e2e suite starts', () => {
  const config = fs.readFileSync(path.join(__dirname, '..', 'playwright.config.ts'), 'utf-8');
  const command = config.match(/command: `(npx next dev [^`]*)`/)?.[1];

  it('is found in the config, so a moved command cannot pass for a bound one', () => {
    expect(command).toBeDefined();
  });

  it('listens on the loopback only', () => {
    // The runner's HOME reaches it, and so does the session reader under
    // src/app/api, which reads ~/.claude/projects from that HOME.
    expect(command).toMatch(/(?:-H|--hostname)[ =]127\.0\.0\.1(?![\d.])/);
  });
});
