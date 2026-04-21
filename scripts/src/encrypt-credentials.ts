// One-shot migration: walk every row in routers + credential_profiles
// and re-save any plaintext (sshPassword / enablePassword) value as
// encrypted. Idempotent — rows already bearing the `enc:v1:` prefix
// are left alone. Safe to run on every container start.
//
// We do this in code rather than SQL because the encryption itself
// happens in Node (AES-256-GCM via the shared lib/db/crypto module).

import {
  db,
  routersTable,
  credentialProfilesTable,
  encryptSecret,
  isEncrypted,
} from "@workspace/db";
import { eq } from "drizzle-orm";

async function migrateRouters(): Promise<{ scanned: number; encrypted: number }> {
  const rows = await db.select().from(routersTable);
  let encrypted = 0;
  for (const r of rows) {
    const updates: Record<string, string | null> = {};
    if (r.sshPassword && !isEncrypted(r.sshPassword)) {
      updates.sshPassword = encryptSecret(r.sshPassword);
    }
    if (r.enablePassword && !isEncrypted(r.enablePassword)) {
      updates.enablePassword = encryptSecret(r.enablePassword);
    }
    if (Object.keys(updates).length > 0) {
      await db.update(routersTable).set(updates).where(eq(routersTable.id, r.id));
      encrypted++;
    }
  }
  return { scanned: rows.length, encrypted };
}

async function migrateProfiles(): Promise<{ scanned: number; encrypted: number }> {
  const rows = await db.select().from(credentialProfilesTable);
  let encrypted = 0;
  for (const p of rows) {
    const updates: Record<string, string | null> = {};
    if (p.sshPassword && !isEncrypted(p.sshPassword)) {
      updates.sshPassword = encryptSecret(p.sshPassword);
    }
    if (p.enablePassword && !isEncrypted(p.enablePassword)) {
      updates.enablePassword = encryptSecret(p.enablePassword);
    }
    if (Object.keys(updates).length > 0) {
      await db.update(credentialProfilesTable).set(updates).where(eq(credentialProfilesTable.id, p.id));
      encrypted++;
    }
  }
  return { scanned: rows.length, encrypted };
}

async function main() {
  const r = await migrateRouters();
  const p = await migrateProfiles();
  console.log(
    `Credential encryption migration: routers ${r.encrypted}/${r.scanned} updated, ` +
    `credential_profiles ${p.encrypted}/${p.scanned} updated.`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[encrypt-credentials] failed:", e.message);
  // Non-fatal: a missing key in dev or a partial failure shouldn't block
  // container start. The reads still work because decrypt is a pass-through
  // for legacy plaintext, and the next write of each row will encrypt.
  process.exit(0);
});
