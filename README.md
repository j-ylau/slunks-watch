# slunks-watch

Polls [SlunksMarket](https://slunksmarket.com)'s `all-products` collection every
15 min and sends a **Telegram** message when products are **added, delisted,
restocked, sold out, or repriced**. Runs free on GitHub Actions.

## How it works

1. `check.mjs` fetches `/collections/all-products/products.json` (all pages).
2. Diffs against `snapshot.json` (committed in this repo = persistent state).
3. On change → Telegram message. Always rewrites `snapshot.json`.
4. `.github/workflows/watch.yml` runs it on cron + commits the snapshot back.

First run baselines silently-ish (sends "Watching N products"), then only
real changes alert.

## Setup (one time)

**1. Telegram bot**
- Telegram → [@BotFather](https://t.me/botfather) → `/newbot` → copy the **token**.
- Message your new bot anything.
- Open `https://api.telegram.org/bot<TOKEN>/getUpdates` → copy `chat.id`.

**2. Repo secrets** (Settings → Secrets and variables → Actions):
- `TG_TOKEN` = bot token
- `TG_CHAT` = chat id

**3. Run it**: Actions tab → `slunks-watch` → **Run workflow**. Baseline message
should arrive in Telegram. After that it's automatic every 15 min.

## Tuning

- **Interval**: edit the `cron` in `watch.yml` (`*/15` → `*/30` etc.).
- **What alerts**: toggle the `ALERT` flags at the top of `check.mjs`.
- **Different collection / whole store**: change `COLLECTION` in `check.mjs`
  (`""` = entire store).

## Notes

- No Shopify webhook access (not our store) → this is polling, not push.
- GitHub may delay scheduled runs a few min under load. Fine for a store watcher.
- Zero dependencies, Node 18+.
