import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // next dev writes no AGENTS.md: under an agent it would leave an untracked file in
  // every worktree, and scripts/worktree.mjs never removes a worktree with one
  agentRules: false,
};

export default nextConfig;
