# Container image for Railway (or any other host that runs a Dockerfile).
#
# Chromium is installed through Playwright itself rather than from a pinned
# `mcr.microsoft.com/playwright:vX` base image, because the browser build has to
# match the Playwright version in package-lock.json exactly. Letting Playwright
# fetch its own browser keeps the two in lockstep through every dependency bump,
# instead of failing at runtime when a tag and a lockfile drift apart.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # Loopback is the right default on a workstation, but inside a container it
    # would make the app unreachable from the platform's router.
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
# Cloudflare clearance. Mount a persistent volume here — a container filesystem
# is wiped on every redeploy.
VOLUME ["/app/data"]

EXPOSE 4300
CMD ["node", "src/server.js"]
