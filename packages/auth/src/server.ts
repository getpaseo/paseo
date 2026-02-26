import express from "express"
import { z } from "zod"
import {
  generateTotpSecret,
  verifyTotp,
  generateQrCodeDataUrl,
} from "./totp.js"
import { initJwt, issueToken, shouldRefreshToken } from "./jwt.js"
import {
  initAuthDb,
  createUser,
  getUserByUsername,
  getUserById,
  listUsers,
  deleteUser,
  markTotpCodeUsed,
  getUserCount,
} from "./store.js"
import { authMiddleware, adminMiddleware } from "./middleware.js"
import { loadOrCreateJwtSecret } from "./jwt.js"
import path from "path"
import os from "os"

const JUNCTION_HOME =
  process.env.JUNCTION_HOME ?? path.join(os.homedir(), ".junction")

// Initialize
const jwtSecret = loadOrCreateJwtSecret(JUNCTION_HOME)
initJwt(jwtSecret)
initAuthDb(
  process.env.AUTH_DB_PATH ??
    path.join(JUNCTION_HOME, "auth", "auth.db"),
)

const app = express()
app.use(express.json())

// CORS for web app
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*")
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization",
  )
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
  if (_req.method === "OPTIONS") {
    res.sendStatus(204)
    return
  }
  next()
})

// ---------- Health ----------

app.get("/health", (_req, res) => {
  res.json({ ok: true })
})

// ---------- Public Routes ----------

// Login with TOTP
app.post("/auth/login", (req, res) => {
  const body = z
    .object({
      username: z.string().min(1).max(50),
      code: z.string().length(6),
    })
    .safeParse(req.body)

  if (!body.success) {
    res.status(400).json({ error: "Invalid request" })
    return
  }

  const { username, code } = body.data
  const user = getUserByUsername(username)

  if (!user) {
    res.status(401).json({ error: "Invalid credentials" })
    return
  }

  if (!verifyTotp(user.totpSecret, code)) {
    res.status(401).json({ error: "Invalid credentials" })
    return
  }

  if (!markTotpCodeUsed(username, code)) {
    res.status(401).json({ error: "Code already used, wait for next code" })
    return
  }

  const token = issueToken(user.id, user.username, user.role)

  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role },
  })
})

// Verify/refresh token
app.get("/auth/me", authMiddleware, (req, res) => {
  const payload = req.user!
  const user = getUserById(payload.sub)

  if (!user) {
    res.status(401).json({ error: "User not found" })
    return
  }

  const response: Record<string, unknown> = {
    user: { id: user.id, username: user.username, role: user.role },
  }

  if (shouldRefreshToken(payload)) {
    response.token = issueToken(user.id, user.username, user.role)
  }

  res.json(response)
})

// ---------- Bootstrap ----------

// First-run: create initial admin user (only works if no users exist)
app.post("/auth/bootstrap", async (req, res) => {
  const count = getUserCount()
  if (count > 0) {
    res.status(403).json({ error: "Already bootstrapped" })
    return
  }

  const body = z
    .object({
      username: z.string().min(1).max(50).regex(/^[a-zA-Z0-9_-]+$/),
    })
    .safeParse(req.body)

  if (!body.success) {
    res.status(400).json({ error: "Invalid username" })
    return
  }

  const { secret, uri } = generateTotpSecret(body.data.username)
  const user = createUser(body.data.username, secret, "admin")
  const qrCode = await generateQrCodeDataUrl(uri)

  res.json({
    user: { id: user.id, username: user.username, role: "admin" },
    setup: { qrCode, uri, secret },
  })
})

// ---------- Admin Routes ----------

// Create new user
app.post("/auth/users", authMiddleware, adminMiddleware, async (req, res) => {
  const body = z
    .object({
      username: z.string().min(1).max(50).regex(/^[a-zA-Z0-9_-]+$/),
      role: z.enum(["admin", "user"]).default("user"),
    })
    .safeParse(req.body)

  if (!body.success) {
    res.status(400).json({ error: "Invalid request" })
    return
  }

  const existing = getUserByUsername(body.data.username)
  if (existing) {
    res.status(409).json({ error: "Username taken" })
    return
  }

  const { secret, uri } = generateTotpSecret(body.data.username)
  const user = createUser(body.data.username, secret, body.data.role)
  const qrCode = await generateQrCodeDataUrl(uri)

  res.json({
    user: { id: user.id, username: user.username, role: user.role },
    setup: { qrCode, uri, secret },
  })
})

// List users
app.get("/auth/users", authMiddleware, adminMiddleware, (_req, res) => {
  const users = listUsers().map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    createdAt: u.createdAt,
  }))
  res.json({ users })
})

// Delete user
app.delete(
  "/auth/users/:id",
  authMiddleware,
  adminMiddleware,
  (req, res) => {
    deleteUser(req.params.id as string)
    res.json({ ok: true })
  },
)

// ---------- Start ----------

const PORT = parseInt(process.env.AUTH_PORT ?? "6800")
app.listen(PORT, () => {
  console.log(`Junction auth server listening on :${PORT}`)
  console.log(`  JWT secret loaded from ${JUNCTION_HOME}/auth/jwt-secret.key`)
  console.log(
    `  Database at ${process.env.AUTH_DB_PATH ?? path.join(JUNCTION_HOME, "auth", "auth.db")}`,
  )
})
