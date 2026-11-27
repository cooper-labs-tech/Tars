import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  saveEndpoint, approveEndpoint, removeEndpoint, setEndpointKey, endpointViews, endpointTarget, validateEndpointChoice,
  takeKeyFromDropFile, readModels, checkHealth, applyEndpointPatch, transportOf, type EndpointActor,
} from '../../electron/services/inference-endpoints';
import type { AppSettings, AgentStatus } from '../../electron/types';
import { cannotSymlink } from '../setup/symlink-privilege';

/**
 * Inference endpoints (native traces): what the user, or an agent, adds in Tars; the key
 * kept in the private folder; the approval the owner gives once in the window for any base URL an agent set; the
 * choice of an endpoint and model for an agent; the key drop file; the models and health probes.
 *
 * How it fails, written before the code (19/11):
 * 1. A base URL that is not http(s), holds credentials, a query or a fragment, or points at the link-local range,
 *    is saved.
 * 2. An endpoint an agent adds, or whose base URL an agent changes, is usable before the owner approves it; or a
 *    change of key, models, name or ceiling by an agent takes an approval away; or an agent turns traces on.
 * 3. The window's save is not an approval; an approval from the window does not approve the URL now in the record.
 * 4. The key ends up in an endpoint's view, or in what is saved to app-settings.json (it is a secret field).
 * 5. An endpoint is removed while agents use it.
 * 6. An agent is set on an endpoint that does not exist, is not approved, with a harness other than the four, a
 *    harness measured failed, or a model the endpoint does not list.
 * 7. The proxy's target is the unapproved base URL, or a request reaches an unapproved endpoint.
 * 8. The drop file: a name with a separator or `..`, not ending in .key, a symlink, a hard link, a file over 8 KiB,
 *    or more than one line is read; a drop folder that is a symlink is followed; the file stays after the key is
 *    taken; a refused file is deleted; its content appears in an error.
 * 9. /v1/models answering HTML, an error or a non-list wipes the models; the key appears in modelsError.
 * 10. The health probe does not say its status, latency and time, or says the key.
 * 11. holdMaxSeconds outside 0..3600 is saved; its default is not the general one (120 s).
 * 12. Session headers are sent by default: they name the agent and its session to a third party.
 * 13. (The Audit's H1 on #596.) The key goes to an address the owner did not approve: an agent moves an endpoint's
 *     base URL, then asks for its models or its health, and the probe sends the key there; or a redirect from the
 *     approved address carries it elsewhere. And an approval of a new address hands it the old address's key.
 * 14. (M1.) A probe hands back the whole settings as they were before its fetch, so saving them undoes what changed
 *     meanwhile (a project's trace opt-out).
 * 16. (The re-audit's I1 on #596.) A probe in flight while the address changes lands the old address's models or
 *     health on the new one.
 * 15. (L2, the orchestrator's rule.) Plain http to a public address is taken; or refused on loopback, a private range
 *     (RFC 1918, 100.64.0.0/10, fc00::/7) or IPv6 link-local; or an agent, rather than the owner in the window, allows
 *     plain http to a public address.
 * Added before their code, the owner's decision of 26/11 (extra headers per endpoint, a general option):
 * 17. An extra header that names the credential (Authorization, x-api-key, Cookie), the hop (Host, Content-Length,
 *     Transfer-Encoding, Connection, Accept-Encoding, a hop-by-hop or proxy header), a session header Tars sets
 *     (X-Session-Id, X-Agent-Id), a name that is not a header token, a name or value holding CR or LF, more than 16
 *     headers, a value over 1024 bytes, or two names equal but for case, is saved.
 * 18. The owner's extra headers are not in the proxy's target or the view, or saving them takes the approval away;
 *     an empty map does not clear them.
 * 19. An agent adds or changes extra headers and they go out with the owner's key before the owner approved them;
 *     or saving the same headers again takes an approval away; or the change takes the key away.
 * 20. A probe of an approved endpoint leaves its extra headers out (an endpoint that needs them answers 4xx), or
 *     sends them to an address the owner did not approve.
 * Added before their code, a finding of the window's work on #599 (27/11): approval stays apart from saving.
 * 21. The owner's save of another field (traces, the name, the hold) on an endpoint whose address or extra headers an
 *     agent changed approves that change unseen.
 * 22. An approval approves something other than what the owner saw: one given with no values, or with values an
 *     agent changed again since the notice was shown, is taken; or one with the values shown is refused.
 * 23. The owner's own change of address or extra headers in the window is not its own approval; putting the approved
 *     values back is refused; or the owner's new address approves headers an agent changed meanwhile.
 * Added before their code, the Audit's M-b at c31811361 (27/11), a stale form:
 * 24. An agent sets an address Y, the owner's form opens showing Y, the agent sets X, and the owner's save of another
 *     field sends Y back: Y counts as typed by the owner, and is approved.
 * 25. The same race with the extra headers.
 * 26. A save from the window on an endpoint that exists, with no `shown`, is taken; or a fresh form (shown equal to the
 *     record) no longer behaves as before.
 * 27. (The window's work on #599, which shows main's words as they come.) The refusal of a save or an approval says
 *     when the agent changed the endpoint as a raw ISO time, not as the other notices do ("12:00 UTC (16:00 +04)").
 * And the install header (trace feature A4, 27/11): an endpoint that keeps its own copy of what it serves may be told
 * the install's back-office id, so that a deletion of the whole install reaches that copy too.
 * 28. The install header is on by default, or on for an endpoint whose session headers are off: it goes only with
 *     them, so a save asking for it without them is refused, and turning them off turns it off too.
 * 29. An agent turns it on: like plain http, it is the owner's, in the window.
 * 30. The proxy's target carries an install id when the switch is off, when the session headers are off, or when no
 *     id is given (an install registered with no back-office); or it leaves the id out when all three hold.
 * 31. The view does not say whether the switch is on, so the window cannot show it.
 */

const NOW = '2026-11-19T12:00:00.000Z';
const OWNER: EndpointActor = { window: true };
const AGENT: EndpointActor = { agentId: 'agent-remote', agentName: 'Remote-Tuner' };
const base = (): AppSettings => ({ inferenceEndpoints: [] } as unknown as AppSettings);
const agent = (over: Partial<AgentStatus>): AgentStatus => ({ id: 'a1', name: 'Q', projectPath: '/p', provider: 'qwen-code', model: 'GLM', status: 'idle', skills: [], ...over } as unknown as AgentStatus);

function added(settings: AppSettings, actor: EndpointActor, over: Record<string, unknown> = {}) {
  const r = saveEndpoint(settings, { name: 'Remote host', baseUrl: 'http://192.168.50.10:9000/v1', allowTraces: false, ...over }, actor, NOW);
  if (!r.ok) throw new Error(r.error);
  return r;
}

/** What the window shows of an endpoint, which an approval names (seen). */
const seenOf = (settings: AppSettings, id: string) => {
  const v = endpointViews(settings, []).find(e => e.id === id)!;
  return { baseUrl: v.baseUrl, extraHeaders: v.extraHeaders };
};

describe('saving endpoints', () => {
  it('1: only a plain http(s) base URL is saved', () => {
    for (const baseUrl of ['ftp://h/v1', 'http://user:pw@h/v1', 'http://h/v1?x=1', 'http://h/v1#f', 'http://169.254.169.254/v1', 'not a url', '']) {
      expect(saveEndpoint(base(), { name: 'x', baseUrl, allowTraces: false }, OWNER, NOW).ok, baseUrl).toBe(false);
    }
    const r = added(base(), OWNER, { baseUrl: 'https://h.example/v1/' });
    expect(r.endpoint.baseUrl).toBe('https://h.example/v1');
    expect(r.endpoint.id).toMatch(/^ep-[0-9a-f]{6}$/);
  });

  it('2: what an agent adds or re-points waits for the owner; what else it changes keeps the approval', () => {
    // An agent cannot add one with traces on: that is the owner's.
    expect(saveEndpoint(base(), { name: 'x', baseUrl: 'https://h.example/v1', allowTraces: true }, AGENT, NOW).ok).toBe(false);
    const byAgent = added(base(), AGENT);
    expect(byAgent.endpoint).toMatchObject({ approved: false, allowTraces: false, changedBy: { agentId: 'agent-remote' } });
    expect('refused' in endpointTarget(byAgent.settings, byAgent.endpoint.id)).toBe(true);

    const approved = approveEndpoint(byAgent.settings, byAgent.endpoint.id, seenOf(byAgent.settings, byAgent.endpoint.id));
    if (!approved.ok) throw new Error(approved.error);
    expect(approved.endpoint).toMatchObject({ approved: true, approvedBaseUrl: 'http://192.168.50.10:9000/v1' });

    const renamed = saveEndpoint(approved.settings, { id: byAgent.endpoint.id, name: 'Remote host 2', holdMaxSeconds: 120 }, AGENT, NOW);
    if (!renamed.ok) throw new Error(renamed.error);
    expect(renamed.endpoint.approved).toBe(true);
    const keyed = setEndpointKey(renamed.settings, byAgent.endpoint.id, 'k-rotated');
    if (!keyed.ok) throw new Error(keyed.error);
    expect(endpointViews(keyed.settings, [])[0].approved).toBe(true);
    // An agent cannot turn traces on, and may turn them off.
    const tracesOn = saveEndpoint(keyed.settings, { id: byAgent.endpoint.id, allowTraces: true }, AGENT, NOW);
    expect(tracesOn.ok).toBe(false);

    const moved = saveEndpoint(keyed.settings, { id: byAgent.endpoint.id, baseUrl: 'https://evil.example/v1' }, AGENT, NOW);
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.endpoint).toMatchObject({ approved: false, approvedBaseUrl: 'http://192.168.50.10:9000/v1', baseUrl: 'https://evil.example/v1' });
    expect('refused' in endpointTarget(moved.settings, byAgent.endpoint.id)).toBe(true);
  });

  it('3: what the owner saves in the window is approved by that act', () => {
    const r = added(base(), OWNER, { allowTraces: true });
    expect(r.endpoint).toMatchObject({ approved: true, approvedBaseUrl: 'http://192.168.50.10:9000/v1', allowTraces: true });
    const target = endpointTarget(r.settings, r.endpoint.id);
    expect(target).toMatchObject({ baseUrl: 'http://192.168.50.10:9000/v1', holdMaxSeconds: 120, sendSessionHeaders: false });
    const withHeaders = saveEndpoint(r.settings, { id: r.endpoint.id, sendSessionHeaders: true, shown: seenOf(r.settings, r.endpoint.id) }, OWNER, NOW);
    if (!withHeaders.ok) throw new Error(withHeaders.error);
    expect(endpointTarget(withHeaders.settings, r.endpoint.id)).toMatchObject({ sendSessionHeaders: true });
    expect(endpointViews(withHeaders.settings, [])[0]).toMatchObject({ sendSessionHeaders: true, holdMaxSeconds: 120 });
  });

  it('17: an extra header that is the credential, the hop, a session header or malformed is refused, and nothing saved', () => {
    const r = added(base(), OWNER);
    const refused: Array<Record<string, unknown>> = [
      ...['Authorization', 'x-api-key', 'Cookie', 'Host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'Accept-Encoding',
        'X-Session-Id', 'x-agent-id', 'Keep-Alive', 'TE', 'Trailer', 'Upgrade', 'Proxy-Authorization', 'Proxy-Connection'].map(n => ({ [n]: 'v' })),
      { 'X Bad': 'v' }, { 'X-Bad:': 'v' }, { '': 'v' }, { 'X-Ok': 'line1\r\nX-Injected: 1' }, { 'X-Ok': 'a\nb' }, { 'X-Ok\r\n': 'v' },
      { 'X-Ok': 42 }, { 'X-Ok': 'x'.repeat(1025) }, { 'X-Dup': 'a', 'x-dup': 'b' },
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`X-H${i}`, 'v'])),
    ];
    for (const extraHeaders of refused) {
      const s = saveEndpoint(r.settings, { id: r.endpoint.id, extraHeaders, shown: seenOf(r.settings, r.endpoint.id) } as Parameters<typeof saveEndpoint>[1], OWNER, NOW);
      expect(s.ok, JSON.stringify(extraHeaders).slice(0, 80)).toBe(false);
    }
    for (const extraHeaders of [['X-A', 'v'], 'X-A: v', null]) {
      expect(saveEndpoint(r.settings, { id: r.endpoint.id, extraHeaders, shown: seenOf(r.settings, r.endpoint.id) } as unknown as Parameters<typeof saveEndpoint>[1], OWNER, NOW).ok, String(extraHeaders)).toBe(false);
    }
  });

  it('18: the owner\'s extra headers keep the approval, reach the target and the view, and an empty map clears them', () => {
    const r = added(base(), OWNER);
    const s = saveEndpoint(r.settings, { id: r.endpoint.id, extraHeaders: { 'X-Tenant': 'team-blue', 'X-Route': 'r1' }, shown: seenOf(r.settings, r.endpoint.id) }, OWNER, NOW);
    if (!s.ok) throw new Error(s.error);
    expect(s.endpoint.approved).toBe(true);
    expect(endpointTarget(s.settings, r.endpoint.id)).toMatchObject({ extraHeaders: { 'X-Tenant': 'team-blue', 'X-Route': 'r1' } });
    expect(endpointViews(s.settings, [])[0].extraHeaders).toEqual({ 'X-Tenant': 'team-blue', 'X-Route': 'r1' });
    const kept = saveEndpoint(s.settings, { id: r.endpoint.id, name: 'Renamed', shown: seenOf(s.settings, r.endpoint.id) }, OWNER, NOW);
    if (!kept.ok) throw new Error(kept.error);
    expect(endpointViews(kept.settings, [])[0].extraHeaders).toEqual({ 'X-Tenant': 'team-blue', 'X-Route': 'r1' });
    const cleared = saveEndpoint(kept.settings, { id: r.endpoint.id, extraHeaders: {}, shown: seenOf(kept.settings, r.endpoint.id) }, OWNER, NOW);
    if (!cleared.ok) throw new Error(cleared.error);
    expect(endpointViews(cleared.settings, [])[0].extraHeaders).toEqual({});
    expect((endpointTarget(cleared.settings, r.endpoint.id) as { extraHeaders?: object }).extraHeaders ?? {}).toEqual({});
  });

  it('19: an agent\'s extra headers wait for the owner, keep the key, and the same headers again keep the approval', () => {
    const r = added(base(), OWNER);
    const keyed = setEndpointKey(r.settings, r.endpoint.id, 'k-owner');
    if (!keyed.ok) throw new Error(keyed.error);
    const byAgent = saveEndpoint(keyed.settings, { id: r.endpoint.id, extraHeaders: { 'X-Route': 'elsewhere' } }, AGENT, NOW);
    if (!byAgent.ok) throw new Error(byAgent.error);
    expect(byAgent.endpoint).toMatchObject({ approved: false, changedBy: { agentId: 'agent-remote' } });
    expect('refused' in endpointTarget(byAgent.settings, r.endpoint.id)).toBe(true);
    expect(endpointViews(byAgent.settings, [])[0].keySet).toBe(true);
    const approved = approveEndpoint(byAgent.settings, r.endpoint.id, seenOf(byAgent.settings, r.endpoint.id));
    if (!approved.ok) throw new Error(approved.error);
    expect(endpointTarget(approved.settings, r.endpoint.id)).toMatchObject({ key: 'k-owner', extraHeaders: { 'X-Route': 'elsewhere' } });
    // The same map again, in another key order or case of nothing: no change, the approval stays.
    const again = saveEndpoint(approved.settings, { id: r.endpoint.id, extraHeaders: { 'X-Route': 'elsewhere' }, holdMaxSeconds: 60 }, AGENT, NOW);
    if (!again.ok) throw new Error(again.error);
    expect(again.endpoint.approved).toBe(true);
    // A refused header is refused for an agent too.
    expect(saveEndpoint(approved.settings, { id: r.endpoint.id, extraHeaders: { Authorization: 'Bearer x' } }, AGENT, NOW).ok).toBe(false);
  });

  it('20: a probe of the approved address sends the extra headers with the key; of an address an agent moved to, neither', async () => {
    const r = added(base(), OWNER, { baseUrl: 'https://h.example/v1' });
    const s = saveEndpoint(r.settings, { id: r.endpoint.id, extraHeaders: { 'X-Tenant': 'team-blue' }, shown: seenOf(r.settings, r.endpoint.id) }, OWNER, NOW);
    if (!s.ok) throw new Error(s.error);
    const keyed = setEndpointKey(s.settings, r.endpoint.id, 'k-owner');
    if (!keyed.ok) throw new Error(keyed.error);
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init: { headers?: Record<string, string> }) => {
      sent.push({ url, headers: init.headers ?? {} });
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await readModels(keyed.settings, r.endpoint.id, fetchImpl, NOW);
    await checkHealth(keyed.settings, r.endpoint.id, fetchImpl, NOW);
    expect(sent.map(x => x.headers['X-Tenant'])).toEqual(['team-blue', 'team-blue']);
    const moved = saveEndpoint(keyed.settings, { id: r.endpoint.id, baseUrl: 'https://other.example/v1' }, AGENT, NOW);
    if (!moved.ok) throw new Error(moved.error);
    sent.length = 0;
    await readModels(moved.settings, r.endpoint.id, fetchImpl, NOW);
    expect(sent[0].url).toBe('https://other.example/v1/models');
    expect(sent[0].headers['X-Tenant']).toBeUndefined();
    expect(sent[0].headers.Authorization).toBeUndefined();
  });

  /** An owner's endpoint, approved, with a key, then an agent's change of its address and of its headers. */
  function pendingAfterAgent() {
    const r = added(base(), OWNER, { baseUrl: 'https://h.example/v1', allowTraces: true });
    const keyed = setEndpointKey(r.settings, r.endpoint.id, 'k-owner');
    if (!keyed.ok) throw new Error(keyed.error);
    const moved = saveEndpoint(keyed.settings, { id: r.endpoint.id, baseUrl: 'https://agent.example/v1', extraHeaders: { 'X-Route': 'agent' } }, AGENT, NOW);
    if (!moved.ok) throw new Error(moved.error);
    return { id: r.endpoint.id, settings: moved.settings };
  }
  it('21: the owner\'s save of traces, the name or the hold leaves an agent\'s change pending', () => {
    const p = pendingAfterAgent();
    for (const change of [{ allowTraces: false }, { name: 'Renamed' }, { holdMaxSeconds: 30 }, { allowTraces: true, name: 'Again' }]) {
      // The window sends the whole form: the address and headers it shows, which are the pending ones.
      const s = saveEndpoint(p.settings, { id: p.id, ...seenOf(p.settings, p.id), ...change, shown: seenOf(p.settings, p.id) }, OWNER, NOW);
      if (!s.ok) throw new Error(s.error);
      expect(s.endpoint, JSON.stringify(change)).toMatchObject({ approved: false, approvedBaseUrl: 'https://h.example/v1', approvedExtraHeaders: {} });
      expect('refused' in endpointTarget(s.settings, p.id), JSON.stringify(change)).toBe(true);
    }
  });

  it('22: an approval approves what the owner saw, and nothing else', () => {
    const p = pendingAfterAgent();
    const seen = seenOf(p.settings, p.id);
    expect(approveEndpoint(p.settings, p.id).ok).toBe(false);
    // The agent changes the headers again while the notice is open.
    const again = saveEndpoint(p.settings, { id: p.id, extraHeaders: { 'X-Route': 'agent-2' } }, AGENT, NOW);
    if (!again.ok) throw new Error(again.error);
    const stale = approveEndpoint(again.settings, p.id, seen);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toMatch(/changed/);
    const movedAgain = saveEndpoint(p.settings, { id: p.id, baseUrl: 'https://agent-2.example/v1' }, AGENT, NOW);
    if (!movedAgain.ok) throw new Error(movedAgain.error);
    expect(approveEndpoint(movedAgain.settings, p.id, seen).ok).toBe(false);
    // What it saw, in another key order: approved, both parts.
    const ok = approveEndpoint(p.settings, p.id, { baseUrl: seen.baseUrl, extraHeaders: { ...seen.extraHeaders } });
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.endpoint).toMatchObject({ approved: true, approvedBaseUrl: 'https://agent.example/v1', approvedExtraHeaders: { 'X-Route': 'agent' } });
    expect(endpointTarget(ok.settings, p.id)).toMatchObject({ baseUrl: 'https://agent.example/v1', extraHeaders: { 'X-Route': 'agent' } });
  });

  it('23: the owner\'s own address or headers, and putting the approved values back, are the owner\'s approval', () => {
    const p = pendingAfterAgent();
    // Put back: the approved address and headers, typed back in the window.
    const back = saveEndpoint(p.settings, { id: p.id, baseUrl: 'https://h.example/v1', extraHeaders: {}, shown: seenOf(p.settings, p.id) }, OWNER, NOW);
    if (!back.ok) throw new Error(back.error);
    expect(back.endpoint).toMatchObject({ approved: true, baseUrl: 'https://h.example/v1', extraHeaders: {} });
    // An address of the owner's own, the agent's headers still pending: the address is approved, the endpoint is not.
    const own = saveEndpoint(p.settings, { id: p.id, baseUrl: 'https://owner.example/v1', extraHeaders: { 'X-Route': 'agent' }, shown: seenOf(p.settings, p.id) }, OWNER, NOW);
    if (!own.ok) throw new Error(own.error);
    expect(own.endpoint).toMatchObject({ approved: false, approvedBaseUrl: 'https://owner.example/v1', approvedExtraHeaders: {} });
    // And headers of the owner's own on top: both are the owner's now.
    const both = saveEndpoint(own.settings, { id: p.id, extraHeaders: { 'X-Route': 'owner' }, shown: seenOf(own.settings, p.id) }, OWNER, NOW);
    if (!both.ok) throw new Error(both.error);
    expect(both.endpoint).toMatchObject({ approved: true, approvedBaseUrl: 'https://owner.example/v1', approvedExtraHeaders: { 'X-Route': 'owner' } });
  });

  it('24 and 25: a form that shows values an agent changed since is refused, and nothing is approved', () => {
    const r = added(base(), OWNER, { baseUrl: 'https://h.example/v1', allowTraces: true });
    // 1. The agent sets Y (and headers). 2. The form opens on it.
    const y = saveEndpoint(r.settings, { id: r.endpoint.id, baseUrl: 'https://y.example/v1', extraHeaders: { 'X-Route': 'y' } }, AGENT, NOW);
    if (!y.ok) throw new Error(y.error);
    const shown = seenOf(y.settings, r.endpoint.id);
    // 3. The agent sets X, or changes only the headers.
    for (const [what, change] of [['the address', { baseUrl: 'https://x.example/v1' }], ['the headers', { extraHeaders: { 'X-Route': 'x' } }]] as const) {
      const x = saveEndpoint(y.settings, { id: r.endpoint.id, ...change }, AGENT, NOW);
      if (!x.ok) throw new Error(x.error);
      // 4. The owner toggles traces; the form sends back what it showed.
      const toggled = saveEndpoint(x.settings, { id: r.endpoint.id, ...shown, allowTraces: false, shown } as Parameters<typeof saveEndpoint>[1], OWNER, NOW);
      expect(toggled.ok, what).toBe(false);
      if (!toggled.ok) expect(toggled.error, what).toMatch(/changed since it was shown/);
    }
  });

  it('26: a save of an endpoint that exists names what the form showed; a fresh form behaves as before', () => {
    const p = pendingAfterAgent();
    const noShown = saveEndpoint(p.settings, { id: p.id, ...seenOf(p.settings, p.id), allowTraces: false }, OWNER, NOW);
    expect(noShown.ok).toBe(false);
    // A new endpoint has nothing shown before it.
    expect(added(base(), OWNER).endpoint.approved).toBe(true);
    const shown = seenOf(p.settings, p.id);
    const toggled = saveEndpoint(p.settings, { id: p.id, ...shown, allowTraces: false, shown } as Parameters<typeof saveEndpoint>[1], OWNER, NOW);
    if (!toggled.ok) throw new Error(toggled.error);
    expect(toggled.endpoint).toMatchObject({ approved: false, allowTraces: false, approvedBaseUrl: 'https://h.example/v1' });
    const own = saveEndpoint(p.settings, { id: p.id, baseUrl: 'https://owner.example/v1', extraHeaders: {}, shown } as Parameters<typeof saveEndpoint>[1], OWNER, NOW);
    if (!own.ok) throw new Error(own.error);
    expect(own.endpoint).toMatchObject({ approved: true, approvedBaseUrl: 'https://owner.example/v1' });
  });

  it('27: a refusal says when the agent changed the endpoint as the notices do, UTC then local with its offset', () => {
    const p = pendingAfterAgent();
    const shown = seenOf(p.settings, p.id);
    const again = saveEndpoint(p.settings, { id: p.id, baseUrl: 'https://again.example/v1' }, AGENT, NOW);
    if (!again.ok) throw new Error(again.error);
    const save = saveEndpoint(again.settings, { id: p.id, ...shown, allowTraces: false, shown }, OWNER, NOW);
    const approve = approveEndpoint(again.settings, p.id, shown);
    for (const [what, r] of [['save', save], ['approve', approve]] as const) {
      expect(r.ok, what).toBe(false);
      if (r.ok) continue;
      // utils/two-zones.ts: "12:00 UTC (16:00 +04)", or "12:00 UTC" alone on a machine on UTC.
      expect(r.error, what).toMatch(/\(Remote-Tuner, 12:00 UTC( \(\d\d:\d\d [+-]\d\d(:\d\d)?\))?\)/);
      expect(r.error, what).not.toMatch(/\d{4}-\d\d-\d\dT/);
    }
  });

  it('4: the key is never in a view nor in the endpoint record', () => {
    const r = added(base(), OWNER);
    const keyed = setEndpointKey(r.settings, r.endpoint.id, 'sk-secret-value');
    if (!keyed.ok) throw new Error(keyed.error);
    const views = endpointViews(keyed.settings, []);
    expect(JSON.stringify(views)).not.toContain('sk-secret-value');
    expect(views[0].keySet).toBe(true);
    expect(JSON.stringify(keyed.settings.inferenceEndpoints)).not.toContain('sk-secret-value');
    expect(keyed.settings.endpointKeys).toEqual({ [r.endpoint.id]: 'sk-secret-value' });
    expect(endpointTarget(keyed.settings, r.endpoint.id)).toMatchObject({ key: 'sk-secret-value' });
    const cleared = setEndpointKey(keyed.settings, r.endpoint.id, null);
    if (!cleared.ok) throw new Error(cleared.error);
    expect(endpointViews(cleared.settings, [])[0].keySet).toBe(false);
  });

  it('5: an endpoint in use is not removed, and the views say who uses it', () => {
    const r = added(base(), OWNER);
    const users = [agent({ id: 'a1', name: 'Q', endpointId: r.endpoint.id })];
    expect(endpointViews(r.settings, users)[0].agents).toEqual([{ id: 'a1', name: 'Q', projectPath: '/p', provider: 'qwen-code', model: 'GLM' }]);
    const refused = removeEndpoint(r.settings, r.endpoint.id, users);
    expect(refused.ok).toBe(false);
    expect(removeEndpoint(r.settings, r.endpoint.id, []).ok).toBe(true);
  });

  it('11: the hold ceiling stays within 0 and 3600 seconds', () => {
    expect(saveEndpoint(base(), { name: 'x', baseUrl: 'https://h.example/v1', allowTraces: false, holdMaxSeconds: 4000 }, OWNER, NOW).ok).toBe(false);
    expect(saveEndpoint(base(), { name: 'x', baseUrl: 'https://h.example/v1', allowTraces: false, holdMaxSeconds: -1 }, OWNER, NOW).ok).toBe(false);
    expect(added(base(), OWNER, { holdMaxSeconds: 0 }).endpoint.holdMaxSeconds).toBe(0);
  });
});

describe('the key goes only where the owner approved (H1, M1)', () => {
  type Seen = { url: string; auth?: string; redirect?: string };
  const recorder = (status = 200, body = JSON.stringify({ data: [{ id: 'open-coder-1' }] })) => {
    const seen: Seen[] = [];
    const f = (async (u: string, init?: RequestInit) => {
      seen.push({ url: String(u), auth: (init?.headers as Record<string, string> | undefined)?.Authorization, redirect: init?.redirect });
      return new Response(body, { status });
    }) as unknown as typeof fetch;
    return { seen, f };
  };

  it('13: after an agent moves the base URL, models and health send no key, and nothing follows a redirect', async () => {
    const r = added(base(), OWNER, { baseUrl: 'https://approved.example.com/v1' });
    const keyed = setEndpointKey(r.settings, r.endpoint.id, 'sk-the-owners-key');
    if (!keyed.ok) throw new Error(keyed.error);
    const moved = saveEndpoint(keyed.settings, { id: r.endpoint.id, baseUrl: 'https://attacker.example.com/v1' }, AGENT, NOW);
    if (!moved.ok) throw new Error(moved.error);
    const a = recorder();
    await readModels(moved.settings, r.endpoint.id, a.f, NOW);
    await checkHealth(moved.settings, r.endpoint.id, a.f, NOW);
    expect(a.seen.length).toBe(2);
    for (const call of a.seen) {
      expect(call.auth, call.url).toBeUndefined();
      expect(call.redirect).toBe('manual');
    }
    // And the move took the key away: the owner's approval of the new address never hands it the old one's.
    expect(moved.settings.endpointKeys?.[r.endpoint.id]).toBeUndefined();
    // The owner setting a key again, before approving the new address, still sends it nowhere unapproved.
    const rekeyed = setEndpointKey(moved.settings, r.endpoint.id, 'sk-set-again');
    if (!rekeyed.ok) throw new Error(rekeyed.error);
    const b = recorder();
    await readModels(rekeyed.settings, r.endpoint.id, b.f, NOW);
    await checkHealth(rekeyed.settings, r.endpoint.id, b.f, NOW);
    expect(b.seen.map(c => c.auth)).toEqual([undefined, undefined]);
    const approved = approveEndpoint(moved.settings, r.endpoint.id, seenOf(moved.settings, r.endpoint.id));
    if (!approved.ok) throw new Error(approved.error);
    expect(endpointTarget(approved.settings, r.endpoint.id)).toMatchObject({ key: null });
  });

  it('13: on the approved address the key goes, with redirects not followed, and a redirect answer is no success', async () => {
    const r = added(base(), OWNER, { baseUrl: 'https://approved.example.com/v1' });
    const keyed = setEndpointKey(r.settings, r.endpoint.id, 'sk-the-owners-key');
    if (!keyed.ok) throw new Error(keyed.error);
    const a = recorder();
    await readModels(keyed.settings, r.endpoint.id, a.f, NOW);
    expect(a.seen[0]).toMatchObject({ url: 'https://approved.example.com/v1/models', auth: 'Bearer sk-the-owners-key', redirect: 'manual' });
    const moved = await readModels(keyed.settings, r.endpoint.id, recorder(302, '').f, NOW);
    expect(moved.ok).toBe(false);
    // The owner moving the address keeps the key: the owner's own act, approved by it.
    const ownerMoved = saveEndpoint(keyed.settings, { id: r.endpoint.id, baseUrl: 'https://new.example.com/v1', shown: seenOf(keyed.settings, r.endpoint.id) }, OWNER, NOW);
    if (!ownerMoved.ok) throw new Error(ownerMoved.error);
    expect(ownerMoved.settings.endpointKeys?.[r.endpoint.id]).toBe('sk-the-owners-key');
  });

  it('14: a probe hands back a patch, which lands on the settings as they are when it is written', async () => {
    const r = added(base(), OWNER);
    const m = await readModels(r.settings, r.endpoint.id, recorder().f, NOW);
    const h = await checkHealth(r.settings, r.endpoint.id, recorder().f, NOW);
    expect('settings' in m).toBe(false);
    expect('settings' in h).toBe(false);
    // Meanwhile, the owner took a project out of traces.
    const fresh = { ...r.settings, traces: { projects: [], capBytes: 1, retentionDays: 1, pairs: [], excludeClosedModels: true, uploadUrl: '' } } as AppSettings;
    const after = applyEndpointPatch(applyEndpointPatch(fresh, r.endpoint.id, m.patch), r.endpoint.id, h.patch);
    expect(after.traces?.projects).toEqual([]);
    expect(after.inferenceEndpoints![0]).toMatchObject({ models: ['open-coder-1'], health: { ok: true } });
  });
});

describe('a probe across a change of address (re-audit I1)', () => {
  it('16: the patch of a probe of the old address does not land on the new one', async () => {
    const r = added(base(), OWNER, { baseUrl: 'https://old.example.com/v1' });
    const m = await readModels(r.settings, r.endpoint.id, (async () => new Response(JSON.stringify({ data: [{ id: 'old-model' }] }), { status: 200 })) as unknown as typeof fetch, NOW);
    const h = await checkHealth(r.settings, r.endpoint.id, (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch, NOW);
    const moved = saveEndpoint(r.settings, { id: r.endpoint.id, baseUrl: 'https://new.example.com/v1', shown: seenOf(r.settings, r.endpoint.id) }, OWNER, NOW);
    if (!moved.ok) throw new Error(moved.error);
    const after = applyEndpointPatch(applyEndpointPatch(moved.settings, r.endpoint.id, m.patch, m.probed), r.endpoint.id, h.patch, h.probed);
    expect(after.inferenceEndpoints![0].models).toEqual([]);
    expect(after.inferenceEndpoints![0].health).toBeUndefined();
    const same = applyEndpointPatch(r.settings, r.endpoint.id, m.patch, m.probed);
    expect(same.inferenceEndpoints![0].models).toEqual(['old-model']);
  });
});

describe('plain http (L2)', () => {
  it('15: https anywhere; plain http on loopback, private ranges and IPv6 link-local; elsewhere only by the owner', () => {
    expect(transportOf('https://api.example.com/v1')).toBe('https');
    for (const u of ['http://127.0.0.1:8000/v1', 'http://localhost:11434/v1', 'http://10.1.2.3/v1', 'http://172.16.0.9/v1', 'http://192.168.1.20/v1', 'http://100.64.0.1/v1', 'http://100.127.255.254/v1', 'http://[fd12::1]/v1', 'http://[fe80::1]/v1', 'http://[::1]/v1']) {
      expect(transportOf(u), u).toBe('http-private');
    }
    for (const u of ['http://203.0.113.5/v1', 'http://api.example.com/v1', 'http://100.128.0.1/v1', 'http://172.32.0.1/v1']) {
      expect(transportOf(u), u).toBe('http-public');
    }
    expect(saveEndpoint(base(), { name: 'x', baseUrl: 'http://203.0.113.5/v1', allowTraces: false }, OWNER, NOW).ok).toBe(false);
    expect(saveEndpoint(base(), { name: 'x', baseUrl: 'http://203.0.113.5/v1', allowTraces: false, allowPlainHttp: true }, AGENT, NOW).ok).toBe(false);
    const allowed = saveEndpoint(base(), { name: 'x', baseUrl: 'http://203.0.113.5/v1', allowTraces: false, allowPlainHttp: true }, OWNER, NOW);
    expect(allowed.ok).toBe(true);
    const lan = saveEndpoint(base(), { name: 'x', baseUrl: 'http://192.168.1.20/v1', allowTraces: false }, AGENT, NOW);
    if (!lan.ok) throw new Error(lan.error);
    expect(endpointViews(lan.settings, [])[0]).toMatchObject({ plainHttp: true });
    const tls = added(base(), OWNER, { baseUrl: 'https://api.example.com/v1' });
    expect(endpointViews(tls.settings, [])[0]).toMatchObject({ plainHttp: false });
  });
});

describe('choosing an endpoint for an agent', () => {
  it('6: an approved endpoint, one of the four harnesses not measured failed, one of its models', () => {
    const r = added(base(), OWNER);
    const s = { ...r.settings, inferenceEndpoints: r.settings.inferenceEndpoints!.map(e => ({ ...e, models: ['GLM', 'Qwen'] })) };
    expect(validateEndpointChoice(s, { endpointId: r.endpoint.id, provider: 'qwen-code', model: 'GLM' })).toBeNull();
    expect(validateEndpointChoice(s, { endpointId: 'ep-ffffff', provider: 'qwen-code', model: 'GLM' })).toMatch(/no such endpoint/i);
    expect(validateEndpointChoice(s, { endpointId: r.endpoint.id, provider: 'claude', model: 'GLM' })).toMatch(/codex, pi, qwen-code or opencode/);
    expect(validateEndpointChoice(s, { endpointId: r.endpoint.id, provider: 'qwen-code', model: 'Mistral' })).toMatch(/does not list/);
    expect(validateEndpointChoice(s, { endpointId: r.endpoint.id, provider: 'codex', model: 'GLM' }, { codex: 'failed' })).toMatch(/tool calls/);
    const unapproved = { ...s, inferenceEndpoints: s.inferenceEndpoints!.map(e => ({ ...e, approved: false })) };
    expect(validateEndpointChoice(unapproved, { endpointId: r.endpoint.id, provider: 'qwen-code', model: 'GLM' })).toMatch(/approve/);
    expect(validateEndpointChoice(s, { endpointId: null, provider: 'claude', model: 'x' })).toBeNull();
  });

  it('7: no target for an unknown endpoint', () => {
    expect(endpointTarget(base(), 'ep-000000')).toMatchObject({ refused: { status: 404 } });
  });
});

describe('the key drop file', () => {
  let dir: string;
  beforeEach(() => { dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drop-')), 'endpoint-keys'); });
  afterEach(() => { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); });
  const drop = (name: string, content: string) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), content); };

  it('8: a good drop file gives its key and is deleted', () => {
    drop('remote.key', 'sk-abc123XYZ\n');
    expect(takeKeyFromDropFile('remote.key', dir)).toEqual({ ok: true, key: 'sk-abc123XYZ' });
    expect(fs.existsSync(path.join(dir, 'remote.key'))).toBe(false);
  });

  it('8: bad names are refused before anything is read', () => {
    for (const name of ['../x.key', 'a/b.key', 'a\\b.key', 'remote.txt', '.key', '', 'x'.repeat(70) + '.key', '/etc/passwd']) {
      const r = takeKeyFromDropFile(name, dir);
      expect(r.ok, name).toBe(false);
    }
  });

  it.skipIf(cannotSymlink())('8: a symlink, a hard link or a linked drop folder is refused, and left where it is', () => {
    const outside = path.join(path.dirname(dir), 'outside-secret');
    fs.writeFileSync(outside, 'PRIVATE-VALUE');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'sym.key'));
    fs.linkSync(outside, path.join(dir, 'hard.key'));
    for (const name of ['sym.key', 'hard.key']) {
      const r = takeKeyFromDropFile(name, dir);
      expect(r.ok, name).toBe(false);
      expect(JSON.stringify(r)).not.toContain('PRIVATE-VALUE');
    }
    expect(fs.existsSync(path.join(dir, 'sym.key'))).toBe(true);
    const linkedDir = path.join(path.dirname(dir), 'linked');
    fs.mkdirSync(path.join(path.dirname(dir), 'real'));
    fs.writeFileSync(path.join(path.dirname(dir), 'real', 'k.key'), 'sk-1');
    fs.symlinkSync(path.join(path.dirname(dir), 'real'), linkedDir);
    expect(takeKeyFromDropFile('k.key', linkedDir).ok).toBe(false);
  });

  it('8: content that is not one printable line, or too big, is refused without being shown', () => {
    drop('two.key', 'line-one\nline-two\n');
    drop('big.key', 'k'.repeat(9000));
    drop('space.key', 'has space');
    drop('empty.key', '\n');
    for (const name of ['two.key', 'big.key', 'space.key', 'empty.key']) {
      const r = takeKeyFromDropFile(name, dir);
      expect(r.ok, name).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/line-one|kkkk|has space/);
      expect(fs.existsSync(path.join(dir, name))).toBe(true);
    }
    expect(takeKeyFromDropFile('missing.key', dir).ok).toBe(false);
  });
});

describe('models and health', () => {
  const answer = (status: number, body: string, type = 'application/json') =>
    (async () => new Response(body, { status, headers: { 'Content-Type': type } })) as unknown as typeof fetch;

  it('9: a good list is read; a bad answer keeps the last list and says why without the key', async () => {
    const r = added(base(), OWNER);
    const keyed = setEndpointKey(r.settings, r.endpoint.id, 'sk-zzz');
    if (!keyed.ok) throw new Error(keyed.error);
    let seenAuth = '';
    const good = (async (_u: string, init?: RequestInit) => { seenAuth = String((init?.headers as Record<string, string>).Authorization); return new Response(JSON.stringify({ object: 'list', data: [{ id: 'GLM' }, { id: 'Qwen' }] }), { status: 200 }); }) as unknown as typeof fetch;
    const one = await readModels(keyed.settings, r.endpoint.id, good, NOW);
    if (!one.ok) throw new Error(one.error);
    expect(one.models).toEqual(['GLM', 'Qwen']);
    expect(seenAuth).toBe('Bearer sk-zzz');
    const withList = applyEndpointPatch(keyed.settings, r.endpoint.id, one.patch);
    for (const bad of [answer(200, '<html>login</html>', 'text/html'), answer(401, '{"error":"bad key sk-zzz"}'), answer(200, '{"data":"nope"}')]) {
      const two = await readModels(withList, r.endpoint.id, bad, NOW);
      expect(two.ok).toBe(false);
      const after = applyEndpointPatch(withList, r.endpoint.id, two.patch);
      expect(after.inferenceEndpoints![0].models).toEqual(['GLM', 'Qwen']);
      expect(JSON.stringify(after.inferenceEndpoints)).not.toContain('sk-zzz');
    }
  });

  it('10: the health probe says its status, latency and time, never the key', async () => {
    const r = added(base(), OWNER);
    const keyed = setEndpointKey(r.settings, r.endpoint.id, 'sk-zzz');
    if (!keyed.ok) throw new Error(keyed.error);
    let t = 1000;
    const h = await checkHealth(keyed.settings, r.endpoint.id, answer(503, '{"error":{"type":"endpoint_busy","message":"sk-zzz"}}'), NOW, () => (t += 42));
    expect(h.health).toMatchObject({ ok: false, status: 503, latencyMs: 42, at: NOW });
    expect(JSON.stringify(h.health)).not.toContain('sk-zzz');
    expect(JSON.stringify(applyEndpointPatch(keyed.settings, r.endpoint.id, h.patch).inferenceEndpoints)).not.toContain('sk-zzz');
  });
});

describe('the install header (trace feature A4)', () => {
  const ID = '3b9f6a52-1c0e-4d8a-9f1e-7a2b4c6d8e01';
  const save = (settings: AppSettings, id: string, over: Record<string, unknown>, actor: EndpointActor = OWNER) =>
    saveEndpoint(settings, { id, ...over, ...(actor === OWNER ? { shown: seenOf(settings, id) } : {}) }, actor, NOW);

  it('28: off by default, only with the session headers, and off again with them', () => {
    const r = added(base(), OWNER);
    expect(r.endpoint.sendInstallHeader ?? false).toBe(false);
    const alone = save(r.settings, r.endpoint.id, { sendInstallHeader: true });
    expect(alone.ok).toBe(false);
    if (alone.ok) return;
    expect(alone.error).toMatch(/session headers/i);
    const both = save(r.settings, r.endpoint.id, { sendSessionHeaders: true, sendInstallHeader: true });
    if (!both.ok) throw new Error(both.error);
    expect(both.endpoint).toMatchObject({ sendSessionHeaders: true, sendInstallHeader: true });
    const sessionOff = save(both.settings, r.endpoint.id, { sendSessionHeaders: false });
    if (!sessionOff.ok) throw new Error(sessionOff.error);
    expect(sessionOff.endpoint).toMatchObject({ sendSessionHeaders: false, sendInstallHeader: false });
  });

  it('29: an agent does not turn it on', () => {
    const r = added(base(), OWNER, { sendSessionHeaders: true });
    const byAgent = save(r.settings, r.endpoint.id, { sendInstallHeader: true }, AGENT);
    expect(byAgent.ok).toBe(false);
  });

  it('30: the target carries the id only with both switches on and an id given', () => {
    const r = added(base(), OWNER, { sendSessionHeaders: true });
    const on = save(r.settings, r.endpoint.id, { sendInstallHeader: true });
    if (!on.ok) throw new Error(on.error);
    expect(endpointTarget(on.settings, r.endpoint.id, ID)).toMatchObject({ installId: ID });
    expect((endpointTarget(on.settings, r.endpoint.id, null) as { installId?: string }).installId).toBeUndefined();
    expect((endpointTarget(on.settings, r.endpoint.id) as { installId?: string }).installId).toBeUndefined();
    expect((endpointTarget(r.settings, r.endpoint.id, ID) as { installId?: string }).installId, 'switch off').toBeUndefined();
    const sessionOff = save(on.settings, r.endpoint.id, { sendSessionHeaders: false });
    if (!sessionOff.ok) throw new Error(sessionOff.error);
    expect((endpointTarget(sessionOff.settings, r.endpoint.id, ID) as { installId?: string }).installId, 'session headers off').toBeUndefined();
  });

  it('31: the view says whether it is on', () => {
    const r = added(base(), OWNER, { sendSessionHeaders: true });
    expect(endpointViews(r.settings, [])[0]).toMatchObject({ sendInstallHeader: false });
    const on = save(r.settings, r.endpoint.id, { sendInstallHeader: true });
    if (!on.ok) throw new Error(on.error);
    expect(endpointViews(on.settings, [])[0]).toMatchObject({ sendInstallHeader: true });
  });
});
