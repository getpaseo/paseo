import Database from "better-sqlite3"
import { nanoid } from "nanoid"
import fs from "fs"
import path from "path"
import type { User } from "./types.js"

let db: Database.Database

export function initAuthDb(dbPath: string): void {
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      totp_secret TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS used_totp_codes (
      username TEXT NOT NULL,
      code TEXT NOT NULL,
      used_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (username, code)
    );
  `)
}

function getDb(): Database.Database {
  if (!db) throw new Error("Auth DB not initialized. Call initAuthDb() first.")
  return db
}

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    username: row.username as string,
    totpSecret: row.totp_secret as string,
    role: row.role as "admin" | "user",
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export function createUser(
  username: string,
  totpSecret: string,
  role: "admin" | "user" = "user",
): User {
  const id = nanoid()
  const now = new Date().toISOString()
  getDb()
    .prepare(
      "INSERT INTO users (id, username, totp_secret, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, username, totpSecret, role, now, now)

  return { id, username, totpSecret, role, createdAt: now, updatedAt: now }
}

export function getUserByUsername(username: string): User | null {
  const row = getDb()
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username) as Record<string, unknown> | undefined
  if (!row) return null
  return rowToUser(row)
}

export function getUserById(id: string): User | null {
  const row = getDb()
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return rowToUser(row)
}

export function listUsers(): User[] {
  const rows = getDb()
    .prepare("SELECT * FROM users ORDER BY created_at ASC")
    .all() as Record<string, unknown>[]
  return rows.map(rowToUser)
}

export function deleteUser(id: string): void {
  getDb().prepare("DELETE FROM users WHERE id = ?").run(id)
}

export function markTotpCodeUsed(username: string, code: string): boolean {
  try {
    getDb()
      .prepare(
        "INSERT INTO used_totp_codes (username, code) VALUES (?, ?)",
      )
      .run(username, code)
    // Cleanup codes older than 2 minutes
    getDb()
      .prepare(
        "DELETE FROM used_totp_codes WHERE used_at < datetime('now', '-2 minutes')",
      )
      .run()
    return true
  } catch {
    return false
  }
}

export function getUserCount(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) as count FROM users")
    .get() as { count: number }
  return row.count
}
