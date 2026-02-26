import { createTRPCReact, httpBatchLink } from "@trpc/react-query"
import type { AppRouter } from "@api/trpc/router"

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3100"

export const trpc = createTRPCReact<AppRouter>()

export function createTrpcClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: `${API_URL}/api/trpc`,
        fetch(url, options) {
          return fetch(url, { ...options, credentials: "include" })
        },
      }),
    ],
  })
}
