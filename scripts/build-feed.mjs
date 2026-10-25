#!/usr/bin/env node
// Builds one day's feed from Wikipedia.
//
// Picks articles from the topics in config.json, splits each article's lead
// section into short cards, attaches images and their credits, and writes
// site/feed/<date>.json plus site/feed/latest.json.
//
//   node scripts/build-feed.mjs              build today's feed (skips if it exists)
//   node scripts/build-feed.mjs --force      rebuild today's feed
//   node scripts/build-feed.mjs --posts=5    override postsPerDay (handy while testing)
//   node scripts/build-feed.mjs --date=2026-11-01
//   node scripts/build-feed.mjs --refresh    re-crawl the topic categories now
//
// Crawling categories is the slow part, so each topic's list of candidate
// articles is cached in data/candidates.json and refreshed every couple of
// weeks, or straight away when that topic is edited in config.json.

import { readFile, writeFile, mkdir, readdir, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FEED_DIR = path.join(ROOT, 'site', 'feed');
const HISTORY_FILE = path.join(ROOT, 'data', 'history.json');
const CANDIDATES_FILE = path.join(ROOT, 'data', 'candidates.json');
const REFRESH_CANDIDATES_DAYS = 14;
const KEEP_FEEDS_DAYS = 7;

const API = 'https://en.wikipedia.org/w/api.php';
const REST = 'https://en.wikipedia.org/api/rest_v1';
// Wikimedia asks API clients to identify themselves with a way to get in touch.
const USER_AGENT = `DailyDig/1.0 (personal history reader; https://github.com/${process.env.GITHUB_REPOSITORY || 'daily-dig'})`;
const REQUEST_GAP_MS = 400;
const WORDS_PER_MINUTE = 230;
const SECONDS_PER_IMAGE = 4;
const MAX_CATEGORIES_PER_TOPIC = 40;
const IMAGE_WIDTH = 1280;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function todayIn(timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86_400_000);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const countWords = (text) => (text.match(/\S+/g) || []).length;

let lastRequest = 0;
async function getJson(url, attempt = 1) {
  // Be polite to Wikimedia: one request at a time, a few per second at most.
  const wait = lastRequest + REQUEST_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();

  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT } });
  if ((res.status === 429 || res.status >= 500) && attempt < 7) {
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    await sleep(Math.max(retryAfter * 1000, 1500 * 2 ** attempt));
    return getJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function api(params) {
  const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  return getJson(`${API}?${qs}`);
}

// --------------------------------------------------------------- categories

// Follows {{Category redirect}} so renamed categories in config.json still work.
async function resolveCategory(name) {
  const title = `Category:${name.replace(/^Category:/i, '')}`;
  const data = await api({
    action: 'query',
    titles: title,
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
  });
  const page = data.query.pages[0];
  if (page.missing) {
    console.warn(`  ! category not found: ${title}`);
    return null;
  }
  const text = page.revisions?.[0]?.slots?.main?.content ?? '';
  const redirect = text.match(/\{\{\s*Category redirect\s*\|\s*(?:Category:)?([^|}]+)/i);
  return redirect ? `Category:${redirect[1].trim()}` : title;
}

async function categoryMembers(category) {
  const pages = [];
  const subcats = [];
  let cont = {};
  for (let round = 0; round < 4; round++) {
    const data = await api({
      action: 'query',
      list: 'categorymembers',
      cmtitle: category,
      cmtype: 'page|subcat',
      cmlimit: 'max',
      ...cont,
    });
    for (const m of data.query.categorymembers) {
      if (m.ns === 0) pages.push(m.title);
      else if (m.ns === 14) subcats.push(m.title);
    }
    if (!data.continue) break;
    cont = data.continue;
  }
  return { pages, subcats };
}

async function collectCandidates(topic, skipPatterns) {
  const skip = (title) => skipPatterns.some((p) => title.toLowerCase().includes(p));
  const queue = [];
  for (const name of topic.categories) {
    const resolved = await resolveCategory(name);
    if (resolved) queue.push([resolved, 0]);
  }

  const seen = new Set();
  const pages = new Set();
  while (queue.length && seen.size < MAX_CATEGORIES_PER_TOPIC) {
    const [category, depth] = queue.shift();
    if (seen.has(category)) continue;
    seen.add(category);

    const members = await categoryMembers(category);
    members.pages.forEach((p) => pages.add(p));
    if (depth < topic.depth) {
      for (const sub of shuffle(members.subcats)) {
        if (!skip(sub)) queue.push([sub, depth + 1]);
      }
    }
  }
  console.log(`  ${topic.label}: ${pages.size} candidate articles from ${seen.size} categories`);
  return [...pages];
}

// ------------------------------------------------------------------ articles

const SKIP_TITLE = /^(List|Lists|Timeline|Outline|Index|Bibliography|Glossary) of\b|\bAct \d{4}$/i;

async function fetchDetails(titles) {
  const params = {
    action: 'query',
    titles: titles.join('|'),
    redirects: '1',
    prop: 'extracts|pageimages|description|pageprops|info|pageviews|categories',
    exintro: '1',
    explaintext: '1',
    exlimit: 'max',
    piprop: 'original|name',
    ppprop: 'disambiguation',
    inprop: 'url',
    pvipdays: '30',
    clcategories: 'Category:Featured articles|Category:Good articles',
  };

  // The API fills in some properties (notably extracts) for only part of the
  // batch and asks for follow-up requests; merge those into one record per page.
  const pages = new Map();
  let cont = {};
  for (let round = 0; round < 10; round++) {
    const data = await api({ ...params, ...cont });
    for (const page of data.query.pages) {
      const existing = pages.get(page.title) || {};
      pages.set(page.title, {
        ...existing,
        ...page,
        extract: existing.extract || page.extract,
        pageviews: existing.pageviews || page.pageviews,
        categories: [...(existing.categories || []), ...(page.categories || [])],
      });
    }
    if (!data.continue) break;
    cont = data.continue;
  }
  return [...pages.values()].filter((p) => !p.missing);
}

function isGood(page, config) {
  if (SKIP_TITLE.test(page.title)) return false;
  const description = (page.description || '').toLowerCase();
  if (config.skipDescriptionsMatching?.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(description))) return false;
  if (page.pageprops && 'disambiguation' in page.pageprops) return false;
  const img = page.original;
  if (!img || img.width < 700 || /\.svg$/i.test(img.source)) return false;
  return countWords(cleanText(page.extract || '')) >= config.minLeadWords;
}

// Favours articles people actually read, and Wikipedia's Featured/Good articles,
// with enough randomness that the feed doesn't settle into the same few hits.
function score(page) {
  const views = Object.values(page.pageviews || {}).reduce((s, v) => s + (v || 0), 0);
  const quality = (page.categories || []).some((c) => c.title.includes('Featured')) ? 1.5
    : page.categories?.length ? 1 : 0;
  return Math.log10(views + 1) + quality + Math.random() * 1.2;
}

function cleanText(text) {
  return text
    .replace(/([a-z\)]{2}[.!?])([A-Z][a-z])/g, '$1 $2') // sentences run together in the source
    .replace(/\s*\([^()]*(?:\/[^()]*\/|pronounced|listen|ⓘ|IPA)[^()]*\)/g, '') // pronunciation guides
    .replace(/\(\s*[;,]?\s*\)/g, '') // parentheses emptied by the plain-text conversion
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const ABBREVIATIONS = /\b(?:St|Mr|Mrs|Ms|Dr|Jr|Sr|Rev|Fr|Bros|Co|Ltd|No|c|ca|fl|r|b|d|vs|etc|i\.e|e\.g|AD|BC)\.$/;

function splitSentences(paragraph) {
  const rough = paragraph.split(/(?<=[.!?]["”’)]?)\s+(?=["“‘(]?[A-Z0-9])/);
  const sentences = [];
  for (const piece of rough) {
    const prev = sentences[sentences.length - 1];
    if (prev && ABBREVIATIONS.test(prev)) sentences[sentences.length - 1] = `${prev} ${piece}`;
    else sentences.push(piece);
  }
  return sentences;
}

// Groups sentences into cards of roughly 40–80 words, preferring paragraph ends.
function chunkText(text, maxCards) {
  const target = 60;
  const hardMax = 80;
  const chunks = [];
  let current = [];
  let words = 0;

  const flush = () => {
    if (current.length) chunks.push(current.join(' '));
    current = [];
    words = 0;
  };

  for (const paragraph of text.split('\n').filter(Boolean)) {
    for (const sentence of splitSentences(paragraph)) {
      const n = countWords(sentence);
      if (words && words + n > hardMax) flush();
      current.push(sentence);
      words += n;
      if (words >= target) flush();
    }
    if (words >= 40) flush();
  }
  flush();

  // Fold a tiny trailing chunk back into the previous one, if the result still fits a card.
  if (chunks.length > 1 && countWords(chunks.at(-1)) < 25 && countWords(chunks.at(-2)) + countWords(chunks.at(-1)) <= hardMax) {
    chunks.splice(-2, 2, `${chunks.at(-2)} ${chunks.at(-1)}`);
  }
  return { chunks: chunks.slice(0, maxCards), truncated: chunks.length > maxCards };
}

async function articleImages(title, coverFile) {
  try {
    const data = await getJson(`${REST}/page/media-list/${encodeURIComponent(title.replace(/ /g, '_'))}`);
    return data.items
      .filter((i) => i.type === 'image' && i.showInGallery !== false && !/\.(svg|gif)$/i.test(i.title))
      .filter((i) => i.title.replace(/^File:/, '').replace(/ /g, '_') !== coverFile.replace(/ /g, '_'))
      .map((i) => ({ file: i.title, caption: i.caption?.text?.trim() || '' }));
  } catch (err) {
    console.warn(`  ! no media list for ${title}: ${err.message}`);
    return [];
  }
}

// Wikimedia appends utm_* tracking parameters to image URLs; they aren't needed.
function cleanUrl(url) {
  if (!url) return url;
  const u = new URL(url);
  for (const key of [...u.searchParams.keys()]) if (key.startsWith('utm_')) u.searchParams.delete(key);
  return u.href;
}

function stripHtml(html = '') {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function imageInfo(files) {
  if (!files.length) return {};
  const data = await api({
    action: 'query',
    titles: files.join('|'),
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata',
    iiurlwidth: String(IMAGE_WIDTH),
    iiextmetadatafilter: 'Artist|LicenseShortName',
  });
  const byTitle = {};
  const normalized = Object.fromEntries((data.query.normalized || []).map((n) => [n.to, n.from]));
  for (const page of data.query.pages) {
    const info = page.imageinfo?.[0];
    if (!info || info.width < 500) continue;
    const meta = info.extmetadata || {};
    const entry = {
      src: cleanUrl(info.thumburl || info.url),
      width: info.thumbwidth || info.width,
      height: info.thumbheight || info.height,
      page: info.descriptionurl,
      artist: stripHtml(meta.Artist?.value).slice(0, 80) || 'Unknown',
      license: stripHtml(meta.LicenseShortName?.value) || '',
    };
    byTitle[page.title] = entry;
    if (normalized[page.title]) byTitle[normalized[page.title]] = entry;
  }
  return byTitle;
}

async function buildPost(page, topic, config) {
  const text = cleanText(page.extract);
  const { chunks, truncated } = chunkText(text, config.maxCardsPerPost);

  const coverFile = `File:${page.pageimage}`;
  const extras = (await articleImages(page.title, page.pageimage)).slice(0, chunks.length);
  const info = await imageInfo([coverFile, ...extras.map((e) => e.file)]);
  if (!info[coverFile]) return null;

  const imageList = extras.map((e) => (info[e.file] ? { ...info[e.file], caption: e.caption } : null)).filter(Boolean);
  // Spread the extra images across the text cards, leaving the first card text-only
  // when there are fewer images than cards so the story opens on words, not pictures.
  const offset = chunks.length - imageList.length > 0 ? 1 : 0;
  const cards = chunks.map((chunk, i) => ({ text: chunk, image: imageList[i - offset] ?? null }));

  const words = chunks.reduce((n, c) => n + countWords(c), 0);
  const imageCount = 1 + cards.filter((c) => c.image).length;
  const seconds = (words / WORDS_PER_MINUTE) * 60 + imageCount * SECONDS_PER_IMAGE;

  return {
    id: String(page.pageid),
    title: page.title,
    description: page.description ? page.description[0].toUpperCase() + page.description.slice(1) : '',
    topic: topic.id,
    topicLabel: topic.label,
    url: page.fullurl,
    cover: info[coverFile],
    cards,
    truncated,
    readSeconds: Math.round(seconds),
  };
}

// Splits `total` posts across topics in proportion to their weights.
function allocate(topics, total) {
  const weightSum = topics.reduce((s, t) => s + (t.weight ?? 1), 0);
  const raw = topics.map((t) => ((t.weight ?? 1) / weightSum) * total);
  const counts = raw.map(Math.floor);
  const order = shuffle(raw.map((r, i) => [r - Math.floor(r), i])).sort((a, b) => b[0] - a[0]);
  for (let k = 0; counts.reduce((a, b) => a + b, 0) < total; k++) counts[order[k % order.length][1]]++;
  return counts;
}

async function candidatesFor(topic, config, cache, date) {
  const skipPatterns = config.skipCategoriesMatching.map((s) => s.toLowerCase());
  const key = JSON.stringify([topic.categories, topic.depth, skipPatterns]);
  const cached = cache[topic.id];
  const fresh = cached && cached.key === key && daysBetween(cached.builtOn, date) < REFRESH_CANDIDATES_DAYS;
  if (fresh && !args.refresh) return cached.pages;

  const pages = await collectCandidates(topic, skipPatterns);
  cache[topic.id] = { key, builtOn: date, pages };
  await writeFile(CANDIDATES_FILE, JSON.stringify(cache));
  return pages;
}

async function pickForTopic(topic, count, config, history, taken, candidatePool) {
  const candidates = shuffle(candidatePool).filter((t) => !history[t] && !taken.has(t));

  // Gather a shortlist several times larger than needed, then keep the best.
  const shortlist = [];
  const maxBatches = 12;
  for (let i = 0; i < candidates.length && i < maxBatches * 20 && shortlist.length < count * 4; i += 20) {
    for (const page of await fetchDetails(candidates.slice(i, i + 20))) {
      if (!taken.has(page.title) && !history[page.title] && isGood(page, config)) {
        shortlist.push({ page, score: score(page) });
      }
    }
  }
  shortlist.sort((a, b) => b.score - a.score);

  const posts = [];
  for (const { page } of shortlist) {
    if (posts.length >= count) break;
    if (taken.has(page.title)) continue;
    const post = await buildPost(page, topic, config);
    if (!post) continue;
    taken.add(page.title);
    posts.push(post);
    console.log(`    + ${page.title}`);
  }
  if (posts.length < count) console.warn(`  ! only found ${posts.length}/${count} for ${topic.label}`);
  return posts;
}

// Round-robin across topics so the feed alternates subjects.
function interleave(groups) {
  const queues = shuffle(groups.filter((g) => g.length)).map((g) => [...g]);
  const out = [];
  while (queues.some((q) => q.length)) {
    for (const q of queues) if (q.length) out.push(q.shift());
  }
  return out;
}

// ---------------------------------------------------------------------- main

async function main() {
  const config = JSON.parse(await readFile(path.join(ROOT, 'config.json'), 'utf8'));
  const date = args.date || todayIn(config.timezone);
  const total = Number(args.posts) || config.postsPerDay;
  const feedFile = path.join(FEED_DIR, `${date}.json`);

  await mkdir(FEED_DIR, { recursive: true });
  await mkdir(path.dirname(HISTORY_FILE), { recursive: true });

  if (!args.force && (await exists(feedFile))) {
    console.log(`Feed for ${date} already exists; use --force to rebuild.`);
    return;
  }

  // Forget articles shown long enough ago that they may come round again.
  const history = await readJson(HISTORY_FILE, {});
  for (const [title, shown] of Object.entries(history)) {
    if (daysBetween(shown, date) > config.repeatAfterDays) delete history[title];
  }

  console.log(`Building ${total} posts for ${date}`);
  const counts = allocate(config.topics, total);
  const cache = await readJson(CANDIDATES_FILE, {});
  const taken = new Set();
  const groups = [];
  for (const [i, topic] of config.topics.entries()) {
    if (counts[i] === 0) continue;
    const pool = await candidatesFor(topic, config, cache, date);
    groups.push(await pickForTopic(topic, counts[i], config, history, taken, pool));
  }

  const posts = interleave(groups);
  for (const post of posts) history[post.title] = date;

  const feed = {
    date,
    generatedAt: new Date().toISOString(),
    totalReadSeconds: posts.reduce((s, p) => s + p.readSeconds, 0),
    posts,
  };

  const json = JSON.stringify(feed, null, 1);
  await writeFile(feedFile, json);
  await writeFile(path.join(FEED_DIR, 'latest.json'), json);
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 1));

  for (const file of await readdir(FEED_DIR)) {
    const m = file.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (m && daysBetween(m[1], date) > KEEP_FEEDS_DAYS) await rm(path.join(FEED_DIR, file));
  }

  console.log(`Wrote ${posts.length} posts (~${Math.round(feed.totalReadSeconds / 60)} min reading) to ${path.relative(ROOT, feedFile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
