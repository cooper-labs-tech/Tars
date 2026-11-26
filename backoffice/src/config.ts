// Configuration comes from the environment only (on a server: a root-owned env file read by the
// service manager). Secrets are never in the repository.
export interface Config {
  host: string;
  port: number;
  dataDir: string;                 // the blob store
  ownerPasswordHash?: string;      // scrypt hash; unset = the back-office pages are closed
  publicOrigin?: string;           // https://traces.example.com; the admin forms' Origin must match
  trustProxy: boolean;             // take the client address from X-Real-IP (set by the local proxy)
  access?: { issuer: string; audience: string }; // an access proxy's identity assertion, required on /admin when set
  retentionSweepMs: number;        // 0 = only on demand
}

export function loadConfig(env = process.env): Config {
  const listen = env.BACKOFFICE_LISTEN ?? '127.0.0.1:8787';
  const m = /^([0-9.]+|\[[0-9a-f:]+\]|localhost):(\d{1,5})$/.exec(listen);
  if (!m) throw new Error(`BACKOFFICE_LISTEN must be host:port, got ${listen}`);
  if (!env.BACKOFFICE_DATA_DIR) throw new Error('BACKOFFICE_DATA_DIR is required: where blobs are stored');
  const team = env.BACKOFFICE_ACCESS_ISSUER;
  const aud = env.BACKOFFICE_ACCESS_AUDIENCE;
  if (!!team !== !!aud) throw new Error('set both BACKOFFICE_ACCESS_ISSUER and BACKOFFICE_ACCESS_AUDIENCE, or neither');
  return {
    host: m[1]!.replace(/^\[|\]$/g, ''),
    port: Number(m[2]),
    dataDir: env.BACKOFFICE_DATA_DIR,
    ownerPasswordHash: env.BACKOFFICE_OWNER_PASSWORD_HASH || undefined,
    publicOrigin: env.BACKOFFICE_PUBLIC_ORIGIN?.replace(/\/$/, '') || undefined,
    trustProxy: env.BACKOFFICE_TRUST_PROXY === '1',
    access: team && aud ? { issuer: team.replace(/\/$/, ''), audience: aud } : undefined,
    retentionSweepMs: env.BACKOFFICE_RETENTION_SWEEP_MS !== undefined ? Number(env.BACKOFFICE_RETENTION_SWEEP_MS) : 3_600_000,
  };
}

export const LIMITS = {
  batchWire: 8 * 1024 * 1024,
  batchDecoded: 64 * 1024 * 1024,
  blobWire: 16 * 1024 * 1024,
  blobDecoded: 64 * 1024 * 1024,
  jsonWire: 1024 * 1024,           // small JSON bodies: registration, missing-blob queries
  missingHashes: 1000,
  readPage: 500,
};
