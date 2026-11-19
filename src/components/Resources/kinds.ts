import type { JanitorItem } from '@/types/electron';

/** Each kind of janitor item in plain words: the proposed list's groups, and each item of an agent's request. */
export const KINDS: Record<JanitorItem['kind'], string> = {
  'closed-worktree': 'Worktrees of merged branches',
  'next-cache': 'Build caches of idle worktrees',
  'test-artefacts': 'Test artefacts',
  'npx-cache': 'The npx cache',
  'docker-image': 'Docker images',
  'docker-vm-trim': 'The Docker VM',
  'agent-tmp': 'Temporary folders of removed agents',
  // 2.0.7, what agents leave behind (services/disk-report.ts).
  'session-scratchpad': 'Folders of ended agent sessions',
  'agent-tmp-entry': "Old files in agents' temporary folders",
  'release-folder': 'Release builds',
  'worktree-node-modules': 'node_modules of idle worktrees',
};
