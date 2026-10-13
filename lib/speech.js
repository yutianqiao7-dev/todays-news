// 読み上げ原稿を作る (build.js で音声ファイル化、server.js ではブラウザの声で読む)
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const FALLBACK_ITEMS = 10; // 今日の記事が無いタブで読む本数

function firstSentence(s) {
  const t = (s || '').replace(/…$/, '');
  const i = t.indexOf('。');
  return i > 0 ? t.slice(0, i + 1) : (s || '');
}

// 見出しの区切りスペースを読点にすると、間が自然になる
const forSpeech = (s) => s.replace(/[\s　]+/g, '、').replace(/[【】「」]/g, ' ').replace(/[×✕]/g, '対').trim();

const isToday = (iso, now) => new Date(iso).toDateString() === now.toDateString();

// brief: 「まずはこの3本」(主要の data.brief)。data: 表示中カテゴリのデータ。
// 「まずはこの3本」は主要タブでだけ読み、ほかのタブはそのタブのニュースから始める。
function buildScript(brief, data, now = new Date()) {
  const isTop = data.category === 'top';
  const date = `${now.getMonth() + 1}月${now.getDate()}日、${WEEK[now.getDay()]}曜日`;
  const parts = [{ text: isTop ? `${date}のニュースです。` : `${date}、${data.label}のニュースです。` }];
  const lead = isTop ? brief : [];
  lead.forEach((it, i) => {
    parts.push({ link: it.link, text: `${i + 1}本目。${forSpeech(it.title)}。${firstSentence(it.description)}` });
  });

  const shown = new Set(lead.map((b) => b.link));
  const rest = data.items.filter((i) => !shown.has(i.link));
  const today = rest.filter((i) => isToday(i.pubDate, now));
  // 今日の記事はすべて読む。今日の記事がまだ無いときは新しい順に少しだけ
  const list = today.length ? today : rest.slice(0, FALLBACK_ITEMS);
  if (list.length) {
    if (isTop) parts.push({ text: '続いて、そのほかのニュースです。' });
    list.forEach((it) => parts.push({ link: it.link, text: `${forSpeech(it.title)}。${firstSentence(it.description)}` }));
  }
  parts.push({ text: '以上です。' });
  return parts;
}

module.exports = { buildScript };
