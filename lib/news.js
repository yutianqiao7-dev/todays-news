// ニュース取得の共通処理 (server.js と notify.js で使う)
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

function parseRss(xml, source) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.map((it) => ({
    title: tag(it, 'title'),
    link: tag(it, 'link'),
    description: tag(it, 'description'),
    pubDate: new Date(tag(it, 'pubDate')).toISOString(),
    source,
  })).filter((i) => i.title && i.link);
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`RSS ${res.status}`);
  return parseRss(await res.text(), feed.source);
}

// カテゴリの全フィードを取得して新しい順に並べる。一部のフィードが失敗しても残りを返す。
async function fetchCategory(key) {
  const results = await Promise.allSettled(CATEGORIES[key].feeds.map(fetchFeed));
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw new Error('all feeds failed');
  const items = ok.flatMap((r) => r.value).sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return { category: key, label: CATEGORIES[key].label, fetchedAt: new Date().toISOString(), items };
}

// 「まずはこの3本」: 説明文のある記事 (NHK) から新しい順に3本
function pickBrief(items, n = 3) {
  return items.filter((i) => i.description).slice(0, n);
}

module.exports = { CATEGORIES, fetchCategory, pickBrief };
