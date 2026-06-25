# slunks-watch

Polls [SlunksMarket](https://slunksmarket.com)'s `all-products` collection every
15 min and pushes an **[ntfy.sh](https://ntfy.sh)** notification when products are
**added, delisted, restocked, sold out, or repriced**. Runs free on GitHub Actions.

## How it works

1. `check.mjs` fetches `/collections/all-products/products.json` (all pages).
2. Diffs against `snapshot.json` (committed in this repo = persistent state).
3. On change → Telegram message. Always rewrites `snapshot.json`.
4. `.github/workflows/watch.yml` runs it on cron + commits the snapshot back.

First run baselines silently-ish (sends "Watching N products"), then only
real changes alert.

## Setup (one time)

**1. ntfy** — install the [ntfy](https://ntfy.sh) app (or use the web), subscribe
to a topic with an unguessable name (the topic string is the only secret).

**2. Repo secret** (Settings → Secrets and variables → Actions):
- `NTFY_TOPIC` = your topic name (e.g. `slunks-for-justin-2262003`)
- optional `NTFY_SERVER` if self-hosting ntfy (default `https://ntfy.sh`)

**3. Run it**: Actions tab → `slunks-watch` → **Run workflow**. Baseline push
should arrive on your phone. After that it's automatic every 15 min.

## Tuning

- **Interval**: edit the `cron` in `watch.yml` (`*/15` → `*/30` etc.).
- **What alerts**: toggle the `ALERT` flags at the top of `check.mjs`.
- **Different collection / whole store**: change `COLLECTION` in `check.mjs`
  (`""` = entire store).

## Notes

- No Shopify webhook access (not our store) → this is polling, not push.
- GitHub may delay scheduled runs a few min under load. Fine for a store watcher.
- Zero dependencies, Node 18+.
