import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

async function seed() {
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, "admin"))
    .limit(1);

  if (existing.length > 0) {
    console.log("Admin user already exists, skipping seed.");
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash("admin123", 10);
  await db.insert(usersTable).values({
    username: "admin",
    email: "admin@localhost",
    passwordHash,
    role: "admin",
  });

  console.log("Created admin user: admin / admin123");
  process.exit(0);
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
