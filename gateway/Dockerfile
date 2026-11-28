# Stage 1: build the React pages (web/). Only this stage needs npm packages.
FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# Stage 2: the gateway itself stays dependency-free.
FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY --from=web /web/dist ./web/dist
# Runs as root only to use the mounted Docker socket (prototype; see infra/README.md).
# Admin socket directory of llm-proxy (volume shared with it); owned by node so either image can initialise it.
RUN mkdir /run/llm-admin /run/gw && chown node:node /run/llm-admin /run/gw
ENV NODE_NO_WARNINGS=1
CMD ["node", "src/index.js"]
