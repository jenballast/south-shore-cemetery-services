#!/usr/bin/env node
// IndexNow submitter for static sites. Node 18+ (uses built-in fetch).
//
// What it does:
//   1. Reads the live sitemap (follows sitemap indexes).
//   2. Fetches each page and hashes the body.
//   3. Compares against the previous run's state file.
//   4. Submits only added/changed URLs, plus URLs that dropped out of the sitemap (deleted).
//
// First run with no state file only records a baseline and submits nothing
// (IndexNow guidance: don't submit URLs that changed before you adopted it).
//
// Env:
//   INDEXNOW_HOST   e.g. ballastadvisory.com            (required)
//   INDEXNOW_KEY    the key; {key}.txt must be live at the site root (required)
//   SITEMAP_URL     default https://$INDEXNOW_HOST/sitemap.xml
//   STATE_FILE      default .indexnow-state.json
//   ENDPOINT        default https://api.indexnow.org/indexnow
//
// Flags:
//   --dry-run            show what would be submitted, send nothing
//   --wait-minutes N     poll until a change shows up (use right after a deploy), default 0
//   --poll-seconds N     poll interval, default 45

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const host = process.env.INDEXNOW_HOST;
const key = process.env.INDEXNOW_KEY;
if (!host || !key) {
  console.error('INDEXNOW_HOST and INDEXNOW_KEY are required');
  process.exit(2);
}
if (!/^[A-Za-z0-9-]{8,128}$/.test(key)) {
  console.error('INDEXNOW_KEY must be 8-128 chars: letters, numbers, dashes');
  process.exit(2);
}

const sitemapUrl = process.env.SITEMAP_URL || `https://${host}/sitemap.xml`;
const stateFile = process.env.STATE_FILE || '.indexnow-state.json';
const endpoint = process.env.ENDPOINT || 'https://api.indexnow.org/indexnow';
const keyLocation = `https://${host}/${key}.txt`;

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const dryRun = flag('--dry-run');
const waitMinutes = val('--wait-minutes', 0);
const pollSeconds = val('--poll-seconds', 45);

const UA = 'indexnow-submit/1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  return res;
}

async function sitemapUrls(url, depth = 0) {
  const res = await get(url);
  if (!res.ok) throw new Error(`sitemap ${url} -> HTTP ${res.status}`);
  const xml = await res.text();
  const found = locs(xml);
  if (/<sitemapindex/i.test(xml) && depth < 3) {
    const nested = [];
    for (const u of found) nested.push(...(await sitemapUrls(u, depth + 1)));
    return nested;
  }
  return found;
}

async function snapshot() {
  const urls = [...new Set(await sitemapUrls(sitemapUrl))].filter((u) => new URL(u).host.replace(/^www\./, '') === host.replace(/^www\./, ''));
  const out = {};
  for (const u of urls) {
    const res = await get(u);
    if (!res.ok) {
      console.warn(`skip ${u} (HTTP ${res.status})`);
      continue;
    }
    out[u] = createHash('sha256').update(await res.text()).digest('hex');
  }
  return out;
}

function diff(prev, next) {
  const changed = [];
  const deleted = [];
  for (const [u, h] of Object.entries(next)) if (prev[u] !== h) changed.push(u);
  for (const u of Object.keys(prev)) if (!(u in next)) deleted.push(u);
  return { changed, deleted };
}

async function submit(urlList) {
  for (let i = 0; i < urlList.length; i += 10000) {
    const batch = urlList.slice(i, i + 10000);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': UA },
      body: JSON.stringify({ host, key, keyLocation, urlList: batch }),
    });
    console.log(`IndexNow: submitted ${batch.length} URL(s) -> HTTP ${res.status}`);
    if (![200, 202].includes(res.status)) {
      console.error(await res.text().catch(() => ''));
      if (res.status === 403) console.error(`403: confirm ${keyLocation} is live and contains exactly the key`);
      if (res.status === 429) console.error('429: slow down, too many submissions');
      process.exitCode = 1;
    }
  }
}

let prev = null;
try {
  prev = JSON.parse(await readFile(stateFile, 'utf8'));
} catch {}

const deadline = Date.now() + waitMinutes * 60_000;
let next, changed, deleted;
for (;;) {
  next = await snapshot();
  if (prev === null) break; // baseline run
  ({ changed, deleted } = diff(prev, next));
  if (changed.length || deleted.length || Date.now() >= deadline) break;
  console.log(`no changes yet, checking again in ${pollSeconds}s`);
  await sleep(pollSeconds * 1000);
}

if (prev === null) {
  console.log(`Baseline recorded for ${Object.keys(next).length} URL(s). Nothing submitted.`);
} else if (!changed.length && !deleted.length) {
  console.log('No added, changed, or deleted URLs.');
} else {
  const list = [...changed, ...deleted];
  console.log(`added/changed: ${changed.length}, deleted: ${deleted.length}`);
  list.forEach((u) => console.log(`  ${u}`));
  if (dryRun) console.log('dry run: nothing sent');
  else await submit(list);
}

if (!dryRun) await writeFile(stateFile, JSON.stringify(next, null, 2));
