// GitHub Pages 用の静的サイトを dist/ に作る。
// public/ をコピーし、全カテゴリのニュースを dist/data/*.json に書き出す。
const fs = require('fs');
const path = require('path');
const { CATEGORIES, fetchCategory, pickBrief } = require('../lib/news');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const dataDir = path.join(dist, 'data');

// fs.cpSync は Windows の日本語パスで Node ごと落ちるので自前でコピーする
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

async function main() {
  fs.rmSync(dist, { recursive: true, force: true });
  copyDir(path.join(root, 'public'), dist);
  fs.mkdirSync(dataDir, { recursive: true });

  const categories = Object.entries(CATEGORIES).map(([key, c]) => ({ key, label: c.label }));
  fs.writeFileSync(path.join(dataDir, 'categories.json'), JSON.stringify(categories));

  for (const key of Object.keys(CATEGORIES)) {
    const data = await fetchCategory(key); // 全フィード失敗なら例外 → ビルド失敗で前回の公開内容が残る
    if (key === 'top') data.brief = pickBrief(data.items);
    fs.writeFileSync(path.join(dataDir, `${key}.json`), JSON.stringify(data));
    console.log(`${data.label}: ${data.items.length}件`);
  }
}

main().catch((e) => {
  console.error('ビルド失敗:', e.message);
  process.exit(1);
});
