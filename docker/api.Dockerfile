# Tredgate Loan API + built frontend (container pilot, release 1.2.0)
ARG BASE_IMAGE=node:latest
FROM ${BASE_IMAGE}

WORKDIR /app

# bring the whole checkout in; the host node_modules may come along, so start clean
COPY . .
RUN rm -rf node_modules && npm install

# build the frontend into dist/ so the API serves it (npm start equivalent)
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_FILE=/data/loans.json
ENV AUDIT_FILE=/data/audit.log

EXPOSE 3000

CMD ["npx", "tsx", "server/index.ts"]
