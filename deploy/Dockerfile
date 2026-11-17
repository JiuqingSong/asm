# AsmPerfect 86, built from the repo on the family server (deploy/update-server.sh).
# Stage 1 builds the web app with Node; stage 2 serves it with a small Python server.

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html tsconfig.json ./
COPY src ./src
ARG APP_VERSION=dev
ENV VITE_APP_VERSION=$APP_VERSION
RUN npx vite build && gzip -k -9 dist/assets/*.js dist/assets/*.css

FROM python:3.12-slim
ARG APP_VERSION=dev
ARG APP_COMMIT=
COPY --from=build /src/dist /app/dist
COPY deploy/server.py /app/server.py
RUN python -c "import json, sys, datetime; json.dump({'version': sys.argv[1], 'commit': sys.argv[2], 'builtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')}, open('/app/version.json', 'w'))" "$APP_VERSION" "$APP_COMMIT"
CMD ["python", "-u", "/app/server.py"]
