import { z } from "zod"
import { router, authedProcedure } from "../index.js"
import { prisma } from "../../db.js"

export const daemonRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    return prisma.daemonProfile.findMany({
      where: { userId: ctx.userId },
      orderBy: { sortOrder: "asc" },
    })
  }),

  create: authedProcedure
    .input(
      z.object({
        label: z.string().min(1).max(100),
        url: z.string().url().or(z.string().startsWith("ws://")).or(z.string().startsWith("wss://")),
        isDefault: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // If this is the first daemon or marked as default, unset other defaults
      if (input.isDefault) {
        await prisma.daemonProfile.updateMany({
          where: { userId: ctx.userId, isDefault: true },
          data: { isDefault: false },
        })
      }

      const count = await prisma.daemonProfile.count({
        where: { userId: ctx.userId },
      })

      return prisma.daemonProfile.create({
        data: {
          userId: ctx.userId,
          label: input.label,
          url: input.url,
          isDefault: input.isDefault ?? count === 0,
          sortOrder: count,
        },
      })
    }),

  update: authedProcedure
    .input(
      z.object({
        id: z.string(),
        label: z.string().min(1).max(100).optional(),
        url: z.string().optional(),
        isDefault: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input

      if (data.isDefault) {
        await prisma.daemonProfile.updateMany({
          where: { userId: ctx.userId, isDefault: true },
          data: { isDefault: false },
        })
      }

      return prisma.daemonProfile.update({
        where: { id, userId: ctx.userId },
        data,
      })
    }),

  delete: authedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await prisma.daemonProfile.delete({
        where: { id: input.id, userId: ctx.userId },
      })
    }),

  setDefault: authedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await prisma.daemonProfile.updateMany({
        where: { userId: ctx.userId, isDefault: true },
        data: { isDefault: false },
      })
      return prisma.daemonProfile.update({
        where: { id: input.id, userId: ctx.userId },
        data: { isDefault: true },
      })
    }),
})
