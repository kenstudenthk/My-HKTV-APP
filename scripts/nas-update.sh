#!/usr/bin/env bash
set -euo pipefail

SCRAPE_CATEGORY="${SCRAPE_CATEGORY:-all}"
SKIP_SCRAPE=0

for arg in "$@"; do
  case "$arg" in
    --skip-scrape)
      SKIP_SCRAPE=1
      ;;
    --scrape=*)
      SCRAPE_CATEGORY="${arg#*=}"
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--skip-scrape] [--scrape=all|dog|cat]" >&2
      exit 2
      ;;
  esac
done

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Local changes found. Commit/stash them before updating:" >&2
  git status --short
  exit 1
fi

echo "Fetching latest code..."
git fetch origin main
git pull --ff-only origin main

echo "Rebuilding and restarting app container..."
docker compose up -d --build app

echo "Checking app health..."
for i in {1..30}; do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/scrape/status').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    echo "App is responding inside the app container"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "App did not respond in time. Recent logs:" >&2
    docker compose logs --tail=80 app >&2
    exit 1
  fi
  sleep 2
done

if [ "$SKIP_SCRAPE" -eq 0 ]; then
  echo "Triggering scrape: $SCRAPE_CATEGORY"
  docker compose exec -T -e SCRAPE_CATEGORY="$SCRAPE_CATEGORY" app node -e "
    fetch('http://127.0.0.1:3000/api/scrape/trigger?category=' + process.env.SCRAPE_CATEGORY, { method: 'POST' })
      .then(async r => {
        console.log(await r.text());
        process.exit(r.ok || r.status === 409 ? 0 : 1);
      })
      .catch(err => {
        console.error(err.message);
        process.exit(1);
      });
  "
else
  echo "Skipping scrape."
fi

echo "Done. Open https://pets.kkhome.uk after the scrape finishes."
