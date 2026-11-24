# Forward proxy that is the only way out of a user network. No dependencies; runs unprivileged.
FROM node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
ENV NODE_NO_WARNINGS=1
EXPOSE 3128
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:3128/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/index.js"]
