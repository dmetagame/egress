FROM node:22.22.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/risk-engine/package.json packages/risk-engine/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY packages/risk-engine packages/risk-engine
RUN npm --workspace @egress/risk-engine run build

FROM node:22.22.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    EGRESS_RUNTIME_MODE=LIVE_READ_ONLY \
    EGRESS_DEPLOYMENT_ENV=production \
    EGRESS_WEB_INLINE_POLLING=false

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/risk-engine/package.json packages/risk-engine/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev

COPY --from=build /app/packages/risk-engine/dist packages/risk-engine/dist
COPY --from=build /app/packages/risk-engine/migrations packages/risk-engine/migrations

USER node
CMD ["node", "packages/risk-engine/dist/cli/live-poll.js"]
