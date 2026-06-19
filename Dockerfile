FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
COPY test ./test
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN npm install -g @openai/codex && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY package.json ./

USER node
CMD ["node", "dist/src/index.js"]
