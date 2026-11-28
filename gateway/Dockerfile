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
COPY --from=common . /common
COPY --from=web /web/dist ./web/dist
# The gateway does not mount the Docker socket and does not run as root: the entrypoint starts as root with three capabilities only to take
# over the volumes made by earlier versions, then drops everything and runs `node` (docs/security-review.md, SEC-10).
# /data is the database, /run/llm-admin the llm-proxy's admin socket (shared with it), /run/gw the gateway's own socket (shared with Caddy).
RUN mkdir /data /run/llm-admin /run/gw && chown node:node /data /run/llm-admin /run/gw
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENV NODE_NO_WARNINGS=1 DATA_DIR=/data
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
