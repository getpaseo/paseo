import { createAuthClient } from "better-auth/react"

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3100"

export const authClient = createAuthClient({
  baseURL: API_URL,
})

export const { useSession, signIn, signOut } = authClient
