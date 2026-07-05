FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install the single runtime dependency (mqtt, pure JS — no native builds).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY index.js ./

USER node
CMD ["node", "index.js"]
