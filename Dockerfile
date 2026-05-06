FROM node:22-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ src/
COPY extensions/ extensions/
COPY ui/ ui/
COPY scripts/ scripts/

RUN mkdir -p .data

EXPOSE 8787
CMD ["node", "src/index.mjs"]
