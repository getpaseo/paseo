import { z } from "zod"
import { router, authedProcedure } from "../index.js"
import { prisma } from "../../db.js"

export const preferencesRouter = router({
  get: authedProcedure.query(async ({ ctx }) => {
    const prefs = await prisma.userPreferences.findUnique({
      where: { userId: ctx.userId },
    })
    // Return defaults if no preferences saved yet
    return (
      prefs ?? {
        id: "",
        userId: ctx.userId,
        theme: "dark",
        sidebarWidth: 240,
        sidebarOpen: true,
        defaultProvider: "claude",
        defaultCwd: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    )
  }),

  update: authedProcedure
    .input(
      z.object({
        theme: z.enum(["dark", "light", "system"]).optional(),
        sidebarWidth: z.number().int().min(160).max(500).optional(),
        sidebarOpen: z.boolean().optional(),
        defaultProvider: z.enum(["claude", "codex", "opencode"]).optional(),
        defaultCwd: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return prisma.userPreferences.upsert({
        where: { userId: ctx.userId },
        create: {
          userId: ctx.userId,
          ...input,
        },
        update: input,
      })
    }),
})
