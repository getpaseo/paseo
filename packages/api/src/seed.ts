import { prisma } from "./db.js"

async function seed() {
  // GitHub SSO handles user creation on first login.
  // No seed users needed.
  console.log("  No seed data required (GitHub SSO handles user creation).")
}

seed()
  .catch((err) => {
    console.error("  Seed failed:", err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
