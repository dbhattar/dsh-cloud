# The only image that mounts the Docker socket. It runs as root to use it (see infra/README.md);
# its HTTP API is narrow and builds every container spec itself, so a compromised gateway cannot
# create privileged containers.
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_NO_WARNINGS=1
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/index.js"]
