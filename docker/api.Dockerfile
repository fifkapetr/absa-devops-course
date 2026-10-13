# Tredgate Loan API + built frontend (container pilot, release 1.2.0)
# Override BASE_IMAGE to point at an internal registry mirror.
ARG BASE_IMAGE=node:22.19.0-alpine

# ---- build stage: all deps + frontend bundle ----
FROM ${BASE_IMAGE} AS build
WORKDIR /app
# Copy manifests first so this layer is cached until a dependency changes.
COPY package*.json ./
RUN npm ci
COPY . .
# Type-checks all TS projects and emits dist/ (Vue frontend).
RUN npm run build

# ---- runtime stage: lean image, production deps only ----
FROM ${BASE_IMAGE}
WORKDIR /app
COPY package*.json ./
# Omit devDependencies (tsx, vite, vue-tsc, etc.) from the production image.
RUN npm ci --omit=dev
# Pull in the compiled frontend and the TypeScript source the API needs.
COPY --from=build /app/dist ./dist
COPY server/ ./server/
COPY shared/ ./shared/
# Create the data directory and give it to the node user before dropping privileges.
RUN mkdir -p /data && chown node:node /data
# The node Alpine image ships a non-root "node" user (uid 1000).
USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_FILE=/data/loans.json
ENV AUDIT_FILE=/data/audit.log

EXPOSE 3000

# wget ships with Alpine; probes the same endpoint the gateway forwards to.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/loans || exit 1

# Node 22.19+ strips TS types natively; erasableSyntaxOnly in tsconfig ensures compatibility.
CMD ["node", "--experimental-strip-types", "server/index.ts"]
