# My HKTV APP
HKTVWEbSIte

## NAS update

Run this on the NAS whenever new code is pushed:

```bash
cd /home/kenstudenthk/My-HKTV-APP
./scripts/nas-update.sh
```

This pulls the latest `main`, rebuilds/restarts the Docker app service, checks the local API, and triggers a fresh scrape.

Useful variants:

```bash
./scripts/nas-update.sh --skip-scrape
./scripts/nas-update.sh --scrape=dog
./scripts/nas-update.sh --scrape=cat
```
