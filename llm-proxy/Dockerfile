FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
WORKDIR /app
COPY package.json ./
COPY src ./src
# Usage database lives on a named volume; created here so the volume inherits node's ownership.
# /run/llm-admin holds the admin unix socket, on a volume shared only with the gateway.
RUN mkdir /data /run/llm-admin && chown node:node /data /run/llm-admin
USER node
ENV NODE_NO_WARNINGS=1 DATA_DIR=/data
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:8081/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/index.js"]
