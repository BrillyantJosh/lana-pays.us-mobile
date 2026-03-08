# Build stage
FROM node:20-alpine AS build
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
