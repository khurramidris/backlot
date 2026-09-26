# Backlot: one image serving the web app and the engine (API + job worker + FFmpeg).
#   docker build -t backlot .
#   docker run -p 8787:8787 --env-file engine/.env backlot

FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:22-slim AS engine
WORKDIR /engine
COPY engine/package.json engine/package-lock.json engine/tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY engine/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/engine
ENV NODE_ENV=production PORT=8787 WEB_DIR=/app/web
COPY --from=engine /engine/node_modules ./node_modules
COPY --from=engine /engine/dist ./dist
COPY engine/package.json ./
COPY engine/db ./db
COPY engine/public ./public
COPY --from=web /web/dist /app/web
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
