# The container contract: listen on 0.0.0.0:${PORT:-8088} and answer GET /readiness.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

# Build the self-contained ESM bundle before building this image.
COPY dist/main.mjs ./main.mjs
COPY dist/main.mjs.map ./main.mjs.map
RUN mkdir -p /app/state && chown -R node:node /app
ENV AGENTSERVER_STATE_ROOT=/app/state
USER node

# Foundry probes this port; binding elsewhere makes every invocation fail with session_not_ready.
EXPOSE 8088

CMD ["node", "main.mjs"]
