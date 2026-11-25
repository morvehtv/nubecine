FROM node:22-alpine
RUN apk add --no-cache rclone tini
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY start.sh ./
RUN chmod +x start.sh && mkdir -p /app/data /config
ENV PORT=3000 \
    RCLONE_CONFIG=/config/rclone.conf \
    DATA_FILE=/app/data/db.json
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./start.sh"]
