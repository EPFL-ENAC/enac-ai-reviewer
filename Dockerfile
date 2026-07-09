FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Same relative path as the source tree so `npm run migrate` (which passes
# `-m src/db/migrations`) resolves identically in dev and in this image.
COPY --from=build /app/src/db/migrations ./src/db/migrations

ENTRYPOINT ["node", "dist/entrypoint.js"]
CMD ["web"]
