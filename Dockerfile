FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY examples ./examples

EXPOSE 4050

CMD ["node", "server/index.js"]
