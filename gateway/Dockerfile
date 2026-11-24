# Stage 1: build the React pages (web/). Only this stage needs npm packages.
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# Stage 2: the gateway itself stays dependency-free.
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY --from=web /web/dist ./web/dist
# Runs as root only to use the mounted Docker socket (prototype; see infra/README.md).
# Admin socket directory of llm-proxy (volume shared with it); owned by node so either image can initialise it.
RUN mkdir /run/llm-admin && chown node:node /run/llm-admin
ENV NODE_NO_WARNINGS=1
CMD ["node", "src/index.js"]
