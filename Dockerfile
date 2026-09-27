FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
RUN mkdir -p /data/objects /data/tmp
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node","src/server.js"]
