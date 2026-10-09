ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.24

# Build stage: full dependencies, compile TypeScript
FROM ${BUILD_FROM} AS build
RUN apk add --no-cache nodejs npm git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Final stage: production dependencies and compiled output only
FROM ${BUILD_FROM}
RUN apk add --no-cache nodejs npm git
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# s6-overlay's /init clears the container environment for CMD; with-contenv restores it
# (needed for DATA_DIR, OPTIONS_PATH and GATEWAY_FAKE).
CMD ["with-contenv", "node", "dist/index.js"]
