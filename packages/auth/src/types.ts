export interface User {
  id: string
  username: string
  totpSecret: string
  role: "admin" | "user"
  createdAt: string
  updatedAt: string
}

export interface TokenPayload {
  sub: string // userId
  username: string
  role: "admin" | "user"
  iat: number
  exp: number
}

export interface AuthConfig {
  jwtSecret: string
  jwtExpiry?: string // default "30d"
  dbPath?: string
  port?: number
}
