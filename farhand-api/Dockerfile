# The API, as an image.
#
# Multi-stage, and the reason is what ends up in the last stage: the compiler,
# the type definitions, the test runner and several hundred megabytes of
# development dependencies are all needed to BUILD this and none of them are
# needed to RUN it. Anything left in the final image is something that has to
# be patched, scanned and shipped for the rest of the project's life. Measured
# while this was written: 839 MB multi-stage against 1.39 GB in one stage.
#
# Four stages, and the fourth is the one that ships:
#
#   deps      every dependency, for building with
#   build     TypeScript to JavaScript, and the Prisma client generated
#   proddeps  production dependencies only, installed from the same lockfile
#   runtime   node, the compiled output, and proddeps — nothing else
#
# Node 24 to match .github/workflows/ci.yml. Alpine because the difference is
# roughly 1.1 GB against 150 MB and the API needs nothing musl cannot give it.

# ─────────────────────────────── deps ────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ─────────────────────────────── build ───────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# prisma.config.ts reads DATABASE_URL just to load, even for a command that
# never connects to anything. The real value arrives at run time.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npx prisma generate

RUN npm run build

# ───────────────────────────── proddeps ──────────────────────────────
FROM node:24-alpine AS proddeps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ────────────────────────────── runtime ──────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --chown=node:node --from=proddeps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node --from=build /app/package.json /app/prisma.config.ts ./

USER node

EXPOSE 3000

CMD ["node", "dist/server.js"]

# A HEALTHCHECK, so `docker compose up --wait` and any orchestrator can tell
# "ready" from merely "started". /health/ready is the one that checks the
# database too (#3).
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"