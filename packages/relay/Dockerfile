FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.nodejs.json ./
COPY src/nodejs-adapter.ts ./src/

RUN npx tsc -p tsconfig.nodejs.json --incremental false

FROM node:20-alpine

WORKDIR /app

COPY --from=0 /app/dist ./dist
COPY --from=0 /app/node_modules ./node_modules

ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "dist/nodejs-adapter.js"]
