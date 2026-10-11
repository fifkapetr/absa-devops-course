# Tredgate Loan handbook search (docs-search), container pilot
FROM node:22

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY tsconfig*.json ./
COPY rag ./rag
COPY docs ./docs

ENV RAG_PORT=3001
# admin token for POST /reindex
ENV DOCS_ADMIN_TOKEN=FAKE-docs-admin-7f3a

EXPOSE 3001

CMD ["npx", "tsx", "rag/server.ts"]
