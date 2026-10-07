FROM node:20-bullseye-slim

# Install Chromium, build tools for native modules, and font packages
RUN apt-get update && apt-get install -y \
    chromium \
    python3 \
    make \
    g++ \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer Chromium settings for Docker/Linux VPS
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3000

WORKDIR /usr/src/app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application code
COPY . .

# Expose server port
EXPOSE 3000

# Start server
CMD [ "npm", "start" ]
