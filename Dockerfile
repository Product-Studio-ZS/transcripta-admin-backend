FROM node:20-alpine

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=1024"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

EXPOSE 9002

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9002/health || exit 1

CMD ["node", "src/index.js"]
