FROM node:22 AS build-env
WORKDIR /app
COPY index.js ./
COPY package*.json ./
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs22-debian12
COPY --from=build-env /app /app
WORKDIR /app
EXPOSE 3000
CMD ["index.js"]
