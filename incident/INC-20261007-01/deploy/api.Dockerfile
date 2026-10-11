# syntax=docker/dockerfile:1
# Tredgate Loan API + built frontend. Hardened after INC-20261005-01 (pinned base, multi-stage,
# non-root user, healthcheck). Snapshot of the file deployed to CZ-PRG-01 on 2026-10-07 13:00 CEST.
ARG BASE_IMAGE=node:22.19.0-alpine

FROM ${BASE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM ${BASE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save tsx@4
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY legacy ./legacy
COPY tsconfig*.json ./

ENV PORT=3000
ENV DATA_FILE=/data/loans.json
ENV AUDIT_FILE=/data/audit.log

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:3000/api/health || exit 1

CMD ["npx", "tsx", "server/index.ts"]
