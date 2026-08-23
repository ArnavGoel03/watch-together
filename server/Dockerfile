# Build from the REPOSITORY ROOT, not from server/:
#
#   docker build -f server/Dockerfile -t watch-together .
#
# server.js requires ../shared/protocol.cjs, the protocol definition it shares with the
# Cloudflare relay, so the image needs both directories and a context that contains them.
# This used to copy server.js on its own, which is why the path is spelled out here: an
# image that is missing the shared module fails at require time, on boot, in production.
FROM node:20-alpine

WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm ci --production

COPY server/server.js ./
COPY shared/ /app/shared/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
