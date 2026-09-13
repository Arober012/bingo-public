FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/control/package.json apps/control/package.json
COPY apps/controller/package.json apps/controller/package.json
COPY apps/overlay/package.json apps/overlay/package.json
COPY apps/owner/package.json apps/owner/package.json
COPY apps/viewer/package.json apps/viewer/package.json
COPY packages/game-core/package.json packages/game-core/package.json

RUN npm install

COPY . .

RUN npm --workspace @bingo/game-core run build && npm run build

ENV NODE_ENV=production
EXPOSE 4000

CMD ["npm", "run", "start"]