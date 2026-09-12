# bands.finance: the Mr Bands loop and the platform API in ONE process (one process holds the key).
#   docker build -t bands .
#   docker run -p 3000:3000 -v bands-data:/app/data --env-file .env bands
# Set SERVE_PORT (Railway/Fly inject PORT; the CMD maps it) and mount /app/data for the ledgers.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/
RUN npm ci && npm --prefix web ci
COPY . .
RUN npm --prefix web run build && npm run typecheck

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/skills ./skills
VOLUME ["/app/data"]
EXPOSE 3000
# DRY_RUN stays on unless the environment says the literal "false".
CMD ["sh", "-c", "SERVE_PORT=${PORT:-3000} npx tsx src/index.ts"]
