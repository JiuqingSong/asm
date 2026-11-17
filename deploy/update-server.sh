#!/usr/bin/env bash
# Updates AsmPerfect 86 on the server: pulls this repo, rebuilds and restarts the container.
# Commit and push first (release.bat runs this over ssh).
#
#   ~/asmperfect/deploy/update-server.sh            pull, rebuild, restart
#   ~/asmperfect/deploy/update-server.sh --no-pull  rebuild what is here
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" != "--no-pull" ]; then
    git pull --ff-only
fi

# The version shown in the app: 0.<number of commits>, plus the commit id.
APP_VERSION="0.$(git rev-list --count HEAD)"
APP_COMMIT="$(git rev-parse --short HEAD)"
export APP_VERSION APP_COMMIT

cd deploy
if [ ! -f .env ]; then
    echo "Run deploy/setup-server.sh first." >&2
    exit 1
fi
sudo --preserve-env=APP_VERSION,APP_COMMIT docker compose build --pull
sudo --preserve-env=APP_VERSION,APP_COMMIT docker compose up -d --remove-orphans

for _ in $(seq 60); do
    if curl -fsS http://localhost:8075/api/v1/version 2>/dev/null | grep -q "\"$APP_COMMIT\""; then
        echo "AsmPerfect 86 $APP_VERSION is up to date and running ($(git log -1 --format='%h %s'))."
        exit 0
    fi
    sleep 2
done
echo "The page didn't answer with the new version. See: sudo docker compose -f $(pwd)/docker-compose.yml logs" >&2
exit 1
