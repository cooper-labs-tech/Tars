/**
 * An agent made from the window with a role (a template's, a team member's) keeps it on itself: its `savedPrompt`,
 * written through agent:update as soon as main has made it. A launch prompt is a first task, which main no longer
 * writes over the role (Tars-Backend's fix of QA's B2), so a role passed only as one was lost, and with "send prompt"
 * off a template's role was never saved at all. A blank role saves nothing.
 */
export async function createAgentWithRole<P, A extends { id: string }>(
  api: {
    createAgent: (params: P) => Promise<A>;
    updateAgent: (params: { id: string; savedPrompt?: string | null }) => Promise<unknown>;
  },
  params: P,
  role: string | null | undefined,
): Promise<A> {
  const agent = await api.createAgent(params);
  const text = role?.trim();
  if (text) await api.updateAgent({ id: agent.id, savedPrompt: text });
  return agent;
}
