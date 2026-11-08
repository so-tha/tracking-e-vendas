# Imagem única para a API e o worker (ADR-025). Estágios:
#   deps    -> instala as dependências
#   build   -> gera o Prisma Client e compila o TypeScript
#   migrate -> aplica as migrations (precisa da CLI do Prisma, que é dependência de desenvolvimento)
#   runtime -> só o necessário para executar (sem dependências de desenvolvimento)
FROM node:24-bookworm-slim AS base
# O Prisma precisa do OpenSSL.
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
COPY src ./src
# A geração do client não conecta ao banco. A URL abaixo só existe para satisfazer a configuração.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate \
 && npm run build

FROM build AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# @prisma/client declara prisma e typescript como peer dependencies opcionais. Como os dois também são
# devDependencies, o lockfile os marca "devOptional" e o npm os instalaria em produção (CLI e Studio do
# Prisma). --omit=optional os remove. Os únicos opcionais de produção perdidos são os binários nativos
# do compilador TypeScript e o pg-cloudflare, que o runtime em Node não usa.
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3333
CMD ["node", "dist/server.js"]
