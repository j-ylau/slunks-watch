// Slunks watcher — polls slunksmarket.com product catalog, diffs against
// snapshot.json, sends a Telegram message on changes. No deps, Node 18+.

const STORE = "https://slunksmarket.com";
const COLLECTION = "all-products"; // watch this collection; "" = whole store
const SNAPSHOT = new URL("./snapshot.json", import.meta.url);

// Which changes to alert on:
const ALERT = {
  new: true,
  delisted: true,
  restock: true, // out-of-stock -> in-stock
  oos: true, // in-stock -> out-of-stock
  price: true,
};

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const NTFY_SERVER = process.env.NTFY_SERVER || "https://ntfy.sh";
const NTFY_TOPIC = process.env.NTFY_TOPIC;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch one page, retrying transient errors (503/429/network) with backoff
async function fetchPage(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "slunks-watch/1.0" },
      });
      if (res.ok) return res.json();
      if (res.status === 503 || res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${res.status}`);
      } else {
        throw new Error(`${url}: ${res.status}`); // 4xx = real, don't retry
      }
    } catch (e) {
      lastErr = e;
    }
    if (attempt < 4) await sleep(attempt * 2000); // 2s, 4s, 6s
  }
  throw new Error(`fetch failed after retries: ${url} (${lastErr?.message})`);
}

// --- fetch every product across all pages ---
async function fetchAll() {
  const base = COLLECTION
    ? `${STORE}/collections/${COLLECTION}/products.json`
    : `${STORE}/products.json`;
  const items = {};
  for (let page = 1; page <= 20; page++) {
    const { products } = await fetchPage(`${base}?limit=250&page=${page}`);
    if (!products.length) break;
    for (const p of products) {
      const prices = p.variants.map((v) => parseFloat(v.price));
      items[p.id] = {
        title: p.title,
        handle: p.handle,
        price: Math.min(...prices),
        available: p.variants.some((v) => v.available),
      };
    }
  }
  return items;
}

// --- diff prev vs cur ---
function diff(prev, cur) {
  const added = [],
    removed = [],
    restocked = [],
    oos = [],
    priced = [];
  for (const id in cur) {
    const c = cur[id],
      p = prev[id];
    if (!p) {
      added.push(c);
      continue;
    }
    if (!p.available && c.available) restocked.push(c);
    if (p.available && !c.available) oos.push(c);
    if (p.price !== c.price) priced.push({ ...c, was: p.price });
  }
  for (const id in prev) if (!cur[id]) removed.push(prev[id]);
  return { added, removed, restocked, oos, priced };
}

// --- format (plain text; product titles start with "#") ---
const money = (n) => `$${n.toFixed(2)}`;

function buildMessage(d) {
  const lines = [];
  if (ALERT.new && d.added.length) {
    lines.push(`\u{1F195} NEW (${d.added.length})`);
    for (const it of d.added) lines.push(`  ${it.title} — ${money(it.price)}`);
  }
  if (ALERT.delisted && d.removed.length) {
    lines.push(`❌ DELISTED (${d.removed.length})`);
    for (const it of d.removed) lines.push(`  ${it.title}`);
  }
  if (ALERT.restock && d.restocked.length) {
    lines.push(`✅ BACK IN STOCK (${d.restocked.length})`);
    for (const it of d.restocked) lines.push(`  ${it.title} — ${money(it.price)}`);
  }
  if (ALERT.oos && d.oos.length) {
    lines.push(`⚪ SOLD OUT (${d.oos.length})`);
    for (const it of d.oos) lines.push(`  ${it.title}`);
  }
  if (ALERT.price && d.priced.length) {
    lines.push(`\u{1F4B0} PRICE (${d.priced.length})`);
    for (const it of d.priced)
      lines.push(`  ${it.title}  ${money(it.was)} → ${money(it.price)}`);
  }
  return lines.join("\n");
}

async function notify(text, title = "SlunksMarket update") {
  if (!NTFY_TOPIC) {
    console.log("[no ntfy topic — would send]:\n" + text);
    return;
  }
  const res = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
    method: "POST",
    headers: {
      Title: title,
      Tags: "shopping_cart",
      Click: `${STORE}/collections/${COLLECTION || "all"}`,
    },
    body: text,
  });
  if (!res.ok) throw new Error(`ntfy: ${res.status} ${await res.text()}`);
}

// stable JSON so unchanged catalog => identical file => no git commit
function writeSnapshot(items) {
  const sorted = {};
  for (const id of Object.keys(items).sort()) sorted[id] = items[id];
  writeFileSync(SNAPSHOT, JSON.stringify(sorted, null, 2) + "\n");
}

// --- main ---
const cur = await fetchAll();
const count = Object.keys(cur).length;
console.log(`fetched ${count} products`);

if (!existsSync(SNAPSHOT)) {
  writeSnapshot(cur);
  await notify(`\u{1F440} Watching SlunksMarket — ${count} products baselined.`, "slunks-watch started");
  console.log("baseline written");
  process.exit(0);
}

const prev = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
const d = diff(prev, cur);
const total =
  d.added.length + d.removed.length + d.restocked.length + d.oos.length + d.priced.length;

if (total === 0) {
  console.log("no changes");
} else {
  console.log(`changes: ${total}`);
  await notify(buildMessage(d));
}
writeSnapshot(cur);
