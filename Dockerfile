# Build stage
FROM node:20-alpine AS build
# node:20-alpine ships no prebuilt musl binaries for the native deps
# (better-sqlite3/sharp), so npm falls back to node-gyp — which needs a
# toolchain. Latent until a --no-cache rebuild or a base-image bump breaks
# the cached layer (bit lana-pays-gateway on first build, 2026-08-19).
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && apk del python3 make g++
COPY --from=build /app/dist ./dist
COPY server ./server
COPY tsconfig.json tsconfig.node.json ./
EXPOSE 3005
CMD ["npx", "tsx", "server/index.ts"]
