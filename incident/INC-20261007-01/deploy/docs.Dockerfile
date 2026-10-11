# syntax=docker/dockerfile:1
# Tredgate Loan handbook search (docs-search). Hardened after INC-20261005-01.
ARG BASE_IMAGE=node:22.19.0-alpine

FROM ${BASE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY rag ./rag
COPY docs ./docs
COPY tsconfig*.json ./
RUN npx tsx rag/cli.ts --index

FROM ${BASE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save tsx@4
COPY --from=build /app/rag ./rag
COPY --from=build /app/docs ./docs
COPY tsconfig*.json ./

ENV RAG_PORT=3001
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:3001/health || exit 1

CMD ["npx", "tsx", "rag/server.ts"]
