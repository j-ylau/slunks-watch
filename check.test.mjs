import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toItem,
  diff,
  buildMessage,
  changeCount,
  fetchPage,
  fetchAll,
  serializeSnapshot,
} from "./check.mjs";

const item = (o = {}) => ({
  title: "#X",
  handle: "x",
  price: 100,
  available: true,
  ...o,
});

// ---------- toItem ----------
test("toItem: min price across variants, available if any variant available", () => {
  const it = toItem({
    title: "#A",
    handle: "a",
    variants: [
      { price: "199.99", available: false },
      { price: "149.99", available: true },
    ],
  });
  assert.deepEqual(it, { title: "#A", handle: "a", price: 149.99, available: true });
});

test("toItem: all sold out => available false", () => {
  const it = toItem({
    title: "#A", handle: "a",
    variants: [{ price: "10", available: false }, { price: "20", available: false }],
  });
  assert.equal(it.available, false);
});

test("toItem: missing/garbage prices filtered, no NaN", () => {
  const it = toItem({
    title: "#A", handle: "a",
    variants: [{ price: undefined, available: true }, { price: "50.00", available: true }],
  });
  assert.equal(it.price, 50);
});

test("toItem: zero variants => price null, not Infinity", () => {
  const it = toItem({ title: "#A", handle: "a", variants: [] });
  assert.equal(it.price, null);
  assert.equal(it.available, false);
});

// ---------- diff ----------
test("diff: identical => no changes", () => {
  const s = { 1: item(), 2: item({ title: "#Y" }) };
  const d = diff(s, structuredClone(s));
  assert.equal(changeCount(d), 0);
});

test("diff: NEW product", () => {
  const d = diff({ 1: item() }, { 1: item(), 2: item({ title: "#NEW", price: 250 }) });
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].title, "#NEW");
  assert.equal(d.removed.length, 0);
});

test("diff: DELISTED product", () => {
  const d = diff({ 1: item(), 2: item({ title: "#GONE" }) }, { 1: item() });
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].title, "#GONE");
  assert.equal(d.added.length, 0);
});

test("diff: restock false->true", () => {
  const d = diff({ 1: item({ available: false }) }, { 1: item({ available: true }) });
  assert.equal(d.restocked.length, 1);
  assert.equal(d.oos.length, 0);
});

test("diff: out of stock true->false", () => {
  const d = diff({ 1: item({ available: true }) }, { 1: item({ available: false }) });
  assert.equal(d.oos.length, 1);
  assert.equal(d.restocked.length, 0);
});

test("diff: price change captures was + new", () => {
  const d = diff({ 1: item({ price: 319.99 }) }, { 1: item({ price: 269.99 }) });
  assert.equal(d.priced.length, 1);
  assert.equal(d.priced[0].was, 319.99);
  assert.equal(d.priced[0].price, 269.99);
});

test("diff: same price (float) => no spurious change", () => {
  const d = diff({ 1: item({ price: 189.99 }) }, { 1: item({ price: 189.99 }) });
  assert.equal(d.priced.length, 0);
});

test("diff: one product restocked AND repriced => appears in both", () => {
  const d = diff(
    { 1: item({ available: false, price: 100 }) },
    { 1: item({ available: true, price: 80 }) },
  );
  assert.equal(d.restocked.length, 1);
  assert.equal(d.priced.length, 1);
});

test("diff: empty prev => everything added", () => {
  const d = diff({}, { 1: item(), 2: item() });
  assert.equal(d.added.length, 2);
});

test("diff: NEW product never also flagged restock/oos/price", () => {
  const d = diff({}, { 1: item({ available: true, price: 10 }) });
  assert.equal(d.added.length, 1);
  assert.equal(d.restocked.length, 0);
  assert.equal(d.oos.length, 0);
  assert.equal(d.priced.length, 0);
});

// ---------- buildMessage ----------
test("buildMessage: NEW shows name + price", () => {
  const msg = buildMessage(diff({}, { 1: item({ title: "#OCVC PUERTO RICO", price: 249.99 }) }));
  assert.match(msg, /🆕 NEW \(1\)/);
  assert.match(msg, /#OCVC PUERTO RICO — \$249\.99/);
});

test("buildMessage: empty diff => empty string", () => {
  assert.equal(buildMessage(diff({ 1: item() }, { 1: item() })), "");
});

test("buildMessage: titles with special chars survive (plain text)", () => {
  const msg = buildMessage(diff({}, { 1: item({ title: '#NEB "BEST DAY EVER" & <3', price: 9 }) }));
  assert.match(msg, /#NEB "BEST DAY EVER" & <3 — \$9\.00/);
});

test("buildMessage: ALERT flags suppress sections", () => {
  const d = diff({ 1: item({ price: 10 }) }, { 1: item({ price: 20 }) });
  const onlyNew = buildMessage(d, { new: true, delisted: false, restock: false, oos: false, price: false });
  assert.equal(onlyNew, ""); // price change suppressed, nothing else
  const withPrice = buildMessage(d, { new: false, delisted: false, restock: false, oos: false, price: true });
  assert.match(withPrice, /💰 PRICE \(1\)/);
});

test("buildMessage: all five sections render together", () => {
  const prev = { keep: item({ price: 10, available: true }), gone: item({ title: "#GONE" }), oosit: item({ available: true }) };
  const cur = { keep: item({ price: 5, available: true }), fresh: item({ title: "#FRESH", price: 1 }), oosit: item({ available: false }) };
  // also a restock: add product that was unavailable -> available
  prev.back = item({ available: false }); cur.back = item({ available: true });
  const msg = buildMessage(diff(prev, cur));
  assert.match(msg, /🆕 NEW/);
  assert.match(msg, /❌ DELISTED/);
  assert.match(msg, /✅ BACK IN STOCK/);
  assert.match(msg, /⚪ SOLD OUT/);
  assert.match(msg, /💰 PRICE/);
});

// ---------- serializeSnapshot ----------
test("serializeSnapshot: deterministic regardless of key insertion order", () => {
  const a = serializeSnapshot({ 2: item(), 1: item(), 10: item() });
  const b = serializeSnapshot({ 10: item(), 1: item(), 2: item() });
  assert.equal(a, b); // => unchanged catalog yields identical file => no git noise
});

// ---------- fetchPage retry ----------
function stubFetch(seq) {
  let i = 0;
  globalThis.fetch = async () => {
    const r = seq[Math.min(i++, seq.length - 1)];
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
  return () => i; // call count
}
const FAST = { baseDelay: 1 };

test("fetchPage: 200 returns json immediately", async () => {
  const calls = stubFetch([{ status: 200, body: { products: [1] } }]);
  const out = await fetchPage("u", FAST);
  assert.deepEqual(out, { products: [1] });
  assert.equal(calls(), 1);
});

test("fetchPage: 503 then 200 => retries and succeeds", async () => {
  const calls = stubFetch([{ status: 503 }, { status: 200, body: { products: [] } }]);
  const out = await fetchPage("u", FAST);
  assert.deepEqual(out, { products: [] });
  assert.equal(calls(), 2);
});

test("fetchPage: network throw then 200 => recovers", async () => {
  const calls = stubFetch([new Error("ECONNRESET"), { status: 200, body: { products: [] } }]);
  await fetchPage("u", FAST);
  assert.equal(calls(), 2);
});

test("fetchPage: 404 => throws immediately, no retry", async () => {
  const calls = stubFetch([{ status: 404 }, { status: 200, body: { products: [] } }]);
  await assert.rejects(() => fetchPage("u", FAST), /404/);
  assert.equal(calls(), 1);
});

test("fetchPage: persistent 503 => throws after all tries", async () => {
  const calls = stubFetch([{ status: 503 }]);
  await assert.rejects(() => fetchPage("u", { tries: 3, baseDelay: 1 }), /after retries/);
  assert.equal(calls(), 3);
});

// ---------- fetchAll pagination ----------
test("fetchAll: merges pages, stops on empty page", async () => {
  const pages = [
    { status: 200, body: { products: [{ id: 1, title: "#A", handle: "a", variants: [{ price: "10", available: true }] }] } },
    { status: 200, body: { products: [{ id: 2, title: "#B", handle: "b", variants: [{ price: "20", available: false }] }] } },
    { status: 200, body: { products: [] } },
  ];
  let i = 0;
  globalThis.fetch = async () => {
    const r = pages[i++];
    return { ok: true, status: 200, json: async () => r.body };
  };
  const items = await fetchAll(FAST);
  assert.deepEqual(Object.keys(items).sort(), ["1", "2"]);
  assert.equal(items[1].price, 10);
  assert.equal(items[2].available, false);
  assert.equal(i, 3); // 2 data pages + 1 empty terminator
});
