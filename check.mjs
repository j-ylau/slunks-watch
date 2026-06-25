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

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT = process.env.TG_CHAT;

// --- fetch every product across all pages ---
async function fetchAll() {
  const base = COLLECTION
    ? `${STORE}/collections/${COLLECTION}/products.json`
    : `${STORE}/products.json`;
  const items = {};
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`${base}?limit=250&page=${page}`, {
      headers: { "user-agent": "slunks-watch/1.0" },
    });
    if (!res.ok) throw new Error(`fetch page ${page}: ${res.status}`);
    const { products } = await res.json();
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

// --- format ---
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const link = (it) =>
  `<a href="${STORE}/products/${it.handle}">${esc(it.title)}</a>`;
const money = (n) => `$${n.toFixed(2)}`;

function buildMessage(d) {
  const lines = [];
  if (ALERT.new && d.added.length) {
    lines.push(`\u{1F195} <b>NEW (${d.added.length})</b>`);
    for (const it of d.added) lines.push(`  ${link(it)} — ${money(it.price)}`);
  }
  if (ALERT.delisted && d.removed.length) {
    lines.push(`❌ <b>DELISTED (${d.removed.length})</b>`);
    for (const it of d.removed) lines.push(`  ${esc(it.title)}`);
  }
  if (ALERT.restock && d.restocked.length) {
    lines.push(`✅ <b>BACK IN STOCK (${d.restocked.length})</b>`);
    for (const it of d.restocked) lines.push(`  ${link(it)} — ${money(it.price)}`);
  }
  if (ALERT.oos && d.oos.length) {
    lines.push(`⚪ <b>SOLD OUT (${d.oos.length})</b>`);
    for (const it of d.oos) lines.push(`  ${esc(it.title)}`);
  }
  if (ALERT.price && d.priced.length) {
    lines.push(`\u{1F4B0} <b>PRICE (${d.priced.length})</b>`);
    for (const it of d.priced)
      lines.push(`  ${link(it)}  ${money(it.was)} → ${money(it.price)}`);
  }
  return lines.join("\n");
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log("[no telegram creds — would send]:\n" + text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) throw new Error(`telegram: ${res.status} ${await res.text()}`);
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
  await sendTelegram(`\u{1F440} Watching SlunksMarket — ${count} products baselined.`);
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
  await sendTelegram(buildMessage(d));
}
writeSnapshot(cur);
