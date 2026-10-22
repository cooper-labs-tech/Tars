import type { NextConfig } from "next";

const isElectronBuild = process.env.ELECTRON_BUILD === '1';

const nextConfig: NextConfig = {
  // Enable static export for Electron builds
  output: isElectronBuild ? 'export' : undefined,

  // For static export, we need to disable image optimization
  images: {
    unoptimized: true,
  },

  // Ensure trailing slashes for file:// protocol compatibility
  trailingSlash: true,

  // No assetPrefix needed - we use custom app:// protocol that handles absolute paths

  // next dev writes no AGENTS.md: under an agent it would leave an untracked file in
  // every worktree, and scripts/worktree.mjs never removes a worktree with one
  agentRules: false,
};

export default nextConfig;
