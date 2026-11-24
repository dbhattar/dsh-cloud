# Forward proxy that is the only way out of a user network. No dependencies; runs unprivileged.
FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
ENV NODE_NO_WARNINGS=1
EXPOSE 3128
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:3128/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/index.js"]
