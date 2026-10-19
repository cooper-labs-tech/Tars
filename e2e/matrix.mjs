#!/usr/bin/env node
// `npm run e2e:matrix`: the CLI matrix (e2e/cli-matrix.spec.ts), a Playwright project of its own since 19/10, there
// only with E2E_MATRIX=1 (playwright.config.ts). Whatever follows is handed to Playwright: a file, --grep, --reporter.
// The variable is set here rather than in package.json, where `E2E_MATRIX=1 playwright ...` does not run on Windows.
import { spawn } from 'node:child_process';
import { npmCommand } from '../scripts/npm-command.mjs';

const npx = npmCommand('npx', ['playwright', 'test', '--project=matrix', ...process.argv.slice(2)]);
const child = spawn(npx.command, npx.args, { stdio: 'inherit', env: { ...process.env, E2E_MATRIX: '1' } });
child.on('close', (code) => process.exit(code ?? 1));
