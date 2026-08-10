FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
ENV NODE_ENV=production
CMD ["bun", "src/server.ts"]
