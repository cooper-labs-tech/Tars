#!/usr/bin/env node
/** `npm run release:linux`. Stub: written failures first. */
import { Refusal } from './release.mjs';

export const RELEASE_BRANCH = 'main';
export const WORKFLOW = 'release-linux.yml';
export const ARCHES = [];
const todo = () => { throw new Refusal('not yet'); };
export const parseArgs = todo;
export const artifactNames = todo;
export const allNames = todo;
export const builderArgs = todo;
export const buildSteps = todo;
export const verifyPublished = todo;
export const verifyLinuxBuild = todo;
export async function main() { return 1; }
