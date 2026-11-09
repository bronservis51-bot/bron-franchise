FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node server.mjs package.json ./
USER node
EXPOSE 8080
CMD ["node","server.mjs"]
