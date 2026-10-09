ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.22

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
CMD ["node", "dist/index.js"]
