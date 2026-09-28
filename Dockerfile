FROM mcr.microsoft.com/playwright:v1.61.1-noble

ENV NODE_ENV=production \
    HEADLESS=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-spa && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

EXPOSE 10000

CMD ["npm", "start"]
