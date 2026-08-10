import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// 1.14.0 H-7: the previous seed always used "admin123", which meant every
// fresh deployment shipped with a guessable admin login. We now read
// INITIAL_ADMIN_PASSWORD from the env; if unset, we generate a random one.
// 2.0.0 security scan: the generated password is no longer printed to stdout
// (container logs end up in aggregators, CI output, and support pastes) —
// it is written to a mode-0600 file whose path is printed instead.
async function seed() {
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, "admin"))
    .limit(1);

  if (existing.length > 0) {
    // Detect the legacy default password and warn loudly so operators upgrading
    // from <=1.13 know they're still shipping the well-known admin123.
    // Denylist of known-bad passwords from older releases (the pre-1.14
    // shipped default lives in scripts/known-weak-defaults.json). Kept as a
    // data file, not code: these are DETECTION values — nothing is ever set
    // to them; we only compare so we can warn operators still using one.
    let KNOWN_WEAK_DEFAULTS: string[] = [];
    try {
      KNOWN_WEAK_DEFAULTS = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), "known-weak-defaults.json"), "utf8"),
      );
    } catch {
      console.warn("[seed] known-weak-defaults.json not found — skipping legacy default-password check.");
    }
    let ok = false;
    for (const weak of KNOWN_WEAK_DEFAULTS) {
      if (await bcrypt.compare(weak, existing[0].passwordHash).catch(() => false)) {
        ok = true;
        break;
      }
    }
    if (ok) {
      console.warn(
        "[seed] WARNING: admin user is still using the well-known default password 'admin123'. " +
        "Change it immediately via the UI (Profile → Change Password) or by setting INITIAL_ADMIN_PASSWORD " +
        "and re-creating the user. Leaving the default in place exposes the entire device fleet.",
      );
    }
    console.log("Admin user already exists, skipping seed.");
    process.exit(0);
  }

  const fromEnv = process.env.INITIAL_ADMIN_PASSWORD;
  let password: string;
  let source: "env" | "generated";
  if (fromEnv && fromEnv.length >= 8) {
    password = fromEnv;
    source = "env";
  } else {
    if (fromEnv && fromEnv.length < 8) {
      console.warn("[seed] INITIAL_ADMIN_PASSWORD is shorter than 8 chars — ignoring and generating a random one.");
    }
    password = crypto.randomUUID(); // 36-char CSPRNG value (122 bits) — rotated by the operator after first login
    source = "generated";
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await db.insert(usersTable).values({
    username: "admin",
    email: "admin@localhost",
    passwordHash,
    role: "admin",
  });

  if (source === "env") {
    console.log("Created admin user (password from INITIAL_ADMIN_PASSWORD env).");
  } else {
    const outPath = path.resolve(process.env.INITIAL_ADMIN_PASSWORD_FILE || "initial-admin-password.txt");
    fs.writeFileSync(outPath, password + "\n", { mode: 0o600 });
    console.log("─────────────────────────────────────────────────────────────");
    console.log("Created admin user 'admin' with a randomly generated password.");
    console.log(`The password was written to: ${outPath} (file mode 0600).`);
    console.log("Read it, log in, change it (Profile → Change Password), then");
    console.log("delete the file. Set INITIAL_ADMIN_PASSWORD to skip this flow.");
    console.log("─────────────────────────────────────────────────────────────");
  }
  process.exit(0);
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
