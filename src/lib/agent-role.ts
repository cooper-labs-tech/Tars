import { ipcReason } from './ipc-error';

/**
 * An agent made from the window with a role (a template's, a team member's) keeps it on itself: its `savedPrompt`,
 * written through agent:update as soon as main has made it. A launch prompt is a first task, which main no longer
 * writes over the role (Tars-Backend's fix of QA's B2), so a role passed only as one was lost, and with "send prompt"
 * off a template's role was never saved at all. A blank role saves nothing.
 *
 * A creation main refuses throws, as before. A role main refuses to save once the agent exists does not: the agent is
 * made, and the caller gets it with why its role was not saved (`roleNotSaved`), so it keeps the id and never makes a
 * second one (the Audit's L2 on PR 581).
 */
export async function createAgentWithRole<P, A extends { id: string }>(
  api: {
    createAgent: (params: P) => Promise<A>;
    updateAgent: (params: { id: string; savedPrompt?: string | null }) => Promise<unknown>;
  },
  params: P,
  role: string | null | undefined,
): Promise<{ agent: A; roleNotSaved: string | null }> {
  const agent = await api.createAgent(params);
  const text = role?.trim();
  if (!text) return { agent, roleNotSaved: null };
  try {
    const answer = await api.updateAgent({ id: agent.id, savedPrompt: text });
    // useElectronAgents' updateAgent answers main's refusal rather than throwing it (the Audit's L3 on PR 581).
    if (answer && typeof answer === 'object' && (answer as { success?: unknown }).success === false) {
      const error = (answer as { error?: unknown }).error;
      return { agent, roleNotSaved: typeof error === 'string' && error.trim() ? error.trim() : 'it was not saved' };
    }
    return { agent, roleNotSaved: null };
  } catch (err) {
    return { agent, roleNotSaved: ipcReason(err, 'it was not saved') };
  }
}
