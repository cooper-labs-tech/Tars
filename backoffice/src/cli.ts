// The operator's commands:
//   node src/cli.ts migrate up | down [--all] | status
//   node src/cli.ts hash-password            (reads the password on stdin, prints its scrypt hash)
//   node src/cli.ts reader create <name>     (prints the token once)
//   node src/cli.ts reader list | revoke <id>
//   node src/cli.ts retention run
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { connect, migrateUp, migrateDown, pending, migrations } from './db.ts';
import { hashPassword } from './password.ts';
import { mintToken } from './tokens.ts';
import { loadConfig } from './config.ts';
import { BlobStore } from './blobstore.ts';
import { makeCtx } from './http.ts';
import { sweep } from './purge.ts';

const [cmd, sub, ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
  if (cmd === 'hash-password') {
    const pw = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    if (pw.length < 12) throw new Error('use a password of 12 characters or more');
    console.log(await hashPassword(pw));
    return;
  }
  const db = connect();
  try {
    if (cmd === 'migrate' && sub === 'up') {
      for (const m of await migrateUp(db)) console.log(`applied ${m}`);
    } else if (cmd === 'migrate' && sub === 'down') {
      for (const m of await migrateDown(db, rest.includes('--all'))) console.log(`reverted ${m}`);
    } else if (cmd === 'migrate' && sub === 'status') {
      const left = await pending(db);
      console.log(`${migrations().length - left.length} applied, ${left.length} pending${left.length ? `: ${left.join(', ')}` : ''}`);
    } else if (cmd === 'reader' && sub === 'create' && rest[0]) {
      const { token, hash } = mintToken('reader');
      const id = randomUUID();
      await db.query('INSERT INTO readers (id, name, token_hash) VALUES ($1, $2, $3)', [id, rest.join(' ').slice(0, 80), hash]);
      console.log(`reader ${id}\ntoken ${token}\n(shown once: only its hash is kept)`);
    } else if (cmd === 'reader' && sub === 'list') {
      for (const r of (await db.query('SELECT id, name, created_at, last_used_at, revoked_at FROM readers ORDER BY created_at')).rows) {
        console.log(`${r.id}  ${r.revoked_at ? 'revoked' : 'active '}  ${r.name}  last used ${r.last_used_at?.toISOString() ?? 'never'}`);
      }
    } else if (cmd === 'reader' && sub === 'revoke' && rest[0]) {
      const r = await db.query('UPDATE readers SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [rest[0]]);
      console.log(r.rowCount ? 'revoked' : 'no active reader with that id');
    } else if (cmd === 'retention' && sub === 'run') {
      const cfg = loadConfig();
      console.log(JSON.stringify(await sweep(makeCtx(db, cfg, new BlobStore(cfg.dataDir)))));
    } else {
      throw new Error('usage: migrate up|down [--all]|status, hash-password, reader create <name>|list|revoke <id>, retention run');
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
