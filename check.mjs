// Slunks watcher — polls slunksmarket.com product catalog, diffs against
// snapshot.json, sends ntfy notifications on changes. New/restocked products
// get their own notification with product photo and in-stock sizes; other
// changes are batched into one summary. No deps, Node 18+.

const STORE = "https://slunksmarket.com";
const COLLECTION = "all-products"; // watch this collection; "" = whole store
const SNAPSHOT = new URL("./snapshot.json", import.meta.url);

// Only run during these hours, America/Los_Angeles (DST-aware). 9 = 9am, 21 = 9pm.
const WINDOW = { start: 9, end: 21, tz: "America/Los_Angeles" };

// current hour (0-23) in a timezone
export function hourIn(tz, date = new Date()) {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).format(date),
  ) % 24; // "24" midnight edge -> 0
}

// inclusive of start, exclusive of end: [start, end)
export function inWindow(hour, w = WINDOW) {
  return hour >= w.start && hour < w.end;
}

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

// map a Shopify product to our tracked shape
export function toItem(p) {
  const prices = p.variants.map((v) => parseFloat(v.price)).filter((n) => !isNaN(n));
  return {
    title: p.title,
    handle: p.handle,
    price: prices.length ? Math.min(...prices) : null,
    available: p.variants.some((v) => v.available),
    image: p.images?.[0]?.src ?? null,
    // variant title = size on this store; only the ones currently in stock
    sizes: p.variants.filter((v) => v.available).map((v) => v.title).filter(Boolean),
  };
}

// fetch one page, retrying transient errors (503/429/network) with backoff
export async function fetchPage(url, { tries = 5, baseDelay = 3000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "user-agent": "slunks-watch/1.0" } });
    } catch (e) {
      lastErr = e; // network/DNS error -> transient, retry
      if (attempt < tries) await sleep(attempt * baseDelay);
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`${res.status}`); // transient -> retry
      if (attempt < tries) await sleep(attempt * baseDelay); // 2s, 4s, 6s
      continue;
    }
    throw new Error(`${url}: ${res.status}`); // 4xx = real, fail fast
  }
  throw new Error(`fetch failed after retries: ${url} (${lastErr?.message})`);
}

// --- fetch every product across all pages ---
export async function fetchAll(opts) {
  const { pageDelay = 500 } = opts ?? {}; // pace requests so Shopify doesn't 503 the burst
  const base = COLLECTION
    ? `${STORE}/collections/${COLLECTION}/products.json`
    : `${STORE}/products.json`;
  const items = {};
  for (let page = 1; page <= 20; page++) {
    if (page > 1) await sleep(pageDelay);
    const { products } = await fetchPage(`${base}?limit=250&page=${page}`, opts);
    if (!products.length) break;
    for (const p of products) items[p.id] = toItem(p);
  }
  return items;
}

// --- diff prev vs cur ---
export function diff(prev, cur) {
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

export function changeCount(d) {
  return d.added.length + d.removed.length + d.restocked.length + d.oos.length + d.priced.length;
}

export function buildMessage(d, alert = ALERT) {
  const lines = [];
  if (alert.new && d.added.length) {
    lines.push(`\u{1F195} NEW (${d.added.length})`);
    for (const it of d.added) lines.push(`  ${it.title} — ${money(it.price)}`);
  }
  if (alert.delisted && d.removed.length) {
    lines.push(`❌ DELISTED (${d.removed.length})`);
    for (const it of d.removed) lines.push(`  ${it.title}`);
  }
  if (alert.restock && d.restocked.length) {
    lines.push(`✅ BACK IN STOCK (${d.restocked.length})`);
    for (const it of d.restocked) lines.push(`  ${it.title} — ${money(it.price)}`);
  }
  if (alert.oos && d.oos.length) {
    lines.push(`⚪ SOLD OUT (${d.oos.length})`);
    for (const it of d.oos) lines.push(`  ${it.title}`);
  }
  if (alert.price && d.priced.length) {
    lines.push(`\u{1F4B0} PRICE (${d.priced.length})`);
    for (const it of d.priced)
      lines.push(`  ${it.title}  ${money(it.was)} → ${money(it.price)}`);
  }
  return lines.join("\n");
}

async function notify(text, opts = {}) {
  const {
    title = "SlunksMarket update",
    tags = "shopping_cart",
    click = `${STORE}/collections/${COLLECTION || "all"}`,
    attach,
  } = opts;
  if (!NTFY_TOPIC) {
    console.log(`[no ntfy topic — would send]: ${title}${attach ? ` [img: ${attach}]` : ""}\n${text}`);
    return;
  }
  // HTTP headers are latin-1 only; strip anything else from the title
  const headers = {
    Title: title.replace(/[^\x20-\x7E]/g, "").trim(),
    Tags: tags,
    Click: click,
  };
  if (attach) headers.Attach = attach;
  const res = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
    method: "POST",
    headers,
    body: text,
  });
  if (!res.ok) throw new Error(`ntfy: ${res.status} ${await res.text()}`);
}

export const sizeLine = (it) =>
  it.sizes?.length ? `Sizes in stock: ${it.sizes.join(", ")}` : "No sizes in stock";

// one notification per product so ntfy renders its photo
async function notifyProduct(it, kind) {
  const meta = {
    new: { label: "New", tags: "new,shopping_cart" },
    restock: { label: "Back in stock", tags: "white_check_mark,shopping_cart" },
  }[kind];
  await notify(`${it.price == null ? "price n/a" : money(it.price)}\n${sizeLine(it)}`, {
    title: `${meta.label}: ${it.title}`,
    tags: meta.tags,
    click: `${STORE}/products/${it.handle}`,
    attach: it.image || undefined,
  });
}

// stable JSON so unchanged catalog => identical file => no git commit
export function serializeSnapshot(items) {
  const sorted = {};
  for (const id of Object.keys(items).sort()) sorted[id] = items[id];
  return JSON.stringify(sorted, null, 2) + "\n";
}
function writeSnapshot(items) {
  writeFileSync(SNAPSHOT, serializeSnapshot(items));
}

// --- main ---
async function main() {
  const hour = hourIn(WINDOW.tz);
  if (process.env.FORCE !== "1" && !inWindow(hour)) {
    console.log(`outside window (${hour}:00 ${WINDOW.tz}, active ${WINDOW.start}-${WINDOW.end}) — skip`);
    return;
  }

  let cur;
  try {
    cur = await fetchAll();
  } catch (e) {
    // transient throttling (503/429/network) that survived all retries:
    // skip this cycle cleanly — the next 5-min run recovers on its own.
    // 4xx errors don't carry this marker and still fail the run loudly.
    if (/after retries/.test(e.message)) {
      console.log(`transient fetch failure — skipping this run (${e.message})`);
      return;
    }
    throw e;
  }
  const count = Object.keys(cur).length;
  console.log(`fetched ${count} products`);

  if (!existsSync(SNAPSHOT)) {
    writeSnapshot(cur);
    await notify(`\u{1F440} Watching SlunksMarket — ${count} products baselined.`, {
      title: "slunks-watch started",
    });
    console.log("baseline written");
    return;
  }

  const prev = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  const d = diff(prev, cur);
  const total = changeCount(d);

  if (total === 0) {
    console.log("no changes");
  } else {
    console.log(`changes: ${total}`);
    if (ALERT.new) {
      for (const it of d.added) {
        await notifyProduct(it, "new");
        await sleep(500);
      }
    }
    if (ALERT.restock) {
      for (const it of d.restocked) {
        await notifyProduct(it, "restock");
        await sleep(500);
      }
    }
    // remaining change types (delisted / sold out / price) as one summary
    const summary = buildMessage({ ...d, added: [], restocked: [] });
    if (summary) await notify(summary);
  }
  writeSnapshot(cur);
}

// only run when executed directly, not when imported by tests
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) await main();
