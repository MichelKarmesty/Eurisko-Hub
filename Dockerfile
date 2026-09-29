# syntax=docker/dockerfile:1
#
# Eurisko Hub - single-container image (API + web client).
#
# Build:  docker build -t eurisko-hub .
# Run:    docker run --rm -p 8080:8080 \
#           -e JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
#           -e APP_BASE_URL=http://localhost:8080 \
#           -e ADMIN_PASSWORD='change-me-please' \
#           -e DB_FILE=/data/hub.sqlite \
#           -e TYPEORM_SYNCHRONIZE=true \
#           -v eurisko-data:/data \
#           eurisko-hub
#
# The runtime stage runs `deploy/server.mjs`, which serves the built React app
# and proxies /api to the NestJS API it supervises as a child process. That keeps
# the public shape identical to `npm run dev` (Vite proxies /api the same way),
# so nothing in the client has to change for production.

# ---------------------------------------------------------------------------
# Stage 1 - build the API
# ---------------------------------------------------------------------------
FROM node:22-slim AS api-build

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
# tsc -p tsconfig.build.json  ->  backend/dist
RUN npm run build \
    # Keep only production dependencies in the layer we copy forward; the
    # compiler and test tooling are not needed to run the server.
 && npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2 - build the web client
# ---------------------------------------------------------------------------
FROM node:22-slim AS web-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Deliberately no VITE_API_BASE: the client keeps using the relative "/api"
# base, which this image proxies. See frontend/src/api.ts.
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 - runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    API_PORT=3000

WORKDIR /app

COPY --from=api-build  /app/backend/dist          ./backend/dist
COPY --from=api-build  /app/backend/node_modules  ./backend/node_modules
COPY --from=api-build  /app/backend/package.json  ./backend/package.json
COPY --from=web-build  /app/frontend/dist         ./frontend/dist
COPY deploy/server.mjs                           ./deploy/server.mjs

# A place for the SQLite file. Mount a persistent volume here, or every deploy
# starts from an empty database: on Render that is a Disk, on Fly a Volume, on
# Railway a Volume. Point DB_FILE at it (e.g. /data/hub.sqlite).
RUN mkdir -p /data

# NOTE ON THE USER: this image intentionally does not switch to a non-root user.
# Managed platforms mount the persistent volume owned by root, so dropping to an
# unprivileged uid makes SQLite fail with EACCES and the container crash-loops on
# first deploy - a confusing failure to debug live. If you control the volume's
# ownership (Fly volumes, a chowned bind mount, Kubernetes fsGroup), you can
# safely add:  RUN useradd -u 10001 -m hub && chown -R hub /data && USER hub

EXPOSE 8080

# Readiness, not just liveness: /api/health runs SELECT 1, so a container with a
# broken database is reported unhealthy instead of quietly serving errors.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "deploy/server.mjs"]
