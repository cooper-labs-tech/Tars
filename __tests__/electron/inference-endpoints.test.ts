import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  saveEndpoint, approveEndpoint, removeEndpoint, setEndpointKey, endpointViews, endpointTarget, validateEndpointChoice,
  takeKeyFromDropFile, readModels, checkHealth, type EndpointActor,
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
 * 11. holdMaxSeconds outside 0..3600 is saved.
 */

const NOW = '2026-11-19T12:00:00.000Z';
const OWNER: EndpointActor = { window: true };
const AGENT: EndpointActor = { agentId: 'agent-remote', agentName: 'Remote-Tuner' };
const base = (): AppSettings => ({ inferenceEndpoints: [] } as unknown as AppSettings);
const agent = (over: Partial<AgentStatus>): AgentStatus => ({ id: 'a1', name: 'Q', projectPath: '/p', provider: 'qwen-code', model: 'GLM', status: 'idle', skills: [], ...over } as unknown as AgentStatus);

function added(settings: AppSettings, actor: EndpointActor, over: Record<string, unknown> = {}) {
  const r = saveEndpoint(settings, { name: 'Remote host', baseUrl: 'http://192.0.2.10:9000/v1', allowTraces: false, ...over }, actor, NOW);
  if (!r.ok) throw new Error(r.error);
  return r;
}

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
    expect(saveEndpoint(base(), { name: 'x', baseUrl: 'http://h/v1', allowTraces: true }, AGENT, NOW).ok).toBe(false);
    const byAgent = added(base(), AGENT);
    expect(byAgent.endpoint).toMatchObject({ approved: false, allowTraces: false, changedBy: { agentId: 'agent-remote' } });
    expect('refused' in endpointTarget(byAgent.settings, byAgent.endpoint.id)).toBe(true);

    const approved = approveEndpoint(byAgent.settings, byAgent.endpoint.id);
    if (!approved.ok) throw new Error(approved.error);
    expect(approved.endpoint).toMatchObject({ approved: true, approvedBaseUrl: 'http://192.0.2.10:9000/v1' });

    const renamed = saveEndpoint(approved.settings, { id: byAgent.endpoint.id, name: 'Remote host 2', holdMaxSeconds: 120 }, AGENT, NOW);
    if (!renamed.ok) throw new Error(renamed.error);
    expect(renamed.endpoint.approved).toBe(true);
    const keyed = setEndpointKey(renamed.settings, byAgent.endpoint.id, 'k-rotated');
    if (!keyed.ok) throw new Error(keyed.error);
    expect(endpointViews(keyed.settings, [])[0].approved).toBe(true);
    // An agent cannot turn traces on, and may turn them off.
    const tracesOn = saveEndpoint(keyed.settings, { id: byAgent.endpoint.id, allowTraces: true }, AGENT, NOW);
    expect(tracesOn.ok).toBe(false);

    const moved = saveEndpoint(keyed.settings, { id: byAgent.endpoint.id, baseUrl: 'http://evil.example/v1' }, AGENT, NOW);
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.endpoint).toMatchObject({ approved: false, approvedBaseUrl: 'http://192.0.2.10:9000/v1', baseUrl: 'http://evil.example/v1' });
    expect('refused' in endpointTarget(moved.settings, byAgent.endpoint.id)).toBe(true);
  });

  it('3: what the owner saves in the window is approved by that act', () => {
    const r = added(base(), OWNER, { allowTraces: true });
    expect(r.endpoint).toMatchObject({ approved: true, approvedBaseUrl: 'http://192.0.2.10:9000/v1', allowTraces: true });
    const target = endpointTarget(r.settings, r.endpoint.id);
    expect(target).toMatchObject({ baseUrl: 'http://192.0.2.10:9000/v1', holdMaxSeconds: 600 });
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
    expect(saveEndpoint(base(), { name: 'x', baseUrl: 'http://h/v1', allowTraces: false, holdMaxSeconds: 4000 }, OWNER, NOW).ok).toBe(false);
    expect(saveEndpoint(base(), { name: 'x', baseUrl: 'http://h/v1', allowTraces: false, holdMaxSeconds: -1 }, OWNER, NOW).ok).toBe(false);
    expect(added(base(), OWNER, { holdMaxSeconds: 0 }).endpoint.holdMaxSeconds).toBe(0);
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
    for (const bad of [answer(200, '<html>login</html>', 'text/html'), answer(401, '{"error":"bad key sk-zzz"}'), answer(200, '{"data":"nope"}')]) {
      const two = await readModels(one.settings, r.endpoint.id, bad, NOW);
      expect(two.ok).toBe(false);
      const after = two.ok ? two.settings : two.settings!;
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
    expect(JSON.stringify(h.settings.inferenceEndpoints)).not.toContain('sk-zzz');
  });
});
