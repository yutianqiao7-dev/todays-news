// GitHub Pages 用の静的サイトを dist/ に作る。
// public/ をコピーし、全カテゴリのニュースを dist/data/*.json に、
// 読み上げ原稿と音声 (VOICEVOX が使えれば MP3) を dist/audio/ に書き出す。
const fs = require('fs');
const path = require('path');
const { CATEGORIES, fetchCategory, pickBrief } = require('../lib/news');
const { buildScript } = require('../lib/speech');
const { connect, createVoice, pruneCache } = require('./voice');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const dataDir = path.join(dist, 'data');
const audioDir = path.join(dist, 'audio');

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
  fs.mkdirSync(audioDir, { recursive: true });

  const categories = Object.entries(CATEGORIES).map(([key, c]) => ({ key, label: c.label }));
  fs.writeFileSync(path.join(dataDir, 'categories.json'), JSON.stringify(categories));

  const all = {};
  for (const key of Object.keys(CATEGORIES)) {
    const data = await fetchCategory(key); // 全フィード失敗なら例外 → ビルド失敗で前回の公開内容が残る
    if (key === 'top') data.brief = pickBrief(data.items);
    all[key] = data;
    fs.writeFileSync(path.join(dataDir, `${key}.json`), JSON.stringify(data));
    console.log(`${data.label}: ${data.items.length}件`);
  }

  // 音声づくり。失敗してもサイトは公開し、画面側は端末の声で読む
  const voices = (process.env.SKIP_VOICE ? [] : await connect()).map(createVoice);
  console.log(voices.length ? `音声: ${voices.map((v) => v.credit).join(', ')}` : '音声: VOICEVOX なし (端末の声で読む)');
  const version = Date.now().toString(36);
  for (const key of Object.keys(CATEGORIES)) {
    const parts = buildScript(all.top.brief, all[key]);
    // voices: 声ごとの音声ファイルと、各 part の開始秒
    const out = { parts, voices: [] };
    for (const voice of voices) {
      try {
        const t = Date.now();
        const file = `${key}-${voice.key}.mp3`;
        const starts = await voice.render(parts.map((p) => p.text), path.join(audioDir, file));
        out.voices.push({ key: voice.key, name: voice.name, credit: voice.credit, audio: `audio/${file}?v=${version}`, starts });
        console.log(`  ${all[key].label} ${voice.name} ${((Date.now() - t) / 1000).toFixed(1)}秒`);
      } catch (e) {
        console.error(`  ${all[key].label} ${voice.name} 音声失敗: ${e.message}`);
      }
    }
    fs.writeFileSync(path.join(audioDir, `${key}.json`), JSON.stringify(out));
  }
  if (voices.length) {
    const c = pruneCache();
    console.log(`音声キャッシュ: ${c.kept}件 (古い${c.removed}件を削除)`);
  }
}

main().catch((e) => {
  console.error('ビルド失敗:', e.message);
  process.exit(1);
});
