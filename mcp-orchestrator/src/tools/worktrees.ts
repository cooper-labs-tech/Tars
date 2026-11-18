/**
 * A worktree per task, for any project (2.0.7, W6 of the fresh-install report; electron/services/project-worktrees.ts,
 * the local API's /api/worktrees): a branch of its own for each piece of work, from the fresh default branch, in the
 * project's .worktrees, and removed once its PR is merged. In the calling agent's own project, or (2.0.7) in another
 * project the owner's grant across projects opens to it (`project`): a fleet worktree for one of that project's agents
 * to be moved onto (update_agent with worktree), its push turned off on request (`noPush`).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTools, text, tool } from "../../../mcp-shared/src/tools.js";
import { apiRequest } from "../utils/api.js";

type Worktree = { branch: string; path: string; head: string };

export function registerWorktreeTools(server: McpServer): void {
  registerTools(server, [
    tool({
      name: "worktree_new",
      description: "Make a worktree for one task in your project, in its .worktrees (which git is told to ignore), with the branch as it is: a branch another worktree holds (the worker's, when you gate its pull request) gives a detached checkout of its head, as pushed to origin when origin has it; a local branch is checked out; a branch only on origin (a pull request from elsewhere) is checked out from origin; any other name is a new branch from the default branch as last fetched (the local one with no remote). The answer says which and the commit it is on. The worktrees whose work is done are removed first. Refused on a disk under 10 GB free, past 20 worktrees, or outside a git repository, with why. Work, commit and push in it; deliver a pull request; never merge.",
      schema: {
        branch: z.string().max(200).describe("The branch, as feat/<what>, fix/<what> or chore/<what>: letters, digits, . _ - and /."),
        existing: z.boolean().optional().describe("The branch must exist already (a pull request's, when you gate it): refused, never made new from the default branch, when it is neither local nor on origin as last fetched."),
        project: z.string().optional().describe("Another project's absolute path, which the owner's grant across projects opens to you; your own when not given."),
        noPush: z.boolean().optional().describe("Turn push off for this worktree only: any git push from it fails at once, naming why; the project's other checkouts push as before."),
      },
      failure: "making a worktree",
      async run({ branch, existing, project, noPush }) {
        const made = (await apiRequest("/api/worktrees", "POST", { branch, ...(existing ? { existing: true } : {}), ...(project ? { project } : {}), ...(noPush ? { noPush: true } : {}) })) as { path: string; branch: string; kind: string; head: string; base: string; heldBy?: string; note?: string; pruned: string[]; pushOff?: boolean };
        const what = made.kind === "detached" ? `a detached checkout of ${made.branch}'s head, which ${made.heldBy} holds`
          : made.kind === "from-origin" ? `${made.branch}, as origin has it`
          : made.kind === "existing" ? `${made.branch}, as it is`
          : `${made.branch}, new from ${made.base}`;
        return text([
          `Worktree ${made.path}: ${what}, at ${made.head.slice(0, 9)}. Work there: cd into it for every command.`,
          ...(made.pushOff ? ["Its push is off: any git push from it fails, naming why."] : []),
          ...(made.note ? [`Note: ${made.note}.`] : []),
          ...(made.pruned.length ? [`Removed first, merged: ${made.pruned.join(", ")}.`] : []),
        ].join("\n"));
      },
    }),
    tool({
      name: "worktree_list",
      description: "The worktrees of your project's .worktrees (or of another project the owner's grant opens to you): each one's branch, folder and commit.",
      schema: {
        project: z.string().optional().describe("Another project's absolute path, which the owner's grant across projects opens to you; your own when not given."),
      },
      failure: "listing the worktrees",
      async run({ project }) {
        const { worktrees } = (await apiRequest(project ? `/api/worktrees?project=${encodeURIComponent(project)}` : "/api/worktrees", "GET")) as { worktrees: Worktree[] };
        return text(worktrees.length ? worktrees.map(w => `${w.branch}  ${w.path}  ${w.head.slice(0, 9)}`).join("\n") : "No worktree in this project's .worktrees.");
      },
    }),
    tool({
      name: "worktree_remove",
      description: "Remove one of your project's worktrees once its work is merged or abandoned. Never by force: refused while it has uncommitted or untracked changes, or while an agent runs in it. Its branch stays.",
      schema: {
        branch: z.string().max(200).describe("The worktree's branch, as worktree_list names it."),
        project: z.string().optional().describe("Another project's absolute path, which the owner's grant across projects opens to you; your own when not given."),
      },
      failure: "removing a worktree",
      async run({ branch, project }) {
        await apiRequest("/api/worktrees/remove", "POST", { branch, ...(project ? { project } : {}) });
        return text(`Removed the worktree of ${branch}; the branch stays.`);
      },
    }),
    tool({
      name: "worktree_prune",
      description: "Remove every worktree of your project whose branch is merged into the default branch, that is clean, whose HEAD has not moved for an hour, and that no agent runs in; say why each other one is kept. dry_run says what it would remove.",
      schema: {
        dry_run: z.boolean().optional().describe("Say what would be removed, and remove nothing."),
        project: z.string().optional().describe("Another project's absolute path, which the owner's grant across projects opens to you; your own when not given."),
      },
      failure: "pruning the worktrees",
      async run({ dry_run, project }) {
        const r = (await apiRequest("/api/worktrees/prune", "POST", { dryRun: dry_run === true, ...(project ? { project } : {}) })) as { removed: string[]; kept: Array<{ branch: string; why: string }> };
        return text([
          `${dry_run ? "Would remove" : "Removed"}: ${r.removed.length ? r.removed.join(", ") : "none"}.`,
          ...r.kept.map(k => `Kept ${k.branch}: ${k.why}.`),
        ].join("\n"));
      },
    }),
  ]);
}
