import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The window's vault, Code panel and vault attachment channels follow the window's file rules
 * (utils/window-file-access.ts, 2.0.7), driven from the page through window.electronAPI. Stand-in files only, in the
 * sandbox home.
 *
 * 1. obsidian.addVault takes neither the home nor a dot folder of it, and obsidian.readFile and obsidian.writeFile
 *    reach nothing through a vault that is not one.
 * 2. A vault stored in ~/.tars/app-settings.json that the rule refuses is not used: obsidian.scan lists it as refused,
 *    with a reason.
 * 3. project.searchContent takes no folder that is no project Tars knows.
 * 4. A real vault is added, a note read and written; a project added by hand is searched.
 * 5. vault.attachFile copies only a file the dialog returned.
 * 6. A file the dialog returned is good for one attach (the main process's dialog answers with a stand-in picture).
 * 7. A project Tars holds under a dot folder of the home is listed by fs.listProjects with the reason it is refused,
 *    and project.searchContent answers with that reason; fs.addCustomProject refuses a new one with it.
 * 8. fs.readProjectFiles reads nothing of a folder of credentials a skill link in ~/.claude/skills leads to, by the
 *    folder's name or the link's, and still reads a real skill.
 * Red on train/2.0.7 b5f207bcf (1 to 7), on bb66b3255 (6 and 7) and on f0e547bd6 (8).
 * The artefact: values.json (every answer, the files' state), with E2E_TRACE=on the app's trace.
 */

const KEY = 'FAKE-PRIVATE-KEY-of-the-e2e';
const TOKEN = 'FAKE-ACCESS-TOKEN-of-the-e2e';

type Api = { electronAPI: {
  obsidian: {
    scan(): Promise<{ vaults: Array<{ vaultPath: string }>; refused?: Array<{ vaultPath: string; reason: string }> }>;
    readFile(filePath: string, vaultPath: string): Promise<{ file?: { content: string }; error?: string }>;
    writeFile(filePath: string, content: string, vaultPath: string): Promise<{ success?: boolean; error?: string }>;
    addVault(vaultPath: string): Promise<{ success: boolean; error?: string }>;
  };
  project: { searchContent(root: string, query: string): Promise<{ success: boolean; hits?: Array<{ path: string; text: string }>; error?: string }> };
  vault: {
    createDocument(p: { title: string; content: string; author: string }): Promise<{ success: boolean; document?: { id: string } }>;
    attachFile(p: { document_id: string; file_path: string }): Promise<{ success: boolean; error?: string }>;
  };
  fs: {
    readProjectFiles(p: { paths: string[]; relative: string[] }): Promise<{ files: Record<string, string> }>;
    listProjects(): Promise<Array<{ path: string; refused?: string }>>;
    addCustomProject(p: string): Promise<{ success: boolean; error?: string }>;
  };
  dialog: { openFiles(): Promise<string[]> };
} };

test("the window's vault and Code panel channels open nothing outside a vault or a project", async () => {
  test.setTimeout(120_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-window-vault-'));
  const dir = path.join(home, '.tars');
  const vault = path.join(home, 'Documents', 'Notes');
  const project = path.join(home, 'projects', 'demo');
  // A project Tars holds under a folder the project rule refuses, and one a user would add there.
  const held = path.join(home, '.cargo', 'mine');
  const azure = path.join(home, '.azure', 'work');
  const picture = path.join(home, 'Pictures', 'diagram.png');
  for (const d of [dir, vault, project, path.join(home, '.ssh'), path.join(home, '.gemini'), held, azure, path.dirname(picture)]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(held, 'lib.ts'), 'export const needle = 2;\n');
  fs.writeFileSync(picture, 'a picture');
  // A skill link an agent made to a stand-in folder of credentials, beside a real skill.
  const kube = path.join(home, '.kube');
  const skills = path.join(home, '.claude', 'skills');
  for (const d of [kube, path.join(skills, 'mine')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(kube, 'config'), `token: ${TOKEN}`);
  fs.writeFileSync(path.join(skills, 'mine', 'SKILL.md'), '# a skill');
  fs.symlinkSync(kube, path.join(skills, 'kc'), 'junction');
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), KEY);
  fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({ access_token: TOKEN, refresh_token: TOKEN }));
  fs.writeFileSync(path.join(vault, 'note.md'), '# a note');
  fs.writeFileSync(path.join(project, 'index.ts'), 'export const needle = 1;\n');
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project, held]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  // A vault an agent stored: ~/.tars is every agent's folder.
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', obsidianVaultPaths: [path.join(home, '.gemini')],
  }));
  const values: Record<string, unknown> = { home };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31527), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const api = <T>(fn: (a: Api['electronAPI'], arg: unknown) => Promise<T>, arg?: unknown) =>
      page.evaluate(([src, a]) => (new Function('a', 'arg', `return (${src})(a, arg)`))((window as unknown as Api).electronAPI, a), [fn.toString(), arg] as const) as Promise<T>;
    const real = (p: string) => fs.realpathSync(p);

    // 1. The home as a vault: refused, and nothing read or written through it.
    const addHome = await api((a, p) => a.obsidian.addVault(p as string), home);
    const addGemini = await api((a, p) => a.obsidian.addVault(p as string), path.join(home, '.gemini'));
    const readKey = await api((a, arg) => { const [f, v] = arg as [string, string]; return a.obsidian.readFile(f, v); }, [path.join(home, '.ssh', 'id_ed25519'), home]);
    const readToken = await api((a, arg) => { const [f, v] = arg as [string, string]; return a.obsidian.readFile(f, v); }, [path.join(home, '.gemini', 'oauth_creds.json'), home]);
    const writeDot = await api((a, arg) => { const [f, v] = arg as [string, string]; return a.obsidian.writeFile(f, 'echo planted', v); }, [path.join(home, '.zshrc'), home]);
    keep({ addHome, addGemini, readKey, readToken, writeDot, zshrcWritten: fs.existsSync(path.join(home, '.zshrc')) });
    expect.soft(addHome).toMatchObject({ success: false });
    expect.soft(addGemini).toMatchObject({ success: false });
    expect.soft(readKey.file).toBeUndefined();
    expect.soft(readToken.file).toBeUndefined();
    expect.soft(writeDot.success).not.toBe(true);
    expect.soft(fs.existsSync(path.join(home, '.zshrc'))).toBe(false);

    // 2. The vault an agent stored: not used, and said.
    const scan = await api((a) => a.obsidian.scan());
    const readStored = await api((a, arg) => { const [f, v] = arg as [string, string]; return a.obsidian.readFile(f, v); }, [path.join(home, '.gemini', 'oauth_creds.json'), path.join(home, '.gemini')]);
    keep({ scan, readStored });
    expect.soft(scan.vaults.map((v) => v.vaultPath)).toEqual([]);
    expect.soft(scan.refused?.map((r) => r.vaultPath)).toEqual([path.join(home, '.gemini')]);
    expect.soft(readStored.file).toBeUndefined();

    // 3. The Code panel's search on ~/.gemini.
    const search = await api((a, root) => a.project.searchContent(root as string, 'token'), path.join(home, '.gemini'));
    keep({ search });
    expect.soft(search.hits ?? []).toEqual([]);
    expect.soft(JSON.stringify(search)).not.toContain(TOKEN);

    // 4. Nothing real breaks.
    const addNotes = await api((a, p) => a.obsidian.addVault(p as string), vault);
    const readNote = await api((a, arg) => { const [f, v] = arg as [string, string]; return a.obsidian.readFile(f, v); }, [path.join(vault, 'note.md'), vault]);
    const writeNote = await api((a, arg) => { const [f, v] = arg as [string, string]; return a.obsidian.writeFile(f, '# edited', v); }, [path.join(vault, 'note.md'), vault]);
    const searchProject = await api((a, root) => a.project.searchContent(root as string, 'needle'), project);
    // 5. An attachment no dialog returned.
    const doc = await api((a) => a.vault.createDocument({ title: 'e2e', content: 'a document', author: 'e2e' }));
    const attachKey = await api((a, arg) => { const [id, f] = arg as [string, string]; return a.vault.attachFile({ document_id: id, file_path: f }); }, [doc.document?.id ?? '', path.join(home, '.ssh', 'id_ed25519')]);
    const attachments = path.join(dir, 'vault', 'attachments');
    const copied = fs.existsSync(attachments) ? fs.readdirSync(attachments).map((n) => fs.readFileSync(path.join(attachments, n), 'utf8')).join('\n') : '';
    keep({ doc: { success: doc.success }, attachKey, keyCopied: copied.includes(KEY) });
    expect.soft(doc.success).toBe(true);
    expect.soft(attachKey).toMatchObject({ success: false });
    expect.soft(copied).not.toContain(KEY);

    // 6. A pick is good for one attach: the main process's dialog answers with the stand-in picture.
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
    }, picture);
    const pickedPaths = await api((a) => a.dialog.openFiles());
    const attachOnce = await api((a, arg) => { const [id, f] = arg as [string, string]; return a.vault.attachFile({ document_id: id, file_path: f }); }, [doc.document?.id ?? '', picture]);
    const attachTwice = await api((a, arg) => { const [id, f] = arg as [string, string]; return a.vault.attachFile({ document_id: id, file_path: f }); }, [doc.document?.id ?? '', picture]);
    keep({ pickedPaths, attachOnce, attachTwice });
    expect.soft(pickedPaths).toEqual([picture]);
    expect.soft(attachOnce).toMatchObject({ success: true });
    expect.soft(attachTwice).toMatchObject({ success: false });

    // 7. A project held under a dot folder of the home: listed with why, not searched; a new one refused with why.
    const listed = await api((a) => a.fs.listProjects());
    const searchHeld = await api((a, root) => a.project.searchContent(root as string, 'needle'), held);
    const addAzure = await api((a, p) => a.fs.addCustomProject(p as string), azure);
    keep({ heldListed: listed.find((p) => p.path === held), searchHeld, addAzure });
    expect.soft(listed.find((p) => p.path === held)?.refused).toMatch(/dot/i);
    expect.soft(listed.find((p) => p.path === project)?.refused).toBeUndefined();
    expect.soft(searchHeld).toMatchObject({ success: false });
    expect.soft(searchHeld.error).toMatch(/dot/i);
    expect.soft(addAzure).toMatchObject({ success: false });
    expect.soft(addAzure.error).toMatch(/dot/i);

    // 8. The Brain's channel: nothing of a folder of credentials a skill link names, a real skill still read.
    const brainKube = await api((a, arg) => a.fs.readProjectFiles({ paths: arg as string[], relative: ['config'] }), [kube, path.join(skills, 'kc')]);
    const brainSkill = await api((a, p) => a.fs.readProjectFiles({ paths: [p as string], relative: ['SKILL.md'] }), path.join(skills, 'mine'));
    keep({ brainKube, brainSkill: Object.values(brainSkill.files) });
    expect.soft(brainKube.files).toEqual({});
    expect.soft(Object.values(brainSkill.files)).toEqual(['# a skill']);

    keep({ addNotes, readNote, writeNote, searchProject, errors });
    expect.soft(addNotes).toMatchObject({ success: true });
    expect.soft(readNote.file?.content).toBe('# a note');
    expect.soft(writeNote).toMatchObject({ success: true });
    expect.soft(fs.readFileSync(real(path.join(vault, 'note.md')), 'utf8')).toBe('# edited');
    expect.soft(searchProject.hits?.map((h) => h.path)).toEqual(['index.ts']);
    expect.soft(JSON.stringify(values)).not.toMatch(new RegExp(`${KEY}|${TOKEN}`));
    expect.soft(errors).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    await removeHome(home);
  }
});
