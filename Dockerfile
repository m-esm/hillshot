FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY public ./public
ENV PORT=8090
EXPOSE 8090
CMD ["node", "server/server.js"]
