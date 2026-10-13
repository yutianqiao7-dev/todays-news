// VOICEVOX エンジン (GitHub Actions ではサービスコンテナ) で読み上げ原稿を MP3 にする。
// 各 part の WAV をつなげ、part ごとの開始秒を返す (再生中のハイライト用)。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = process.env.VOICEVOX_URL || 'http://127.0.0.1:50021';
// 画面で切り替えられる声。エンジンに無い声は飛ばす
const VOICES = [
  { key: 'no7', name: 'No.7', style: 'アナウンス' },
  { key: 'ryusei', name: '青山龍星', style: 'ノーマル' },
  { key: 'zundamon', name: 'ずんだもん', style: 'ノーマル' },
];
const GAP_SEC = 0.5; // 記事と記事の間の無音
const SPEED = 1.1; // 少しだけ速めのほうがニュースらしい
// 前回の実行で作った文の音声を置いておく場所 (GitHub Actions のキャッシュで引き継ぐ)。
// 30分前と同じ記事は作り直さないので、更新が速くなる。
const CACHE_DIR = process.env.VOICE_CACHE_DIR || null;
const usedCacheFiles = new Set();
// 1回の実行で新しく音声を作る時間の上限 (秒)。超えた分は次の実行で作る
const BUDGET_SEC = Number(process.env.VOICE_BUDGET_SEC) || 13 * 60;
const deadline = Date.now() + BUDGET_SEC * 1000;
let timedOut = false;

// エンジンが一時的に応答しないことがあるので、少し待って2回までやり直す
async function api(pathname, init, retries = 2) {
  try {
    const r = await fetch(BASE + pathname, { ...init, signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`VOICEVOX ${pathname.split('?')[0]} ${r.status}`);
    return r;
  } catch (e) {
    if (retries <= 0) throw e;
    await new Promise((res) => setTimeout(res, 3000));
    return api(pathname, init, retries - 1);
  }
}

// エンジンの起動を待ち、使える声の一覧を返す。エンジンが無ければ []
async function connect(waitSec = 90) {
  for (let i = 0; i < waitSec; i += 3) {
    try {
      await api('/version', undefined, 0); // 起動待ちはこのループで繰り返す
      const speakers = await (await api('/speakers')).json();
      return VOICES.flatMap((v) => {
        const sp = speakers.find((s) => s.name === v.name);
        const st = sp && (sp.styles.find((x) => x.name === v.style) || sp.styles[0]);
        return st ? [{ key: v.key, name: v.name, id: st.id, credit: `VOICEVOX:${v.name}` }] : [];
      });
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return [];
}

// WAV から PCM 部分とフォーマットを取り出す
function parseWav(buf) {
  let off = 12;
  let fmt = null;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') return { fmt, pcm: buf.subarray(off + 8, off + 8 + size) };
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV に data がありません');
}

function wavHeader(fmt, dataLen) {
  const h = Buffer.alloc(44);
  const blockAlign = (fmt.channels * fmt.bits) / 8;
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(fmt.channels, 22);
  h.writeUInt32LE(fmt.rate, 24); h.writeUInt32LE(fmt.rate * blockAlign, 28); h.writeUInt16LE(blockAlign, 32); h.writeUInt16LE(fmt.bits, 34);
  h.write('data', 36); h.writeUInt32LE(dataLen, 40);
  return h;
}

function createVoice(speaker) {
  const cache = new Map(); // 同じ文 (「まずはこの3本」など) はカテゴリをまたいで使い回す

  async function synth(text) {
    if (cache.has(text)) return cache.get(text);
    const file = CACHE_DIR && path.join(CACHE_DIR, `${crypto.createHash('sha1').update(`${speaker.id}|${SPEED}|${text}`).digest('hex')}.wav`);
    if (file) {
      usedCacheFiles.add(path.basename(file));
      if (fs.existsSync(file)) {
        const parsed = parseWav(fs.readFileSync(file));
        cache.set(text, parsed);
        return parsed;
      }
    }
    if (Date.now() > deadline) {
      timedOut = true;
      throw new Error('時間切れ (次の実行で作ります)');
    }
    const q = await (await api(`/audio_query?speaker=${speaker.id}&text=${encodeURIComponent(text)}`, { method: 'POST' })).json();
    q.speedScale = SPEED;
    const wav = Buffer.from(await (await api(`/synthesis?speaker=${speaker.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q),
    })).arrayBuffer());
    const parsed = parseWav(wav);
    cache.set(text, parsed);
    if (file) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, wav);
    }
    return parsed;
  }

  // parts のテキストを読み上げた MP3 を outFile に書き、各 part の開始秒を返す
  async function render(texts, outFile) {
    const chunks = [];
    const starts = [];
    let fmt = null;
    let bytes = 0;
    for (const text of texts) {
      const w = await synth(text);
      fmt = fmt || w.fmt;
      const bytesPerSec = (fmt.rate * fmt.channels * fmt.bits) / 8;
      starts.push(Math.round((bytes / bytesPerSec) * 100) / 100);
      const gap = Buffer.alloc(Math.round(bytesPerSec * GAP_SEC / 2) * 2);
      chunks.push(w.pcm, gap);
      bytes += w.pcm.length + gap.length;
    }
    const tmp = path.join(os.tmpdir(), `news-${process.pid}-${path.basename(outFile)}.wav`);
    fs.writeFileSync(tmp, Buffer.concat([wavHeader(fmt, bytes), ...chunks]));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '64k', outFile]);
    fs.rmSync(tmp);
    return starts;
  }

  return { key: speaker.key, name: speaker.name, credit: speaker.credit, render };
}

// 今回使わなかった古い音声を消して、キャッシュが膨らまないようにする
// 時間切れの回は、まだ見ていないカテゴリの音声を消さないよう何もしない
function pruneCache() {
  if (!CACHE_DIR || !fs.existsSync(CACHE_DIR) || timedOut) return { kept: usedCacheFiles.size, removed: 0 };
  let removed = 0;
  for (const name of fs.readdirSync(CACHE_DIR)) {
    if (!usedCacheFiles.has(name)) { fs.rmSync(path.join(CACHE_DIR, name)); removed++; }
  }
  return { kept: usedCacheFiles.size, removed };
}

module.exports = { connect, createVoice, pruneCache };
