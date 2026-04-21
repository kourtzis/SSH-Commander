import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import crypto from "crypto";

// 1.14.0 H-7: the previous seed always used "admin123", which meant every
// fresh deployment shipped with a guessable admin login. We now read
// INITIAL_ADMIN_PASSWORD from the env; if unset, we generate a random
// password and print it once so the operator can copy it from the first
// container start logs and rotate it via the UI.
async function seed() {
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, "admin"))
    .limit(1);

  if (existing.length > 0) {
    // Detect the legacy default password and warn loudly so operators upgrading
    // from <=1.13 know they're still shipping the well-known admin123.
    const ok = await bcrypt.compare("admin123", existing[0].passwordHash).catch(() => false);
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
    password = crypto.randomBytes(18).toString("base64").replace(/[+/=]/g, "").slice(0, 24);
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
    console.log("─────────────────────────────────────────────────────────────");
    console.log("Created admin user.");
    console.log(`  username: admin`);
    console.log(`  password: ${password}`);
    console.log("Save this password now — it WILL NOT be shown again. Set");
    console.log("INITIAL_ADMIN_PASSWORD before first start to avoid the random one.");
    console.log("─────────────────────────────────────────────────────────────");
  }
  process.exit(0);
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
