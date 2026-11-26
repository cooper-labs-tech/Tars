// Request bodies: read under a wire limit, then decoded under a decoded limit. zlib's
// maxOutputLength stops a decompression bomb at the limit instead of expanding it in full.
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import type { IncomingMessage } from 'node:http';

export class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message?: string, extra: Record<string, unknown> = {}) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export interface BodyLimits { wire: number; decoded: number }

export function decodeBody(raw: Buffer, encoding: string | undefined, limits: BodyLimits): Buffer {
  if (raw.length > limits.wire) throw new HttpError(413, 'too_large', `body over ${limits.wire} bytes`);
  const enc = (encoding ?? 'identity').trim().toLowerCase();
  if (enc === '' || enc === 'identity') {
    if (raw.length > limits.decoded) throw new HttpError(413, 'too_large');
    return raw;
  }
  if (enc !== 'gzip' && enc !== 'zstd') throw new HttpError(400, 'bad_encoding', 'Content-Encoding must be identity, gzip or zstd');
  try {
    // One byte over the limit tells "exactly at the limit" from "cut at the limit".
    const opts = { maxOutputLength: limits.decoded + 1 };
    const out = enc === 'gzip' ? gunzipSync(raw, opts) : zstdDecompressSync(raw, opts);
    if (out.length > limits.decoded) throw new HttpError(413, 'too_large', `decoded body over ${limits.decoded} bytes`);
    return out;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || /exceeds|too large|maxOutputLength/i.test(String(e))) {
      throw new HttpError(413, 'too_large', `decoded body over ${limits.decoded} bytes`);
    }
    throw new HttpError(400, 'bad_encoding', `the body is not valid ${enc}`);
  }
}

/** Reads a request body, refusing it as soon as it passes the wire limit. */
export function readRaw(req: IncomingMessage, wireLimit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > wireLimit) {
      req.resume();
      return fail(new HttpError(413, 'too_large', `body over ${wireLimit} bytes`));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > wireLimit) {
        req.removeAllListeners('data');
        req.resume();
        fail(new HttpError(413, 'too_large', `body over ${wireLimit} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}
