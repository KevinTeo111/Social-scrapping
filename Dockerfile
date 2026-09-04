# Container image for Railway (or any other host that runs a Dockerfile).
#
# Chromium is installed through Playwright itself rather than from a pinned
# `mcr.microsoft.com/playwright:vX` base image, because the browser build has to
# match the Playwright version in package-lock.json exactly. Letting Playwright
# fetch its own browser keeps the two in lockstep through every dependency bump,
# instead of failing at runtime when a tag and a lockfile drift apart.
FROM node:24-bookworm-slim

# HOST is overridden here because loopback is the right default on a workstation
# but would make the app unreachable from the platform's router in a container.
# (Comments are kept out of the continuation below: the parser does not handle
# them consistently inside a multi-line instruction.)
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOST=0.0.0.0

WORKDIR /app

COPY package.json package-lock.json ./

# --ignore-scripts skips the postinstall browser fetch so it can be run below as
# a separate, cacheable layer that also pulls the system libraries Chromium needs.
RUN npm ci --omit=dev --ignore-scripts

RUN npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

COPY . .

# `data/` holds the SQLite corpus, the encryption key and each member's earned
# Cloudflare clearance, all of which must outlive a redeploy.
#
# There is deliberately no `VOLUME` instruction: Railway rejects the Docker
# directive outright ("docker VOLUME ... is not supported, use Railway Volumes")
# because it attaches storage itself. Create a Railway Volume mounted at
# /app/data and point DB_FILE at /app/data/workana.db. Other hosts can still
# bind-mount the same path, e.g. `docker run -v workana-data:/app/data`.
RUN mkdir -p /app/data

EXPOSE 4300
CMD ["node", "src/server.js"]
