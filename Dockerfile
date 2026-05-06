FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Script de démarrage qui injecte le token depuis l'env var
RUN echo '#!/bin/sh\n\
mkdir -p /root/.auth2api\n\
if [ -n "$CLAUDE_TOKEN" ]; then\n\
  echo "$CLAUDE_TOKEN" > /root/.auth2api/claude-gamestudios2023@gmail.com.json\n\
fi\n\
exec node dist/index.js' > /start.sh && chmod +x /start.sh

EXPOSE 8317
CMD ["/start.sh"]
