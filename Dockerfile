# --- Stage 1: build the Vite app at /app ---
FROM node:22-slim AS app-build
WORKDIR /build
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
RUN npm run build

# --- Stage 2: server runtime ---
FROM node:22-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ src/
COPY extensions/ extensions/
COPY ui/ ui/
COPY scripts/ scripts/

# Bring over the built /app UI (only the dist output)
COPY app/package.json app/package.json
COPY --from=app-build /build/dist app/dist

RUN mkdir -p .data

EXPOSE 8787
CMD ["node", "src/index.mjs"]
