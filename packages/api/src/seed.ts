import { auth } from "./auth.js"
import { prisma } from "./db.js"

const DEV_USER = {
  email: "test@gmail.com",
  password: "Test123!@#",
  name: "Test User",
}

async function seed() {
  const existing = await prisma.user.findUnique({
    where: { email: DEV_USER.email },
  })

  if (existing) {
    console.log(`  User ${DEV_USER.email} already exists, skipping.`)
    return
  }

  await auth.api.signUpEmail({
    body: {
      email: DEV_USER.email,
      password: DEV_USER.password,
      name: DEV_USER.name,
    },
  })

  console.log(`  Seeded user: ${DEV_USER.email}`)
}

seed()
  .catch((err) => {
    console.error("  Seed failed:", err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
