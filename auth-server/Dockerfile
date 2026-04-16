FROM node:22-alpine AS base

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

# ─── Dependencies ────────────────────────────────────────────────────────────
FROM base AS deps

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

# ─── Build ───────────────────────────────────────────────────────────────────
FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

# Placeholders for build time (overridden at runtime)
ENV BETTER_AUTH_SECRET=build-placeholder-secret-32chars!!
ENV BETTER_AUTH_URL=http://localhost:3002
ENV GITHUB_CLIENT_ID=placeholder
ENV GITHUB_CLIENT_SECRET=placeholder
ENV GOOGLE_CLIENT_ID=placeholder
ENV GOOGLE_CLIENT_SECRET=placeholder
ENV NEXT_PUBLIC_APP_URL=http://localhost:3002
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder

RUN pnpm build

# ─── Production ──────────────────────────────────────────────────────────────
FROM base AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

WORKDIR /app

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3002

ENV PORT=3002
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
