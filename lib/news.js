// ニュース取得の共通処理 (server.js / notify.js / build.js で使う)
const fs = require('fs');
const NHK = (n) => ({ source: 'NHK', url: `https://news.web.nhk/n-data/conf/na/rss/cat${n}.xml` });
const YAHOO = (name) => ({ source: 'Yahoo!', url: `https://news.yahoo.co.jp/rss/topics/${name}.xml` });

const CATEGORIES = {
  top: { label: '主要', feeds: [NHK(0), YAHOO('top-picks')] },
  society: { label: '社会', feeds: [NHK(1), YAHOO('domestic')] },
  politics: { label: '政治', feeds: [NHK(4)] },
  economy: { label: '経済', feeds: [NHK(5), YAHOO('business')] },
  world: { label: '国際', feeds: [NHK(6), YAHOO('world')] },
  science: { label: '科学・医療', feeds: [NHK(3), YAHOO('science')] },
  it: { label: 'IT', feeds: [YAHOO('it')] },
  sports: { label: 'スポーツ', feeds: [NHK(7), YAHOO('sports')] },
  entertainment: { label: 'エンタメ', feeds: [YAHOO('entertainment')] },
};

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n))
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
}

// 途中で切れた説明文 (NHK の RSS は約100字で「…」になる) を、最後の「。」までにそろえる。
// 「。」が1つも無いときは切れたまま「…」を付けて返す。
function trimToSentence(s) {
  const t = (s || '').replace(/…+$/, '').trim();
  if (!t || t.endsWith('。')) return t;
  const end = t.lastIndexOf('。');
  return end > 0 ? t.slice(0, end + 1) : `${t}…`;
}

function parseRss(xml, source) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.map((it) => ({
    title: tag(it, 'title'),
    link: tag(it, 'link'),
    description: trimToSentence(tag(it, 'description')),
    pubDate: new Date(tag(it, 'pubDate')).toISOString(),
    source,
  })).filter((i) => i.title && i.link);
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`RSS ${res.status}`);
  return parseRss(await res.text(), feed.source);
}

// ---- Yahoo! の要約 ----
// Yahoo! の RSS には見出ししか無いので、記事ページの要約文 (省略されていない detailText) を取ってくる。
// 一度取った要約は使い回す。SUMMARY_CACHE_FILE があればファイルに保存して次の実行に引き継ぐ。
const SUMMARY_CACHE_FILE = process.env.SUMMARY_CACHE_FILE || null;
const SUMMARY_CACHE_VERSION = 2;
const summaries = new Map();
const usedSummaries = new Set();
if (SUMMARY_CACHE_FILE && fs.existsSync(SUMMARY_CACHE_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(SUMMARY_CACHE_FILE, 'utf8'));
    // 以前の形式 (途中で切れた meta description) のキャッシュは捨てて取り直す
    if (saved.version === SUMMARY_CACHE_VERSION) for (const [k, v] of Object.entries(saved.items)) summaries.set(k, v);
  } catch {}
}

async function fetchSummary(link) {
  const res = await fetch(link, { headers: { 'User-Agent': 'Mozilla/5.0 (todays-news)' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return '';
  const html = await res.text();
  let text = '';
  // ページに埋め込まれたデータの detailText が省略なしの要約。無ければ meta description (途中で切れている)
  const state = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{.*?\})<\/script>/s);
  if (state) {
    try { text = JSON.parse(state[1]).topicsDetail?.detailText || ''; } catch {}
  }
  if (!text) {
    const m = html.match(/<meta (?:name="description"|property="og:description") content="([^"]*)"/);
    text = m ? decode(m[1]) : '';
  }
  // 先頭の「（ブルームバーグ）:」「【ワシントン共同】」のような配信元の表記は外す
  return trimToSentence(text.replace(/<[^>]+>/g, '').replace(/^[（(【][^）)】]{1,20}[）)】]\s*[:：]?\s*/, ''));
}

async function addSummaries(items) {
  const todo = items.filter((i) => !i.description);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const it = todo[next++];
      usedSummaries.add(it.link);
      if (!summaries.has(it.link)) {
        try {
          summaries.set(it.link, await fetchSummary(it.link));
        } catch {
          continue; // 取れなかったら見出しだけ (次回またやってみる)
        }
      }
      it.description = summaries.get(it.link);
    }
  };
  await Promise.all([1, 2, 3].map(worker)); // 同時に3件まで
}

// 今回使った要約だけを保存する (古い記事の分は捨てる)
function saveSummaries() {
  if (!SUMMARY_CACHE_FILE) return;
  const items = {};
  for (const k of usedSummaries) if (summaries.has(k)) items[k] = summaries.get(k);
  fs.writeFileSync(SUMMARY_CACHE_FILE, JSON.stringify({ version: SUMMARY_CACHE_VERSION, items }));
}

// カテゴリの全フィードを取得して新しい順に並べる。一部のフィードが失敗しても残りを返す。
async function fetchCategory(key) {
  const results = await Promise.allSettled(CATEGORIES[key].feeds.map(fetchFeed));
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw new Error('all feeds failed');
  const items = ok.flatMap((r) => r.value).sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  await addSummaries(items);
  return { category: key, label: CATEGORIES[key].label, fetchedAt: new Date().toISOString(), items };
}

// 「まずはこの3本」: NHK の記事から新しい順に3本
function pickBrief(items, n = 3) {
  return items.filter((i) => i.source === 'NHK' && i.description).slice(0, n);
}

module.exports = { CATEGORIES, fetchCategory, pickBrief, saveSummaries };
