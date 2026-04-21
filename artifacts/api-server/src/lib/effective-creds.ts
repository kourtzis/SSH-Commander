// ─── Effective SSH credential resolution ───────────────────────────
// Centralised resolver that turns a router row into the actual
// (username, password, enablePassword, jumpHost?) tuple that should be
// used to open an SSH session — taking credential profiles and
// bastion / jump-host references into account.
//
// Resolution rules (matches the credential-profile feature spec):
//   • If the router has no credentialProfileId set, the inline columns
//     on the router (sshUsername / sshPassword / enablePassword) are
//     used as-is and there is no jump host.
//   • If a profile is attached, the profile's username / password /
//     enable password take precedence; any field the profile leaves
//     NULL falls back to the router's inline column. (This lets you
//     attach a profile to dozens of devices that share creds while
//     still overriding one off device with an inline value.)
//   • The jump host comes from `profile.jumpHostId`, which references
//     ANOTHER credential_profiles row whose `jumpHost` / `jumpPort` /
//     `sshUsername` / `sshPassword` describe the bastion. If the
//     referenced profile has no `jumpHost` field set, jump-host
//     routing is silently skipped (the schema allows the FK without
//     forcing a host string, and we don't want a misconfigured
//     bastion row to make every SSH attempt fail mysteriously).

import { db, routersTable, credentialProfilesTable, decryptSecret } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { JumpHostConfig } from "./ssh.js";

// Helpers: decrypt-on-read. Sensitive columns (sshPassword,
// enablePassword) are encrypted at rest with AES-256-GCM in 1.14.0+.
// decryptSecret() is a pass-through for legacy plaintext rows so
// upgrades from 1.13 keep working until the migration script (or the
// next write) re-encrypts each row.
function dec(v: string | null | undefined): string | null {
  try { return decryptSecret(v); }
  catch (e) {
    console.warn("[effective-creds] decrypt failed (returning null):", (e as Error).message);
    return null;
  }
}

export interface EffectiveCreds {
  username: string;
  password: string;
  enablePassword?: string;
  jumpHost?: JumpHostConfig;
  /** Per-profile opt-in for the legacy SSH algorithm set. False (modern
   *  defaults) when the router has no profile attached or the profile
   *  has the flag unset. Surfaces directly from credential_profiles. */
  useLegacyAlgorithms?: boolean;
}

type RouterRow = typeof routersTable.$inferSelect;

export async function resolveEffectiveCreds(router: RouterRow): Promise<EffectiveCreds> {
  // No profile attached → use inline values verbatim.
  if (!router.credentialProfileId) {
    return {
      username: router.sshUsername,
      password: dec(router.sshPassword) ?? "",
      enablePassword: dec(router.enablePassword) ?? undefined,
    };
  }

  const [profile] = await db
    .select()
    .from(credentialProfilesTable)
    .where(eq(credentialProfilesTable.id, router.credentialProfileId))
    .limit(1);

  // Profile FK was set but the profile has been deleted — fall back to
  // inline so we degrade gracefully instead of failing with auth errors.
  if (!profile) {
    return {
      username: router.sshUsername,
      password: dec(router.sshPassword) ?? "",
      enablePassword: dec(router.enablePassword) ?? undefined,
    };
  }

  const username = profile.sshUsername || router.sshUsername;
  const password = dec(profile.sshPassword) ?? dec(router.sshPassword) ?? "";
  const enablePassword = dec(profile.enablePassword) ?? dec(router.enablePassword) ?? undefined;

  const useLegacyAlgorithms = profile.useLegacyAlgorithms === true;

  let jumpHost: JumpHostConfig | undefined;
  if (profile.jumpHostId) {
    const [bastion] = await db
      .select()
      .from(credentialProfilesTable)
      .where(eq(credentialProfilesTable.id, profile.jumpHostId))
      .limit(1);
    if (bastion && bastion.jumpHost) {
      jumpHost = {
        host: bastion.jumpHost,
        port: bastion.jumpPort ?? 22,
        username: bastion.sshUsername,
        password: dec(bastion.sshPassword) ?? "",
      };
    }
  }

  return { username, password, enablePassword, jumpHost, useLegacyAlgorithms };
}
