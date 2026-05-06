FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 8317
CMD ["/start.sh"]
