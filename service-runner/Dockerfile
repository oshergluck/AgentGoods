# The AgentGoods service runner: executes hosted service code in isolation (see server.js).
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /runner
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js child.js sandbox.js ./
# Runs as the unprivileged `node` user; nothing in the image is writable by it.
USER node
EXPOSE 8080
CMD ["node", "server.js"]
