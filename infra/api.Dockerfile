FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/prism-core/package.json packages/prism-core/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api apps/api
COPY packages/schemas packages/schemas
COPY packages/prism-core packages/prism-core
COPY scripts/smoke-production.mjs scripts/smoke-production.mjs
RUN pnpm --filter @prismpulse/api... build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app /app
USER node
EXPOSE 4021
CMD ["pnpm", "--filter", "@prismpulse/api", "start"]
