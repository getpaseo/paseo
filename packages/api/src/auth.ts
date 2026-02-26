import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { prisma } from "./db.js"

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh daily
  },
  trustedOrigins: [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    ...(process.env.CORS_ORIGINS?.split(",").filter(Boolean) ?? []),
    ...(process.env.TRUSTED_ORIGINS?.split(",").filter(Boolean) ?? []),
  ],
})
