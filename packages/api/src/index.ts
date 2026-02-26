import express from "express"
import cors from "cors"
import { toNodeHandler } from "better-auth/node"
import * as trpcExpress from "@trpc/server/adapters/express"
import { auth } from "./auth.js"
import { appRouter } from "./trpc/router.js"
import { createContext } from "./trpc/index.js"

const PORT = parseInt(process.env.PORT ?? "3100", 10)
const CORS_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  ...(process.env.CORS_ORIGINS?.split(",").filter(Boolean) ?? []),
]

const app = express()

app.use(
  cors({
    origin: CORS_ORIGINS,
    credentials: true,
  }),
)

// Better Auth handles /api/auth/* routes
app.all("/api/auth/*splat", toNodeHandler(auth))

// tRPC handles /api/trpc/* routes
app.use(
  "/api/trpc",
  trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext,
  }),
)

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() })
})

app.listen(PORT, () => {
  console.log(`Junction API server listening on http://localhost:${PORT}`)
  console.log(`  Auth:  http://localhost:${PORT}/api/auth`)
  console.log(`  tRPC:  http://localhost:${PORT}/api/trpc`)
  console.log(`  Health: http://localhost:${PORT}/api/health`)
})
