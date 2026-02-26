import { initTRPC, TRPCError } from "@trpc/server"
import type { Request, Response } from "express"
import { auth } from "../auth.js"
import { fromNodeHeaders } from "better-auth/node"

export interface TRPCContext {
  req: Request
  res: Response
  userId: string | null
}

export async function createContext({
  req,
  res,
}: {
  req: Request
  res: Response
}): Promise<TRPCContext> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  })
  return {
    req,
    res,
    userId: session?.user?.id ?? null,
  }
}

const t = initTRPC.context<TRPCContext>().create()

export const router = t.router
export const publicProcedure = t.procedure

export const authedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" })
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } })
})
