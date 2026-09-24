// 主要ニュース3本をWindowsの通知で出す。タスクスケジューラから毎朝実行する想定。
// 通知をクリックするとアプリ (サーバーが動いていれば) か NHK ニュースを開く。
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchCategory, pickBrief } = require('./lib/news');

const APP_URL = process.env.NEWS_APP_URL || 'http://localhost:3000';

function xmlEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

async function appIsRunning() {
  try {
    const r = await fetch(`${APP_URL}/data/categories.json`,{ signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  const { items } = await fetchCategory('top');
  const brief = pickBrief(items);
  if (!brief.length) return;

  const d = new Date();
  const heading = `今日のニュース ${d.getMonth() + 1}/${d.getDate()}`;
  const body = brief.map((b) => `・${b.title}`).join('\n');
  const launch = (await appIsRunning()) ? APP_URL : 'https://news.web.nhk/newsweb/';

  const toastXml = `<toast activationType="protocol" launch="${xmlEsc(launch)}" scenario="default">
  <visual><binding template="ToastGeneric">
    <text>${xmlEsc(heading)}</text>
    <text>${xmlEsc(body)}</text>
  </binding></visual>
</toast>`;

  // PowerShell 5.1 から WinRT の通知APIを呼ぶ (差出人は PowerShell として表示される)
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml(@'
${toastXml}
'@)
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;
  const file = path.join(os.tmpdir(), 'todays-news-toast.ps1');
  fs.writeFileSync(file, '﻿' + ps, 'utf8'); // BOM付きでないと PowerShell 5.1 が日本語を読めない
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { stdio: 'inherit' });
  console.log(`${heading}\n${body}`);
}

main().catch((e) => {
  console.error('通知に失敗しました:', e.message);
  process.exit(1);
});
