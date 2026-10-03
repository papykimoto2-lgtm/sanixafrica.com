FROM node:22-alpine AS build
WORKDIR /app/api
COPY api/package*.json ./
RUN npm ci
COPY api/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app/api
ENV NODE_ENV=production
COPY --from=build /app/api ./
COPY db /app/db
EXPOSE 3001
# applique les migrations puis démarre l'API
CMD ["sh", "-c", "npx ts-node scripts/migrate.ts ${SNIFI_SEED:+--seed} && node dist/main.js"]
