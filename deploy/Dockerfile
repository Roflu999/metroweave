FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV HOST=0.0.0.0 PORT=5173 METROWEAVE_MAPS_DIR=/maps
COPY --from=build /app/dist ./dist
COPY scripts/serve.mjs ./scripts/serve.mjs
USER node
EXPOSE 5173
CMD ["node", "scripts/serve.mjs"]
