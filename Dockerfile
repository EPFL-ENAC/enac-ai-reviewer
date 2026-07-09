FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
# Same relative path as the source tree so `pnpm run migrate` (which passes
# `-m src/db/migrations`) resolves identically in dev and in this image.
COPY --from=build /app/src/db/migrations ./src/db/migrations

ENTRYPOINT ["node", "dist/entrypoint.js"]
CMD ["web"]
