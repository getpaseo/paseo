import { router } from "./index.js"
import { daemonRouter } from "./routers/daemon.js"
import { preferencesRouter } from "./routers/preferences.js"

export const appRouter = router({
  daemon: daemonRouter,
  preferences: preferencesRouter,
})

export type AppRouter = typeof appRouter
