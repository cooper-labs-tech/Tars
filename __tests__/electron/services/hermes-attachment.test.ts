import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { uploadHermesAttachment } from '../../../electron/services/hermes-client';
import type { HermesConnection } from '../../../electron/types/hermes';

/**
 * The upload path, against a real server rather than a mocked request.
 *
 * What matters here is the chain, and every link in it is a decision the
 * gateway actually enforces: an image has to reach /api/chat/image-upload,
 * because /api/files/upload would store it somewhere the chat cannot show it;
 * anything else has to reach /api/files/upload with an absolute path, because
 * the image endpoint answers "Upload payload must be an image" and a relative
 * path answers "Path must be absolute". Both of those 400s were observed
 * against JeanBrasse's gateway, and a mocked `hermesRequest` would assert none of it.
 */

interface Received {
  pathname: string;
  body: Record<string, unknown>;
}

let server: http.Server;
let baseUrl = '';
let received: Received[] = [];
/** What the fake gateway answers next. */
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw); } catch { /* leave empty */ }
      received.push({ pathname: req.url ?? '', body });
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function conn(): HermesConnection {
  return { mode: 'remote', url: baseUrl };
}

function reset(): void {
  received = [];
  reply = { status: 200, body: {} };
}

describe('uploadHermesAttachment', () => {
  it('sends an image to the image endpoint as a data URL', async () => {
    reset();
    reply = { status: 200, body: { ok: true, path: '/root/.hermes/images/x_shot.png', bytes: 70 } };

    const result = await uploadHermesAttachment(conn(), {
      name: 'shot.png', mimeType: 'image/png', base64: 'aGk=', bytes: 3,
    });

    expect(result.success).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].pathname).toBe('/api/chat/image-upload');
    expect(received[0].body.data_url).toBe('data:image/png;base64,aGk=');
    expect(received[0].body.filename).toBe('shot.png');
    if (result.success) {
      expect(result.attachment.path).toBe('/root/.hermes/images/x_shot.png');
      expect(result.attachment.isImage).toBe(true);
    }
  });

  it('sends anything else to the file endpoint at an absolute path', async () => {
    reset();
    reply = { status: 200, body: { ok: true, path: '/root/.hermes/uploads/brief.pdf' } };

    const result = await uploadHermesAttachment(conn(), {
      name: 'brief.pdf', mimeType: 'application/pdf', base64: 'aGk=', bytes: 3,
    });

    expect(result.success).toBe(true);
    expect(received[0].pathname).toBe('/api/files/upload');
    // `~`-rooted counts as absolute to the gateway; a bare relative path does not.
    expect(received[0].body.path).toBe('~/.hermes/uploads/brief.pdf');
    expect(received[0].body.overwrite).toBe(true);
    if (result.success) expect(result.attachment.isImage).toBe(false);
  });

  it('cannot be made to write outside the upload directory', async () => {
    reset();
    reply = { status: 200, body: { ok: true, path: '/root/.hermes/uploads/passwd' } };

    await uploadHermesAttachment(conn(), {
      name: '../../../etc/passwd', mimeType: 'text/plain', base64: 'aGk=', bytes: 3,
    });

    expect(received[0].body.path).toBe('~/.hermes/uploads/passwd');
  });

  it('keeps the name intact', async () => {
    reset();
    reply = { status: 200, body: { ok: true, path: '/root/.hermes/uploads/x' } };

    await uploadHermesAttachment(conn(), {
      name: 'Q3 Report v2.final.pdf', mimeType: 'application/pdf', base64: 'aGk=', bytes: 3,
    });

    // Written out because an over-eager sanitiser is easy to get wrong and
    // silent when it is: an earlier one stripped digits, capitals and every
    // letter in "f", turning brief.pdf into brie.pd.
    expect(received[0].body.path).toBe('~/.hermes/uploads/Q3 Report v2.final.pdf');
  });

  it('reports the gateway\'s own refusal rather than a generic failure', async () => {
    reset();
    reply = { status: 400, body: { detail: 'Upload payload must be an image' } };

    const result = await uploadHermesAttachment(conn(), {
      name: 'notes.txt', mimeType: 'text/plain', base64: 'aGk=', bytes: 3,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('Upload payload must be an image');
  });

  it('treats a 401 as needing a sign-in', async () => {
    reset();
    reply = { status: 401, body: { detail: 'Unauthorized' } };

    const result = await uploadHermesAttachment(conn(), {
      name: 'notes.txt', mimeType: 'text/plain', base64: 'aGk=', bytes: 3,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.needsSignIn).toBe(true);
  });

  it('refuses a 200 that carries no path, rather than staging a file that is nowhere', async () => {
    reset();
    reply = { status: 200, body: { ok: true } };

    const result = await uploadHermesAttachment(conn(), {
      name: 'notes.txt', mimeType: 'text/plain', base64: 'aGk=', bytes: 3,
    });

    expect(result.success).toBe(false);
  });
});
