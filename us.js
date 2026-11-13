// ============================================================
// 米国版（全自動）の画面（2026-11-14）
// 方針：docs/design/2026-11-13_米国版（全自動）の方針.md
// ・東証版とは別のタブ（#tabUs）・別の保存（localStorage の ssgus_〜）。東証版の欄・状態には触らない。
// ・① 取得（/api/us-sources）→ AI 収集プロンプト（ChatGPT などで調べさせる）→ ② 貼付・ファクトチェック
//   → 「ファクトチェック完了」で台本・サムネ案・X投稿文を AI で作る → ③ 動画（場面のデータと台本）→ ④ SNS
// ・数字（指数・値動き・決算の予想と実績・天気）はツールが出す。AI にはプロンプトで渡し、書き換えさせない。
// ・index.html の共通の道具（aiFetch・autoModelChain・autoClip・autoStripCodeFence・AP_COMMON など）を使う。
// ============================================================

const US_STATE_KEY = 'ssgus_state';
const US_SET_KEY = 'ssgus_settings';
const US_DEFAULT_SET = {
  must: 'AAPL MSFT GOOGL AMZN NVDA META TSLA',   // 必ず載せる銘柄（Mag7）
  mcap: 10,        // 決算一覧に載せる時価総額の下限（十億ドル）
  moversCap: 2,    // 変動率の高い銘柄の時価総額の下限（十億ドル）
  max: 16,         // 決算一覧に載せる数（1ページ8銘柄×2）
  eu: 3, ed: -1, su: 1, sd: -0.5,   // 天気の幅（％）：EPS の晴れ／雨、売上の晴れ／雨（たたき台）
  hashtags: '#米国株',
};
// 日本への影響と金利・資産は1つの場面・1つの区切りにまとめた（2026-11-14 すみぽん）
const US_TAG_ASSETS = '日本への影響・金利・資産';
const US_SCRIPT_TAGS = ['オープニング', '米国指数', 'その他の指数', US_TAG_ASSETS, 'ニュース', '個別株', '決算', 'まとめ'];
const US_SCENE_LABEL = { 1: '米国3指数', 2: '米国その他の指数', 3: '日本への影響', 4: '金利・資産' };
const US_EARN_PER_PAGE = 8;

let US = { data: null, report: '', parsed: null, script: '', snsThumb: '', snsX: '', step: '1' };

// ---------- 保存 ----------
function usSettings(){
  let s = {};
  try{ s = JSON.parse(localStorage.getItem(US_SET_KEY) || '{}') || {}; }catch(e){}
  return Object.assign({}, US_DEFAULT_SET, s);
}
function usSaveSettings(){
  const s = {};
  for(const k of Object.keys(US_DEFAULT_SET)){
    const el = document.getElementById('usSet_' + k); if(!el) continue;
    s[k] = typeof US_DEFAULT_SET[k] === 'number' ? (isFinite(parseFloat(el.value)) ? parseFloat(el.value) : US_DEFAULT_SET[k]) : el.value;
  }
  try{ localStorage.setItem(US_SET_KEY, JSON.stringify(s)); }catch(e){}
  if(US.data && US.data.earnings) usRenderEarnings();   // 天気の幅を変えたら表を描き直す
}
function usFillSettings(){
  const s = usSettings();
  for(const k of Object.keys(US_DEFAULT_SET)){ const el = document.getElementById('usSet_' + k); if(el) el.value = s[k]; }
}
function usPersist(){
  const o = { data: US.data, report: US.report, script: US.script, snsThumb: US.snsThumb, snsX: US.snsX, step: US.step, cal: US.cal || null };
  try{ localStorage.setItem(US_STATE_KEY, JSON.stringify(o)); }catch(e){ console.warn('米国版の保存に失敗', e); }
}
function usRestore(){
  try{ const o = JSON.parse(localStorage.getItem(US_STATE_KEY) || 'null'); if(o) Object.assign(US, o); }catch(e){}
  US.parsed = US.report ? usParseReport(US.report) : null;
}
function usReset(){
  if(!confirm('米国版の作業（取得データ・レポート・台本・投稿文）を消して最初からにします。よろしいですか？')) return;
  US = { data: null, report: '', parsed: null, script: '', snsThumb: '', snsX: '', step: '1' };
  try{ localStorage.removeItem('ssgus_video'); }catch(e){}
  usPersist(); usRenderAll(); usStep('1');
}

// ---------- 工程 ----------
function usStep(k){
  US.step = k;
  document.querySelectorAll('#tabUs .us-step').forEach(c => c.classList.toggle('current', c.dataset.step === k));
  document.querySelectorAll('#usPills .astep-pill').forEach(p => p.classList.toggle('active', p.dataset.k === k));
  window.scrollTo(0, 0);
  if(k === 'v') usRenderVideo();
  // ③動画・④SNS（書き出しのボタンは部品が置く）を開いたら、前に作った動画のデータがあれば読み込む（AI・読み上げは呼ばない）
  if((k === 'v' || k === 'n') && typeof usVidOpen === 'function'){ try{ usVidOpen(); }catch(e){ console.warn(e); } }
  usPersist();
}
function usStatus(id, msg, cls){
  const el = document.getElementById(id); if(!el) return;
  el.textContent = msg || '';
  el.style.color = cls === 'error' ? '#f87171' : cls === 'ok' ? '#4ade80' : 'var(--muted)';
}

// ---------- 数字の表し方 ----------
const usN = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v))) ? null : Number(v);
function usFmt(v, d = 2){ v = usN(v); return v === null ? '－' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function usPct(v){ v = usN(v); return v === null ? '－' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }
function usSign(v, d = 2){ v = usN(v); return v === null ? '－' : (v > 0 ? '+' : '') + usFmt(v, d); }
function usCls(v){ v = usN(v); return v === null || v === 0 ? '' : v > 0 ? 'pos' : 'neg'; }
// 売上（ドル）→「185.2億ドル」
function usRev(v){ v = usN(v); if(v === null) return '－'; const oku = v / 1e8; return (oku >= 100 ? Math.round(oku).toLocaleString('en-US') : oku.toFixed(1)) + '億ドル'; }
function usCap(v){ v = usN(v); if(v === null) return '－'; const cho = v / 1e12; return cho >= 1 ? cho.toFixed(2) + '兆ドル' : Math.round(v / 1e8).toLocaleString('en-US') + '億ドル'; }
function usDateJa(iso){ const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); if(!m) return iso || ''; const d = new Date(iso + 'T12:00:00Z'); return `${+m[2]}月${+m[3]}日（${'日月火水木金土'[d.getUTCDay()]}）`; }
const US_W_ICON = { '晴れ': '☀️', '曇り': '☁️', '雨': '☔' };
const usW = (w) => w ? (US_W_ICON[w] || '') + w : '－';
const US_TIMING = { reacted: '当日の値動き', afterhours: '引け後（時間外）' };
function usHourJa(r){
  if(r.hourUnknown) return '時間不明';
  if(r.session === 'afterhours') return '当日引け後';
  if(r.hour === 'amc') return '前日引け後';
  if(r.hour === 'bmo') return '寄り前';
  return '場中';
}

// ---------- 日本語の社名（株探の米国株から取る。2026-11-14 すみぽん「日本語表記にしてくれないとわからない」）----------
// 一度取った名前はブラウザに残す（ssgus_names）。取れなかった銘柄は AI の nameJa、それも無ければ英語名
const US_NAMES_KEY = 'ssgus_names';
let US_NAMES = (() => { try{ return JSON.parse(localStorage.getItem(US_NAMES_KEY) || '{}') || {}; }catch(e){ return {}; } })();
function usJa(sym, fallback){ return US_NAMES[String(sym || '').toUpperCase()] || fallback || ''; }
async function usFetchNames(){
  const d = US.data; if(!d) return;
  const v = d.movers || {};
  const all = [...((d.earnings && d.earnings.rows) || []).map(r => r.symbol), ...(v.gainers || []).slice(0, 15).map(q => q.symbol), ...(v.losers || []).slice(0, 15).map(q => q.symbol), ...(v.actives || []).slice(0, 15).map(q => q.symbol)];
  const need = [...new Set(all.map(s => String(s || '').toUpperCase()))].filter(s => s && !US_NAMES[s]);
  if(!need.length) return;
  const chunks = []; for(let i = 0; i < need.length; i += 40) chunks.push(need.slice(i, i + 40));
  const res = await Promise.all(chunks.map(c => fetch('/api/us-sources?part=names&symbols=' + encodeURIComponent(c.join(',')), { cache: 'no-store' }).then(r => r.json()).catch(() => ({}))));
  for(const r of res) Object.assign(US_NAMES, (r && r.names) || {});
  try{ localStorage.setItem(US_NAMES_KEY, JSON.stringify(US_NAMES)); }catch(e){}
}

// ---------- 天気（サーバーの weatherOf と同じ決め方。AI が補った実績でも同じ計算をする）----------
function usWeather(act, est, kind, th){
  act = usN(act); est = usN(est);
  if(act === null || est === null) return { weather: null, diffPct: null };
  if(kind === 'eps' && Math.abs(est) < 0.1) return { weather: act > est ? '晴れ' : act < est ? '雨' : '曇り', diffPct: null, bySign: true };
  if(est === 0) return { weather: null, diffPct: null };
  const p = (act - est) / Math.abs(est) * 100;
  const [up, down] = kind === 'eps' ? [th.eu, th.ed] : [th.su, th.sd];
  return { weather: p >= up ? '晴れ' : p < down ? '雨' : '曇り', diffPct: Math.round(p * 100) / 100 };
}
// AI が補った実績が予想と桁違いでないか（単位の取り違えを使わない）
function usSaneActual(act, est, kind){
  act = usN(act); est = usN(est);
  if(act === null) return false;
  if(est === null || est === 0) return kind === 'eps' ? Math.abs(act) < 100 : act > 1e6;
  const r = act / est;
  return kind === 'rev' ? (r > 0.5 && r < 2) : Math.abs(act - est) <= Math.max(1, Math.abs(est) * 2);
}

// ---------- ① 取得 ----------
async function usFetch(btn){
  const s = usSettings();
  const date = (document.getElementById('usDate') || {}).value || '';
  const q = (o) => new URLSearchParams(Object.assign(date ? { date } : {}, o)).toString();
  const must = String(s.must || '').split(/[\s,、]+/).filter(Boolean).join(',');
  if(btn) btn.disabled = true;
  usStatus('usFetchStatus', '取得中…（指数・決算・変動率の高い銘柄）');
  try{
    const get = async (o) => { const r = await fetch('/api/us-sources?' + q(o), { cache: 'no-store' }); const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` })); if(!r.ok && !j.error) j.error = `HTTP ${r.status}`; return j; };
    const calP = usFetchCalendar();   // 休みのカレンダー（確定／取引中の判定に使う）
    const [m, e, v] = await Promise.all([
      get({ part: 'markets' }),
      get({ part: 'earnings', must, mcap: s.mcap, max: s.max, eu: s.eu, ed: s.ed, su: s.su, sd: s.sd }),
      get({ part: 'movers', mcap: s.moversCap }),
    ]);
    const err = [m, e, v].filter(x => !x.ok).map(x => x.error).filter(Boolean);
    if(!m.markets && !e.earnings) throw new Error(err.join(' / ') || '取得できませんでした');
    US.data = { fetchedAt: new Date().toISOString(), targetDate: m.targetDate || e.targetDate, prevDate: m.prevDate || e.prevDate, markets: m.markets || null, earnings: e.earnings || null, movers: v.movers || null };
    await calP;
    usPersist(); usRenderAll();
    usStatus('usFetchStatus', '日本語の社名を取得中…（株探）');
    await usFetchNames().catch(() => {});
    usRenderAll();
    const warn = [...err, ...((m.markets || {}).errors || []), ...((e.earnings || {}).errors || []), ...((v.movers || {}).errors || [])];
    usStatus('usFetchStatus', (warn.length ? '⚠ ' + warn.join(' / ') : '✅ 取得しました') + `（対象日 ${usDateJa(US.data.targetDate)}）`, warn.length ? '' : 'ok');
  }catch(err){
    usStatus('usFetchStatus', '❌ ' + err.message, 'error');
  }finally{ if(btn) btn.disabled = false; }
}

function usRenderAll(){
  usRenderMarkets(); usRenderEarnings(); usRenderMovers(); usRenderReport();
  const sc = document.getElementById('usScript'); if(sc) sc.value = US.script || '';
  const st = document.getElementById('usSnsThumb'); if(st) st.value = US.snsThumb || '';
  const sx = document.getElementById('usSnsX'); if(sx) sx.value = US.snsX || '';
  const fc = document.getElementById('usReport'); if(fc && fc.value !== US.report) fc.value = US.report || '';
  const info = document.getElementById('usDateInfo');
  if(info) info.textContent = US.data ? `対象日：${usDateJa(US.data.targetDate)}（米国）・取得 ${new Date(US.data.fetchedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '';
}

function usRenderMarkets(){
  const el = document.getElementById('usMarkets'); if(!el) return;
  const m = US.data && US.data.markets;
  if(!m || !m.markets){ el.innerHTML = ''; return; }
  const rows = [];
  for(const sc of [1, 2, 3, 4]){
    rows.push(`<tr><th colspan="4" class="us-sec">${sc}. ${US_SCENE_LABEL[sc]}</th></tr>`);
    if(sc === 3 && m.nikkeiFutures){
      const f = m.nikkeiFutures;
      rows.push(`<tr><td>日経先物（${autoEsc(f.source)}）</td><td class="num">${usFmt(f.value, 0)}</td><td class="num ${usCls(f.vsNk225)}">日経平均比 ${usSign(f.vsNk225, 0)}</td><td class="mut">${usFixed('futures') ? '確定' : '取引中'}・${autoEsc(f.time || '')}${f.note ? '・' + autoEsc(f.note) : ''}</td></tr>`);
    }
    for(const r of m.markets.filter(x => x.scene === sc)){
      const chg = r.key === 'us10y' && r.changeBp !== undefined ? `${usSign(r.changeBp, 1)}bp` : usSign(r.change);
      rows.push(`<tr><td>${autoEsc(r.name)}</td><td class="num">${r.error ? '－' : usFmt(r.value, r.key === 'usdjpy' || r.key === 'us10y' ? 3 : 2)}${r.unit === '%' ? '%' : ''}</td><td class="num ${usCls(r.pct)}">${r.error ? autoEsc(r.error) : chg + '（' + usPct(r.pct) + '）'}</td><td class="mut">${r.error ? '' : (usFixed(r.key) ? '確定・' : '取引中・')}${autoEsc(r.source || '')}${r.note ? '・' + autoEsc(r.note) : ''}</td></tr>`);
    }
  }
  const c = US.cal;
  const calNote = c ? `休みのカレンダー：${autoEsc(c.until || '')} まで（米国＝${autoEsc((c.sources || {}).usHolidays || '')}・日本＝${autoEsc((c.sources || {}).jpHolidays || '')}・祝日取引＝${autoEsc((c.sources || {}).holidayTrading || '')}）${(c.errors || []).length ? '　⚠ ' + autoEsc(c.errors.join(' / ')) : ''}` : '⚠ 休みのカレンダーが取れていません（土日だけで判定しています）';
  el.innerHTML = `<table class="us-tbl">${rows.join('')}</table><div class="mut" style="margin-top:4px;">「確定」＝取った時点で取引が止まっている値（台本で数字を読んでよい）。「取引中」＝動いている可能性がある値（台本では方向と％だけ）。${calNote}</div>`;
}

// 決算の行に、AI が補った実績と天気・ガイダンス・コメントを重ねる
// useAi=false：ツールが取った値だけ（AI 収集プロンプト・ファクトチェックの指示には、AI の答えを混ぜない）
function usEarnRows(useAi = true){
  const e = US.data && US.data.earnings; if(!e || !e.rows) return [];
  const th = usSettings();
  const ai = {}, rank = {};
  // 決算一覧に載せる銘柄は AI が選ぶ（2026-11-14 すみぽん）。AI の earnings の並び＝載せる順。候補に無い銘柄と、載せる数を超えた分は使わない
  if(useAi){
    const have = new Set(e.rows.map(r => r.symbol));
    for(const a of ((US.parsed && US.parsed.earnings) || [])){
      const sym = a && a.symbol ? String(a.symbol).toUpperCase().trim() : '';
      if(!sym || !have.has(sym) || ai[sym]) continue;
      ai[sym] = a;
      if(Object.keys(rank).length < usMaxEarn()) rank[sym] = Object.keys(rank).length;
    }
  }
  return e.rows.map(r => {
    const a = ai[r.symbol] || {};
    const eps = Object.assign({}, r.eps), rev = Object.assign({}, r.revenue);
    const filled = [];
    if(eps.actual === null && usSaneActual(a.epsActual, eps.estimate, 'eps')){ eps.actual = usN(a.epsActual); filled.push('EPS'); }
    if(rev.actual === null && usSaneActual(a.revenueActual, rev.estimate, 'rev')){ rev.actual = usN(a.revenueActual); filled.push('売上'); }
    Object.assign(eps, usWeather(eps.actual, eps.estimate, 'eps', th));
    Object.assign(rev, usWeather(rev.actual, rev.estimate, 'rev', th));
    const g = String(a.guidance || '').trim();
    return Object.assign({}, r, {
      eps, revenue: rev, nameJa: usJa(r.symbol, a.nameJa || ''), comment: a.comment || '',
      guidance: US_W_ICON[g] ? g : null, guidanceSource: a.guidanceSource || '',
      aiFilled: filled, actualSource: filled.length ? (a.actualSource || '') : '', epsBasis: a.epsBasis || '',
      picked: rank[r.symbol] !== undefined, aiRank: rank[r.symbol] ?? null,
    });
  });
}
// 決算一覧に載せる銘柄（AI が選んだもの）を、AI が並べた順に
function usPickedEarn(){ return usEarnRows().filter(r => r.picked).sort((a, b) => a.aiRank - b.aiRank); }
// 決算一覧に載せる数（⚙設定の「載せる数」。1ページ8銘柄×2まで）
function usMaxEarn(){ return Math.max(1, Math.min(US_EARN_PER_PAGE * 2, Math.round(usSettings().max) || US_EARN_PER_PAGE * 2)); }

function usRenderEarnings(){
  const el = document.getElementById('usEarnings'); if(!el) return;
  const e = US.data && US.data.earnings;
  if(!e){ el.innerHTML = ''; return; }
  const rows = usEarnRows().sort((a, b) => (a.picked === b.picked ? (a.aiRank ?? 0) - (b.aiRank ?? 0) : a.picked ? -1 : 1));
  const head = `<tr><th title="AI が選んだ順（②にレポートを貼ると出ます）">載せる</th><th>銘柄</th><th>時価総額</th><th>発表</th><th>当日</th><th>時間外</th><th>EPS（予想→実績）</th><th>売上（予想→実績）</th><th>ガイダンス</th><th>コメント（AI）</th></tr>`;
  const body = rows.map(r => {
    const fill = (k) => r.aiFilled.includes(k) ? '<span class="us-ai" title="AI が決算発表から補った実績">AI</span>' : '';
    return `<tr class="${r.picked ? '' : 'us-off'}">
      <td class="num">${r.picked ? (r.aiRank + 1) : '－'}</td>
      <td><b>${autoEsc(r.symbol)}</b>${r.must ? ' <span class="us-must">必ず</span>' : ''}<br>${autoEsc(r.nameJa || r.name)}</td>
      <td class="num">${usCap(r.mcap)}</td>
      <td>${usHourJa(r)}<br><span class="mut">${autoEsc(r.reportDate || '')}</span></td>
      <td class="num ${usCls(r.dayPct)}">${usPct(r.dayPct)}</td>
      <td class="num ${usCls(r.afterPct)}">${usPct(r.afterPct)}${r.afterTime ? `<br><span class="mut">${autoEsc(r.afterTime)}時点</span>` : ''}</td>
      <td>${usFmt(r.eps.estimate)} → ${usFmt(r.eps.actual)}${fill('EPS')}<br>${usW(r.eps.weather)}${r.eps.diffPct !== null && r.eps.diffPct !== undefined ? `（${usPct(r.eps.diffPct)}）` : ''}</td>
      <td>${usRev(r.revenue.estimate)} → ${usRev(r.revenue.actual)}${fill('売上')}<br>${usW(r.revenue.weather)}${r.revenue.diffPct !== null && r.revenue.diffPct !== undefined ? `（${usPct(r.revenue.diffPct)}）` : ''}</td>
      <td>${usW(r.guidance)}</td>
      <td class="us-cmt">${autoEsc(r.comment)}</td></tr>`;
  }).join('');
  const picked = rows.filter(r => r.picked).length;
  const note = [`決算 ${e.totalReports || 0} 件のうち、候補 ${rows.length} 件（時価総額 ${Math.round(usSettings().mcap * 10)}億ドル以上と、必ず載せる銘柄）。` + (US.parsed ? `AI が選んだのは ${picked} 件（最大 ${usMaxEarn()}）` : '載せる銘柄は AI が選びます（AI収集プロンプト → ②に貼付）')];
  if(!e.finnhub) note.push('⚠ Finnhub が使えないため、売上と EPS の実績・寄り前／引け後が入っていません');
  el.innerHTML = `<div class="mut" style="margin:4px 0;">${note.join('<br>')}</div><div class="us-scroll"><table class="us-tbl">${head}${body}</table></div>`;
}

function usRenderMovers(){
  const el = document.getElementById('usMovers'); if(!el) return;
  const v = US.data && US.data.movers;
  if(!v){ el.innerHTML = ''; return; }
  const list = (k, t) => `<div><b>${t}</b>${(v[k] || []).slice(0, 15).map(q => `<div class="us-mv"><span>${autoEsc(q.symbol)}</span><span class="mut">${autoEsc((usJa(q.symbol) || q.name || '').slice(0, 22))}</span><span class="num ${usCls(q.pct)}">${usPct(q.pct)}</span></div>`).join('')}</div>`;
  el.innerHTML = `<div class="mut" style="margin:4px 0;">時価総額 ${Math.round((v.minCap || 0) / 1e8)}億ドル以上・${autoEsc(v.asOf || '')}時点（場面には出さず、AI が個別株を選ぶ材料にする）</div><div class="us-mvs">${list('gainers', '値上がり')}${list('losers', '値下がり')}${list('actives', '売買が多い')}</div>`;
}

// ---------- 数字を読んでよいか（確定／取引中）の決まり（2026-11-14 すみぽん）----------
// 台本で細かい数字まで読んでよいのは、データを取った時点で取引が止まっていて、動画を見るときも変わらない値だけ。
//   米国の指数（ダウ・S&P500・ナスダック・SOX・ラッセル2000・VIX）… 対象日の終値なので、いつでも確定
//   日経平均先物（大阪）… 取引しているのは、取引のある日の 8:45〜15:45 と、その日の 17:00〜翌朝 6:00（日本時間）。それ以外は確定。
//       取引のある日＝平日。ただし日本の祝日と 12/31〜1/3 は、JPX の「祝日取引」を実施する日だけ
//   米10年債・金・原油 … 取引しているのは、米国の取引のある日の 17:00 まで（ニューヨーク時間）と、翌日が取引のある日の 17:00 から（17:00〜18:00 の毎日の休み時間は、すぐ再開するので止まっている扱いにしない）。それ以外は確定
//       取引のある日＝平日で、米国の休場日（NYSE）でない日。休場日は金・原油の電子取引が動いていることがあるが、止まっている扱いにする
//   ドル円 … 週末（ニューヨークの金曜 17:00〜日曜 17:00）と、元日・クリスマス（1/1・12/25）は確定。米国の休場日でも為替は動くので取引中
//   ビットコイン … 週末も休日も動くので、いつでも取引中
//   時間外の株価 … 取った時点の値。米国の20時（日本時間 朝9時か10時）まで動くので取引中
// 休みの日は /api/market-calendar（サーバーに保管したカレンダー。US.cal）で見る。カレンダーが無いときは土日だけで判定する
function usDow(isoDate){ return new Date(isoDate + 'T12:00:00Z').getUTCDay(); }
function usAddDays(isoDate, n){ return new Date(Date.parse(isoDate + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
// その場所の日付と、0時からの分
function usLocal(at, tz){
  const p = {}; for(const x of new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute };
}
// 大阪の先物の取引がある日か
function usOsakaDay(d){
  const w = usDow(d); if(w === 0 || w === 6) return false;
  const jp = (US.cal && US.cal.jp) || {};
  const closed = (jp.holidays || []).includes(d) || /-(12-31|01-01|01-02|01-03)$/.test(d);
  return closed ? (jp.holidayTrading || {})[d] === true : true;
}
// 米国の取引がある日か（NYSE）
function usNyDay(d){
  const w = usDow(d); if(w === 0 || w === 6) return false;
  return !(((US.cal && US.cal.us) || {}).holidays || []).includes(d);
}
function usFixed(key, at){
  if(['dji', 'spx', 'ixic', 'sox', 'rut', 'vix'].includes(key)) return true;
  if(key === 'btc') return false;
  const when = at || (US.data && US.data.fetchedAt) || Date.now();
  if(key === 'futures'){
    const t = usLocal(when, 'Asia/Tokyo');
    const open = (usOsakaDay(t.date) && ((t.min >= 525 && t.min < 945) || t.min >= 1020)) || (t.min < 360 && usOsakaDay(usAddDays(t.date, -1)));
    return !open;
  }
  const t = usLocal(when, 'America/New_York');
  if(key === 'usdjpy'){
    const fxDay = (d) => { const w = usDow(d); return w !== 0 && w !== 6 && !/-(01-01|12-25)$/.test(d); };
    return !((fxDay(t.date) && t.min < 1020) || (t.min >= 1020 && fxDay(usAddDays(t.date, 1))));
  }
  // us10y・gold・wti。17:00〜18:00 の毎日の休み時間は、すぐ再開するので止まっている扱いにしない
  return !((usNyDay(t.date) && t.min < 1020) || (t.min >= 1020 && usNyDay(usAddDays(t.date, 1))));
}
// カレンダーを取る（サーバーが保管している。期限が近ければサーバーが取り直す）。取れなければ前のものを使う
async function usFetchCalendar(){
  try{
    const r = await fetch('/api/market-calendar', { cache: 'no-store' }); const c = await r.json();
    if(c && c.ok && c.jp && c.us){ US.cal = { fetchedAt: c.fetchedAt, until: c.until, jp: c.jp, us: c.us, sources: c.sources, errors: c.errors || [] }; usPersist(); }
  }catch(e){ console.warn('カレンダーを取れませんでした', e); }
}
// 取った時刻（日本時間）「11/14 7:02」
function usFetchedJst(){
  const t = new Date(new Date((US.data && US.data.fetchedAt) || Date.now()).getTime() + 9 * 3600 * 1000);
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()} ${t.getUTCHours()}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

// ---------- AI に渡すデータ（文）----------
function usDataText(opt = {}){
  const d = US.data; if(!d) return '';
  const L = [];
  L.push(`対象日：${d.targetDate}（米国東部時間の営業日）。前営業日：${d.prevDate || '－'}`);
  const m = d.markets;
  if(m && m.markets){
    L.push('\n【指数・為替・金利・商品（対象日の終値と前日比）】');
    for(const r of m.markets){
      if(r.error) continue;
      const chg = r.key === 'us10y' ? `${usSign(r.changeBp, 1)}bp（${usPct(r.pct)}）` : `${usSign(r.change)}（${usPct(r.pct)}）`;
      // 台本用（withAi）には、数字を読んでよいか（確定／取引中）の印を付ける
      const mark = opt.withAi ? (usFixed(r.key) ? '【確定】' : '【取引中】') : '';
      L.push(`${r.name}：${usFmt(r.value, r.key === 'us10y' ? 3 : 2)}${r.key === 'us10y' ? '%' : ''} ${chg}${r.source === '日経' ? `（${r.time}時点）` : ''}${mark}`);
    }
    const f = m.nikkeiFutures;
    if(f) L.push(`日経平均先物（${f.source}）：${usFmt(f.value, 0)}円${opt.withAi ? '' : `（${f.time}時点）`}。日経平均の前日終値 ${usFmt(f.nk225Close, 0)}円より ${usSign(f.vsNk225, 0)}円${opt.withAi ? (usFixed('futures') ? '【確定】' : '【取引中】') : ''}`);
  }
  // 収集プロンプト（AI が選ぶ前）には候補すべて、台本など（選んだあと）には AI が選んだ銘柄を選んだ順に
  const rows = opt.withAi ? usPickedEarn() : usEarnRows(false);
  if(rows.length){
    L.push(opt.withAi ? '\n【決算一覧に載せる銘柄】（載せる順。値動きは％、EPS はドル、売上はドル）' : '\n【決算銘柄（候補）】（ツールが取得。時価総額の大きい順。値動きは％、EPS はドル、売上はドル）');
    for(const r of rows){
      const eps = `EPS 予想 ${usFmt(r.eps.estimate)}・実績 ${r.eps.actual === null ? '実績なし' : usFmt(r.eps.actual)}${r.eps.weather ? '（' + r.eps.weather + '）' : ''}`;
      const rev = `売上 予想 ${r.revenue.estimate === null ? '－' : Math.round(r.revenue.estimate)}・実績 ${r.revenue.actual === null ? '実績なし' : Math.round(r.revenue.actual)}${r.revenue.weather ? '（' + r.revenue.weather + '）' : ''}`;
      // 台本用には時刻を渡さない（台本に時刻を入れさせない。時刻は画面の注記に出す）。時間外は取引中の値
      const mv = r.session === 'afterhours' ? `当日 ${usPct(r.dayPct)}${opt.withAi ? '【確定】' : ''}・時間外 ${usPct(r.afterPct)}${opt.withAi ? '【取引中】' : (r.afterTime ? '（日本時間 ' + r.afterTime + '時点）' : '')}` : `当日 ${usPct(r.dayPct)}${opt.withAi ? '【確定】' : ''}`;
      L.push(`${r.symbol}${!opt.withAi && r.must ? '【必ず載せる】' : ''}（${r.nameJa ? r.nameJa + '／' : ''}${r.name}、時価総額 ${usCap(r.mcap)}）：${usHourJa(r)}の決算（${r.reportDate}）。${mv}。${eps}。${rev}${opt.withAi && r.guidance ? `。ガイダンス ${r.guidance}` : ''}${opt.withAi && r.comment ? `。コメント：${r.comment}` : ''}`);
    }
  }
  const v = d.movers;
  if(v && !opt.noMovers){
    L.push(`\n【変動率の高い銘柄（候補）】（時価総額 ${Math.round((v.minCap || 0) / 1e8)}億ドル以上。${v.asOf}時点）`);
    const one = (q) => `${q.symbol}（${usJa(q.symbol) ? usJa(q.symbol) + '／' : ''}${q.name}）${usPct(q.pct)}`;
    L.push('値上がり率：' + (v.gainers || []).slice(0, 15).map(one).join('、'));
    L.push('値下がり率：' + (v.losers || []).slice(0, 15).map(one).join('、'));
    L.push('売買の多い銘柄：' + (v.actives || []).slice(0, 10).map(one).join('、'));
  }
  return L.join('\n');
}

// ---------- AI 収集プロンプト（ChatGPT などのウェブ検索で調べさせる）----------
const US_COLLECT_PROMPT = `{{date}}（米国東部時間）の米国株式市場について、以下の１〜４を調べ、最後の形式の JSON で出力してください。
・数字（指数・株価の値動き・決算の予想と実績）は、下の【ツールが取得したデータ】を正しいものとして扱い、調べた数字で書き換えないでください。
・ニュースは英語・日本語どちらのソースでも構いません。出力は日本語にしてください。

１．市場全体のニュース（marketNews：3〜5本）
・{{date}}の米国株式市場全体に影響したニュース（経済指標、FRB・金利、政策、地政学、主要企業の動きなど）。
・{{date}}の米国の取引終了（米国東部時間 16:00）までに出たものに限る。
・特定の1銘柄だけの材料（決算・個別の値動き）は、ここではなく「２．個別株の材料」に書く。
・title は全角30文字以内、detail は全角90文字以内。source に出典の URL。

２．個別株の材料（stockNews：最大5銘柄）
・【変動率の高い銘柄（候補）】と【決算銘柄（候補）】の中から、値動きの具体的な理由が確認できた銘柄だけを選ぶ（プレスリリース、決算発表、投資判断や目標株価の変更、M&A、規制・訴訟、業界の重要ニュースなど）。
・理由が確認できない銘柄、{{date}}より1週間以上前の材料しかない銘柄は載せない。除外した銘柄には一切触れない。
・「市場全体の調整」「理由は不明」などのあいまいな記載は禁止。
・時価総額の大きい銘柄・話題性の高い銘柄を優先する。5銘柄に満たなければ、ある分だけでよい。
・決算銘柄を選んだ場合も、決算の数字ではなく「なぜ動いたか」を書く。
・「１．市場全体のニュース」と内容を重ねない。同じ出来事・同じ銘柄の話を両方に書かない（特定の銘柄の話は個別株の材料に書き、市場全体のニュースには経済指標・金利・政策など市場全体の話を書く）。
・headline は全角20文字以内、detail は全角40文字以内。source に出典の URL。

３．決算一覧に載せる銘柄を選び、コメントとガイダンスを書く（earnings：最大{{max}}銘柄）
・【決算銘柄（候補）】の中から、動画の決算一覧に載せる銘柄を最大{{max}}銘柄選ぶ。少ない日は、ある分だけでよい。数を埋めるために注目度の低い銘柄を入れない。
・載せるほどの銘柄が無い日は、earnings を空（[]）にする（動画では決算一覧の場面を飛ばす）。
・選ぶ基準：日本の個人投資家の関心が高い銘柄を優先する。時価総額が大きい、値動きが大きい（当日の引け後に発表した銘柄は時間外の値動きで見る）、予想との差（サプライズ）やガイダンスが話題になった、業界や市場全体への影響が大きい、のいずれかに当てはまるもの。
・【必ず載せる】と書いた銘柄は、決算の発表が確認できれば必ず選ぶ。
・earnings は載せる順に並べる（注目度の高い順。1〜8番目が1ページ目、9番目以降が2ページ目）。選ばなかった銘柄は earnings に入れない。
・symbol は【決算銘柄（候補）】のティッカーをそのまま書く（候補に無い銘柄は選ばない）。
・comment：何が良かった／悪かったかを全角25文字程度で。主な数字（EPS・売上の実績と予想、成長率など）を入れてよい。ガイダンスの上方修正・下方修正があった場合は必ず触れる。
・guidance：会社の見通し（次の四半期・通期）を次の4つで判定する。
  晴れ＝上方修正、または見通しが市場予想を上回った
  曇り＝据え置き、またはほぼ市場予想どおり
  雨＝下方修正、または見通しが市場予想を下回った
  －＝ガイダンスを出していない、または確認できなかった
・guidanceSource：判定の根拠にした出典の URL（会社の決算発表・IR を優先）。
・選んだ銘柄のうち、【決算銘柄（候補）】で「実績なし」と書いた銘柄だけ、会社の決算発表（プレスリリース・SEC の 8-K・IR ページ）から実績を拾う。ニュース記事やまとめサイトの数字は使わない。
  - EPS は調整後（Non-GAAP）を使う。会社が調整後を出していなければ GAAP を使い、epsBasis に "GAAP" と書く。
  - 売上はドル単位の数値で書く（例：185億2000万ドルなら 18520000000）。
  - actualSource に出典の URL を必ず付ける。拾えなければ null のまま（推測で埋めない）。
  - 実績が入っている銘柄は epsActual・revenueActual を null のままにする。
・決算の発表が確認できない（延期など）銘柄は選ばない。

４．銘柄名
・nameJa には、【ツールが取得したデータ】に日本語の社名（「／」の前）があればそのまま書く。無い銘柄だけ、日本で一般的なカタカナの社名を書く（例：エヌビディア、アップル）。

【出力】次の形の JSON だけを出力してください。
{
  "marketNews": [ { "title": "", "detail": "", "source": "URL" } ],
  "stockNews": [ { "symbol": "ティッカー", "nameJa": "", "headline": "", "detail": "", "source": "URL" } ],
  "earnings": [ { "symbol": "ティッカー", "nameJa": "", "comment": "", "guidance": "晴れ|曇り|雨|－", "guidanceSource": "URL", "epsActual": null, "revenueActual": null, "epsBasis": "調整後|GAAP", "actualSource": "URL" } ]
}

【ツールが取得したデータ】
{{data}}`;

function usCollectPromptText(){
  if(!US.data){ alert('先に「データ取得」を押してください'); return ''; }
  return US_COLLECT_PROMPT.replace(/\{\{date\}\}/g, usDateJa(US.data.targetDate)).replace(/\{\{max\}\}/g, usMaxEarn()).replace('{{data}}', usDataText()) + (typeof AP_CODEBLOCK_NOTE === 'string' ? AP_CODEBLOCK_NOTE : '');
}
function usCopyCollect(btn){ const t = usCollectPromptText(); if(t){ autoClip(t, btn); usStep('2'); } }

// ---------- ② レポート ----------
function usParseReport(text){
  const t = (typeof autoStripCodeFence === 'function' ? autoStripCodeFence(text).text : String(text || '')).trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if(a < 0 || b <= a) return null;
  try{
    const o = JSON.parse(t.slice(a, b + 1));
    return { marketNews: Array.isArray(o.marketNews) ? o.marketNews : [], stockNews: Array.isArray(o.stockNews) ? o.stockNews : [], earnings: Array.isArray(o.earnings) ? o.earnings : [] };
  }catch(e){ return null; }
}
function usReportChanged(){
  US.report = (document.getElementById('usReport') || {}).value || '';
  US.parsed = US.report.trim() ? usParseReport(US.report) : null;
  usPersist(); usRenderReport(); usRenderEarnings();
}
async function usPasteReport(btn){
  const el = document.getElementById('usReport');
  try{ el.value = await navigator.clipboard.readText(); }
  catch(e){ el.focus(); alert('クリップボードを読み取れませんでした。Ctrl+V で貼り付けてください。'); return; }
  usReportChanged();
  if(US.parsed) usCopyFactCheck(btn);   // 東証版と同じく、貼ったらファクトチェックのプロンプトもコピーする
}
function usRenderReport(){
  const el = document.getElementById('usReportView'); if(!el) return;
  if(!US.report.trim()){ el.innerHTML = ''; return; }
  const p = US.parsed;
  if(!p){ el.innerHTML = '<div class="us-err">❌ JSON として読めません。AI の回答の JSON 部分をそのまま貼ってください。</div>'; return; }
  const link = (u) => /^https?:\/\//.test(String(u || '')) ? ` <a href="${autoEsc(u)}" target="_blank" rel="noopener" class="mut">出典</a>` : '';
  const mn = p.marketNews.map(n => `<li><b>${autoEsc(n.title)}</b>${link(n.source)}<br><span class="mut">${autoEsc(n.detail)}</span></li>`).join('');
  const sn = p.stockNews.slice(0, 5).map(n => `<li><b>${autoEsc(usJa(n.symbol, n.nameJa) || n.symbol)}</b>（${autoEsc(n.symbol)}）${autoEsc(n.headline)}${link(n.source)}<br><span class="mut">${autoEsc(n.detail)}</span></li>`).join('');
  const rows = usPickedEarn();
  const ai = rows.filter(r => r.aiFilled.length);
  const miss = rows.filter(r => r.eps.actual === null && r.revenue.actual === null);
  // AI が選ばなかった「必ず載せる」銘柄と、候補に無いため使わなかった銘柄を知らせる
  const cand = new Set(((US.data && US.data.earnings && US.data.earnings.rows) || []).map(r => r.symbol));
  const unknown = p.earnings.map(a => String((a && a.symbol) || '').toUpperCase().trim()).filter(x => x && !cand.has(x));
  const mustOut = usEarnRows().filter(r => r.must && !r.picked).map(r => r.symbol);
  const over = p.earnings.length - rows.length - unknown.length;
  const notes = [`決算一覧に載せる銘柄（AI が選んだ順）：${rows.length ? rows.map(r => r.symbol).join('・') : 'なし（決算一覧の場面は出しません）'}`];
  if(mustOut.length) notes.push(`「必ず載せる」銘柄なのに AI が選ばなかったもの：${mustOut.join('・')}（決算が確認できなかった可能性。必要ならファクトチェックで指摘してください）`);
  if(unknown.length) notes.push(`候補に無いので使わない銘柄：${unknown.join('・')}`);
  if(over > 0) notes.push(`載せる数（${usMaxEarn()}）を超えた ${over} 件は使いません`);
  if(p.stockNews.length > 5) notes.push(`個別株が ${p.stockNews.length} 件あります（先頭の5件を使います）`);
  if(ai.length) notes.push('AI が補った実績：' + ai.map(r => `${r.symbol}（${r.aiFilled.join('・')}・${r.actualSource ? `<a href="${autoEsc(r.actualSource)}" target="_blank" rel="noopener">出典</a>` : '出典なし'}）`).join('、'));
  if(miss.length) notes.push('実績が無い銘柄（天気は「－」）：' + miss.map(r => r.symbol).join('、'));
  el.innerHTML = `<div class="us-rep">
    ${notes.length ? `<div class="us-warn">${notes.join('<br>')}</div>` : ''}
    <div class="a2"><div><b>市場全体のニュース（${p.marketNews.length}本）</b><ol>${mn}</ol></div>
    <div><b>個別株（${Math.min(5, p.stockNews.length)}銘柄）</b><ol>${sn}</ol></div></div>
    <div style="margin-top:6px;"><b>動画に使う決算銘柄（${rows.length}銘柄${rows.length > US_EARN_PER_PAGE ? '・2ページ' : ''}）</b>${rows.length ? '' : '<span class="mut">　なし（決算一覧の場面は出しません）</span>'}</div>
    ${rows.length ? `<div class="us-scroll"><table class="us-tbl"><tr><th>順</th><th>銘柄</th><th>発表</th><th>変動率</th><th>売上</th><th>利益</th><th>ガイダンス</th><th>コメント</th></tr>${rows.map(usEarnRowHtml).join('')}</table></div>` : ''}
    <div class="mut">売上・利益の天気はツールの計算、ガイダンスとコメントは AI です（AI が補った実績には「AI」の印）。候補の全部は ①の決算一覧にあります。</div></div>`;
}
// ②に出す、動画に使う決算銘柄の1行。変動率は動画と同じく1つ（当日の引け後に出した銘柄は時間外＝アフター）
function usEarnRowHtml(r){
  const after = r.session === 'afterhours' && r.afterPct !== null && r.afterPct !== undefined;
  const mv = after ? r.afterPct : r.dayPct;
  const fill = (k) => r.aiFilled.includes(k) ? '<span class="us-ai" title="AI が決算発表から補った実績">AI</span>' : '';
  const diff = (x) => (x.diffPct !== null && x.diffPct !== undefined ? `<br><span class="mut">予想比 ${usPct(x.diffPct)}</span>` : '');
  const src = /^https?:\/\//.test(String(r.guidanceSource || '')) ? ` <a href="${autoEsc(r.guidanceSource)}" target="_blank" rel="noopener" class="mut">出典</a>` : '';
  return `<tr><td class="num">${r.aiRank + 1}</td>
    <td><b>${autoEsc(r.nameJa || r.name)}</b><br><span class="mut">${autoEsc(r.symbol)}</span></td>
    <td>${usHourJa(r)}</td>
    <td class="num ${usCls(mv)}">${usPct(mv)}${after ? '<br><span class="mut">（アフター）</span>' : ''}</td>
    <td>${usW(r.revenue.weather)}${fill('売上')}${diff(r.revenue)}</td>
    <td>${usW(r.eps.weather)}${fill('EPS')}${diff(r.eps)}</td>
    <td>${usW(r.guidance)}${src}</td>
    <td class="us-cmt">${autoEsc(r.comment)}</td></tr>`;
}
function usCopyFactCheck(btn){
  const base = usCollectPromptText().replace(typeof AP_CODEBLOCK_NOTE === 'string' ? AP_CODEBLOCK_NOTE : '', '');
  if(!base) return;
  const report = ((document.getElementById('usReport') || {}).value || '').trim();
  autoClip(`以下のレポートは、以下の指示でAIが生成したものです。\nレポートのファクトチェックを行い、誤っている個所と指示に沿っていない箇所のみを指摘してください。\n指摘は件数が多くても構わないので、すべて指摘してください。\n指摘がある場合には、指摘箇所、指摘内容、修正後内容を記載してください。\nレイアウトや出力形式に関する指摘は不要です。\n\n--指示--\n${base}\n\n--レポート--\n\n${report}`, btn);
}

// ---------- 台本・サムネ案・X投稿文（AI）----------
function usReportText(){
  const p = US.parsed; if(!p) return '';
  const L = ['【市場全体のニュース】'];
  p.marketNews.forEach((n, i) => L.push(`${i + 1}. ${n.title}：${n.detail}`));
  L.push('\n【個別株の材料】');
  p.stockNews.slice(0, 5).forEach(n => L.push(`${usJa(n.symbol, n.nameJa) || n.symbol}（${n.symbol}）：${n.headline}。${n.detail}`));
  return L.join('\n');
}
function usResources(){
  return [
    { label: 'ツールが取得したデータ（指数・決算など）', text: usDataText({ withAi: true, noMovers: true }) },
    { label: 'ニュースと個別株の材料（ファクトチェック済み）', text: usReportText() },
  ];
}
function usScriptPrompt(){
  const C = (typeof AP_COMMON === 'object' && AP_COMMON) || {};
  return `${usDateJa(US.data.targetDate)}の米国株式市場を振り返る動画の台本を、2分前後（900〜1,100文字）で、以下の構成で作成してください。
・日本の個人投資家が、日本時間の朝に見る動画です。
・個人的な感想は添えず、事実を伝えることに専念してください。
・見出しも含めて、メタ情報は記述しないようにしてください。
・【構成】の順番どおりに話してください。資料に無い項目（決算が無い日など）は飛ばしてください。
・機械的な話し方ではなく、人間らしい自然な話し方にしてください。
【構成】
0.オープニング（その日の米国市場で何が起きたかを、1文で言い切る）
1.米国指数（ダウ・S&P500・ナスダック）
2.その他の指数（SOX指数・ラッセル2000・VIX指数）
3.日本への影響・金利・資産（日経平均先物・ドル円・米10年債利回り・金・ビットコイン・原油。画面には全部出るので、全部を読む必要はない。日経平均先物は、日経平均の前日終値より何円高い／安いかを伝えて今日の東京市場の目安にし、ほかは動きの大きかったもの・その日の相場に関わったものだけに触れる。市場全体のニュースの中に、ここの値動きの理由になるもの（金利の上昇・原油高・円安・金やビットコインの動きの理由など）があれば、ここで値動きと一緒に短く説明する。例：「トランプ氏がイランとの交渉を拒否したことで、原油のWTIは2.55％高となりました」）
4.ニュース（市場全体のニュース。3.で値動きと一緒に説明したニュースは、ここではくり返さない。残りのニュースを説明する）
5.個別株（材料のあった銘柄。全部を読まず、注目の銘柄だけでよい）
6.決算（注目の2〜3銘柄だけ。売上・利益・ガイダンスの天気がずれている銘柄（例：売上・利益は予想を上回ったのにガイダンスが弱く売られた）を優先する。米国の決算はガイダンスが弱いと売られやすいことに触れてよい）
7.まとめ（その日の出来事のうち、覚えて帰ってほしい2〜3点を具体的な名前で言い直す）
【文の書き方（迷ったらこの物差しで決める）】
・視聴者は、この日の米国株式市場で何が起きたかを短い時間で知りたい人です。どの文も「その日に起きたこと」を伝える文にしてください。
・物差し1「日付や銘柄名を入れ替えても、そのまま使える文か」。使えるなら、その日の情報が入っていない文です。その日ならではの具体（どの銘柄が・何が理由で・どうなったか）に書き換えるか、削ってください。
  例：×「決算では、見通しの強弱によって株価の明暗が分かれました」（どの日にも言える）→ ○「見通しを引き上げた〇〇は買われ、見通しが予想に届かなかった△△は急落しました」（〇〇・△△は資料の銘柄名）
・物差し2「その文を削っても、視聴者が知ることは減らないか」。減らないなら削ってください。次に何を話すかの予告や、区切りと区切りをつなぐための文（例：「順に見ていきます」）がこれに当たります。区切りは、前置きなしでその区切りの中身から始め、中身を言い終えたらそこで終えてください。
・物差し3「この動画の前提を言い直していないか」。この動画は米国の株式市場だけを扱い、視聴者もそれを知っています。前提は言わず、対象そのもの（指数名・銘柄名・業種名）を主語にしてください。
  例：×「株式が幅広く売られました」→ ○「〇〇株を中心に幅広く売られました」（〇〇は資料から分かる業種や銘柄）
・オープニングは1文だけにし、その日に何が起きたかを言い切って終えてください（その1文がそのまま結論になるように）。
・まとめは、新しいことや一般論を足す場所ではありません。その日の出来事のうち、視聴者に覚えて帰ってほしい2〜3点を、具体的な名前を入れて言い直してください。
・書き終えたら、すべての文を物差し1〜3で読み直し、当てはまる文を直してから出力してください。
【動画の読み上げとして】
・指数や決算の数字は動画の画面に出ます。各区切りの最初の文を「〜では」「〜には」のような、何の話かを示す言い方で始めず、指数名や銘柄名から始めてください。
・数字は全部を読まず、要点になるものだけにしてください。
・ひとつの区切りの中で、同じ内容をくり返し言わないでください。
・オープニングとまとめで日付を言うときは、米国の日付を月日で言ってください（「昨夜」「本日」は使わない）。
・オープニングでは、個別の指数の値動きは言わないでください。
・銘柄名はカタカナの社名で言い、ティッカー（英字の略号）は読まないでください。
・ドルの金額は「1.25ドル」「185億ドル」のように読める形で書いてください。
・時刻は台本に入れないでください（「日本時間8時55分時点」「午前7時時点」などは言わない。時刻は動画の画面に出します）。時間外の値動きは「時間外では4％高」のように、時刻を付けずに言ってください。
【数字の読み方】
・資料の各行の末尾に【確定】か【取引中】を付けてあります。
・【確定】（取引が終わっていて、動画を見るときも変わらない値。米国の指数など）は、終値や値幅などの数字を読んでかまいません。
・【取引中】（動画を見るときには動いている可能性がある値。為替・金利・金・原油・ビットコイン・時間外の株価など）は、細かい数字（価格・値幅・bp）は読まず、「大きく上がった」「下げた」などの方向と大きさだけにしてください。前日比の％は言ってかまいません。
${C.VoiceNote_Principle || ''}${C.VoiceNote_Basic || ''}${C.VoiceNote_tatoe || ''}
【出力の形】
・動画の場面に合わせるため、台本の各部分の前に、次のうち当てはまる区切りを1行で書いてください。この行は読み上げません。
${US_SCRIPT_TAGS.map(t => '[' + t + ']').join(' ')}`;
}
const US_SNS_PROMPT = `あなたはYouTube「米国株マーケット振り返り」動画の担当です。資料を基に、サムネ案とX投稿文を作成してください。

【サムネ案（3本＋最有力）】
・スラッシュ区切りの1行（上段／中段／下段）。上段＝感情・問題提起／中段＝注目銘柄名や注目点／下段＝抽象的な問いかけ。
・「え、なんで？」と思わせるギャップ（例：好決算なのに株価下落、ガイダンスで明暗）を優先。順当な結論は禁止。
・禁止：！ ？ 数値 株価の方向性（上昇/下落の明示） スペース 引用符。1・3段目は全角8〜10文字、2段目は6〜9文字。
・銘柄名はカタカナの社名にする（ティッカーは使わない）。

【X投稿文】
・その日の米国市場がどうだったか（指数の方向・注目された銘柄や決算・主なニュース）と、日本市場への影響（日経平均先物・ドル円）が伝わる要約にすること。
・絵文字を交え、URLとハッシュタグを除いて全角120文字程度。銘柄名を入れて興味を引く。煽り・断定は避ける。
・本文中に銘柄名が出てきたら、その銘柄名の直前に「#」を付けてハッシュタグ化する（「#」の前後には半角スペース）。
・本文中で「#」化した銘柄名は、末尾のハッシュタグには重複して書かない。
・末尾にハッシュタグを2〜5個（テーマ・市場全体に関するものを中心に）。

出力は必ず次の形式（区切り「===」を厳守）:
🎨サムネ案
①上段／中段／下段
②上段／中段／下段
③上段／中段／下段
最有力：①〜③のいずれか（理由）
===
🕊️X投稿文
（本文・絵文字あり）
#ハッシュタグ`;

async function usAi(prompt, resources, cls){
  const res = await aiFetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, resources, temperature: 0.3, models: autoModelChain(cls || 'high') }) });
  const d = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if(!d.ok) throw new Error(d.error || `HTTP ${res.status}`);
  return { text: String(d.text || '').trim(), model: d.model || '' };
}
function usStripBlank(t){ return typeof autoStripBlankLines === 'function' ? autoStripBlankLines(t) : String(t || '').replace(/\n{2,}/g, '\n').trim(); }
function usFixedTags(text){
  const raw = String(usSettings().hashtags || '').trim(); if(!raw) return text;
  const tags = raw.split(/[\s　]+/).filter(Boolean).map(t => t.startsWith('#') ? t : '#' + t);
  const have = new Set(text.match(/#[^\s#　]+/g) || []);
  const add = tags.filter(t => !have.has(t));
  return add.length ? (text.replace(/\s+$/, '') + ' ' + add.join(' ')).trim() : text;
}
async function usGenScript(btn){
  if(!US.data || !US.parsed) throw new Error('先に①データ取得と②レポートの貼付をしてください');
  usStatus('usScriptStatus', `台本を生成中…（${typeof aiName === 'function' ? aiName() : 'AI'}）`);
  const r = await usAi(usScriptPrompt(), usResources(), 'high');
  US.script = usStripBlank(r.text); usPersist();
  const el = document.getElementById('usScript'); if(el) el.value = US.script;
  usStatus('usScriptStatus', `✅ 台本（${usScriptChars()}文字・${r.model}）`, 'ok');
}
async function usGenSns(btn){
  if(!US.data || !US.parsed) throw new Error('先に①データ取得と②レポートの貼付をしてください');
  usStatus('usSnsStatus', 'サムネ案・X投稿文を生成中…');
  const r = await usAi(US_SNS_PROMPT, usResources(), 'high');
  const parts = r.text.split(/\n?===+\n?/);
  US.snsThumb = usStripBlank((parts[0] || '').replace(/^🎨\s*サムネ案\s*/, ''));
  US.snsX = usFixedTags(usStripBlank((parts[1] || '').replace(/^🕊️?\s*X投稿文\s*/, '')));
  usPersist(); usRenderAll();
  usStatus('usSnsStatus', `✅ サムネ案・X投稿文（${r.model}）`, 'ok');
}
async function usRunAll(btn){
  if(!US.data){ alert('先に①データ取得をしてください'); return; }
  if(!US.parsed){ alert('②に AI のレポート（JSON）を貼ってください'); return; }
  const o = btn.textContent; btn.disabled = true;
  usStep('v');
  try{
    btn.textContent = '生成中…(1/3)'; await usGenScript();
    btn.textContent = '生成中…(2/3)'; await usGenSns();
    usRenderVideo();
    // 動画のデータ → 冒頭の一言とまとめ（AI）。東証版の「ファクトチェック完了」と同じ流れ
    btn.textContent = '生成中…(3/3)'; await usVidBuild(null, true); await usVidScreenAi(null);
    btn.textContent = '✅ 完了';
  }catch(e){ btn.textContent = '❌ ' + e.message; usStatus('usScriptStatus', '❌ ' + e.message, 'error'); }
  finally{ btn.disabled = false; setTimeout(() => { btn.textContent = o; }, 2500); }
}
async function usRegen(kind, btn){
  btn.disabled = true;
  try{
    if(kind === 'script'){ await usGenScript(btn); await usScriptApply(); } else await usGenSns(btn);
    usRenderVideo();
  }
  catch(e){ usStatus(kind === 'script' ? 'usScriptStatus' : 'usSnsStatus', '❌ ' + e.message, 'error'); }
  finally{ btn.disabled = false; }
}
// 台本（全体）を直した・作り直したら、③動画の場面ごとの台本にも入れ直す（動画のデータがあるときだけ。AI は呼ばない）。
// 文が変わった場面は、前の音声が「台本と違う音声」になる（合わせるなら音声を作り直す）。変わっていない場面は、文も音声もそのまま
async function usScriptApply(){
  if(typeof usVidLoad !== 'function' || !(usVidLoad() || {}).data) return;
  if(await usVidBuild(null, true)) usVidStatus('✅ 場面ごとの台本に反映しました（文が変わった場面は、音声を作り直してください）', 'ok');
}
function usScriptBody(){ const re = new RegExp('^\\s*[\\[［【]\\s*(' + US_SCRIPT_TAGS.join('|') + ')\\s*[\\]］】]\\s*$'); return String(US.script || '').split('\n').filter(l => !re.test(l)).join('\n').trim(); }
function usScriptChars(){ return usScriptBody().replace(/\s/g, '').length; }
function usScriptChanged(){ US.script = (document.getElementById('usScript') || {}).value || ''; usPersist(); usStatus('usScriptStatus', `${usScriptChars()}文字（約${Math.round(usScriptChars() / 7)}秒）`); usRenderVideo(); }
function usSnsChanged(){ US.snsThumb = (document.getElementById('usSnsThumb') || {}).value || ''; US.snsX = (document.getElementById('usSnsX') || {}).value || ''; usPersist(); }
// 台本を区切りごとに分ける { '米国指数': '…', … }
function usScriptSections(){
  const out = {}; let cur = '';
  const re = new RegExp('^\\s*[\\[［【]\\s*(' + US_SCRIPT_TAGS.join('|') + ')\\s*[\\]］】]\\s*$');
  for(const l of String(US.script || '').split('\n')){
    const m = l.match(re);
    if(m){ cur = m[1]; out[cur] = out[cur] || ''; continue; }
    if(cur && l.trim()) out[cur] += (out[cur] ? '\n' : '') + l.trim();
  }
  return out;
}

// ---------- ③ 動画：場面のデータ ----------
// 動画の部品（kessan-visualizer）に米国の場面を足すときに渡す形。週間まとめでも使えるよう、場面ごとに分けて持つ
function usVideoData(){
  const d = US.data; if(!d) return null;
  const m = (d.markets && d.markets.markets) || [];
  const pick = (keys) => keys.map(k => m.find(r => r.key === k)).filter(Boolean).map(r => ({ key: r.key, name: r.name, value: r.value, change: r.change, pct: r.pct, changeBp: r.changeBp, unit: r.unit, source: r.source, history: r.history }));
  const sec = usScriptSections();
  const p = US.parsed || { marketNews: [], stockNews: [] };
  const earn = usPickedEarn().map(r => ({
    symbol: r.symbol, name: r.nameJa || r.name, timing: usHourJa(r), session: r.session,
    dayPct: r.dayPct, afterPct: r.afterPct, afterTime: r.afterTime,
    revenue: r.revenue.weather, eps: r.eps.weather, guidance: r.guidance, comment: r.comment,
    numbers: { epsEstimate: r.eps.estimate, epsActual: r.eps.actual, revenueEstimate: r.revenue.estimate, revenueActual: r.revenue.actual, aiFilled: r.aiFilled },
  }));
  const pages = [];
  for(let i = 0; i < earn.length && pages.length < 2; i += US_EARN_PER_PAGE) pages.push(earn.slice(i, i + US_EARN_PER_PAGE));
  return {
    market: 'us', date: d.targetDate, prevDate: d.prevDate,
    scenes: {
      indices: { items: pick(['dji', 'spx', 'ixic']), narration: sec['米国指数'] || '' },
      otherIndices: { items: pick(['sox', 'rut', 'vix']), narration: sec['その他の指数'] || '' },
      // 動画では japan と assets を1つの場面（日本への影響・金利・資産）に出す。読み上げは assets に持つ
      japan: { futures: d.markets && d.markets.nikkeiFutures, items: pick(['usdjpy']), narration: '' },
      assets: { items: pick(['us10y', 'gold', 'btc', 'wti']), narration: sec[US_TAG_ASSETS] || '' },
      news: { items: p.marketNews.slice(0, 5).map(n => ({ title: n.title, detail: n.detail })), narration: sec['ニュース'] || '' },
      stocks: { items: p.stockNews.slice(0, 5).map(n => { const er = earn.find(e => e.symbol === String(n.symbol || '').toUpperCase()); const mv = (d.movers ? [...(d.movers.gainers || []), ...(d.movers.losers || []), ...(d.movers.actives || [])] : []).find(q => q.symbol === String(n.symbol || '').toUpperCase()); return { symbol: n.symbol, name: usJa(n.symbol, n.nameJa) || n.symbol, after: !!(er && er.session === 'afterhours'), pct: er ? (er.session === 'afterhours' ? er.afterPct : er.dayPct) : (mv ? mv.pct : null), headline: n.headline, detail: n.detail }; }), narration: sec['個別株'] || '' },
      earnings: { pages, narration: sec['決算'] || '' },
    },
    opening: sec['オープニング'] || '', summary: sec['まとめ'] || '',
  };
}
function usRenderVideo(){
  const el = document.getElementById('usVideoData'); if(!el) return;
  const v = usVideoData();
  if(!v){ el.innerHTML = '<div class="mut">①データ取得のあとに出ます。</div>'; return; }
  const s = v.scenes;
  const missing = US_SCRIPT_TAGS.filter(t => US.script && !(t in usScriptSections()));
  const line = (t, n, extra) => `<tr><td>${t}</td><td>${extra}</td><td class="mut">${n ? autoEsc(n.slice(0, 60)) + (n.length > 60 ? '…' : '') : '（台本なし）'}</td></tr>`;
  const mv = (items) => items.map(i => `${autoEsc(i.name)} ${usPct(i.pct)}`).join('・');
  el.innerHTML = `${missing.length && US.script ? `<div class="us-warn">台本に無い区切り：${missing.join('・')}</div>` : ''}
  <table class="us-tbl"><tr><th>場面</th><th>画面に出すもの</th><th>読み上げ（台本の頭）</th></tr>
  ${line('0. サムネ・表紙', v.opening, '（東証版と同じ）')}
  ${line('1. 米国3指数', s.indices.narration, mv(s.indices.items) + '＋チャート')}
  ${line('2. その他の指数', s.otherIndices.narration, mv(s.otherIndices.items))}
  ${line('3. 日本への影響・金利・資産', s.assets.narration, (s.japan.futures ? `日経先物 ${usFmt(s.japan.futures.value, 0)}（日経平均比 ${usSign(s.japan.futures.vsNk225, 0)}）・` : '') + mv([...s.japan.items, ...s.assets.items]))}
  ${line('4. ニュース', s.news.narration, s.news.items.length + '本')}
  ${line('5. 個別株', s.stocks.narration, s.stocks.items.map(i => autoEsc(i.name)).join('・') || 'なし')}
  ${line('6. 決算一覧', s.earnings.narration, s.earnings.pages.length ? s.earnings.pages.map((p, i) => `${i + 1}ページ目 ${p.length}銘柄`).join('・') : 'なし（場面ごと出さない）')}
  ${line('7. まとめ', v.summary, '')}
  </table>`;
}
function usCopyVideoData(btn){ const v = usVideoData(); if(!v){ alert('先に①データ取得をしてください'); return; } autoClip(JSON.stringify(v, null, 2), btn); }
function usCopy(id, btn){ autoClip((document.getElementById(id) || {}).value || '', btn); }

// ---------- テキストモデル（米国版の⚙設定。中身は東証版の⚙設定の「テキストモデル」と同じ1つの設定）----------
// 選択肢は東証版の欄（autoModelOverride）から写し、どちらで変えても両方に反映する（保存は東証版の仕組みのまま）
function usModelInit(){
  const src = document.getElementById('autoModelOverride'), dst = document.getElementById('usModel');
  if(!src || !dst) return;
  dst.innerHTML = src.innerHTML; dst.value = src.value;
  dst.addEventListener('change', () => { src.value = dst.value; src.dispatchEvent(new Event('change', { bubbles: true })); src.dispatchEvent(new Event('input', { bubbles: true })); });
  src.addEventListener('change', () => { dst.value = src.value; });
}

// ---------- 起動 ----------
let _usReady = false;
function usInit(){
  if(_usReady) return; _usReady = true;
  usRestore(); usFillSettings(); usModelInit(); usRenderAll();
  usStep(US.step || '1');
  if(US.script) usStatus('usScriptStatus', `${usScriptChars()}文字（約${Math.round(usScriptChars() / 7)}秒）`);
}

// ---------- ③ 動画：動画の部品（KessanViz.tse）で米国の場面を描く（2026-11-14）----------
// 東証の部品（プレビュー・場面ごとの読み上げ・MP4 の書き出し・BGM）をそのまま使い、データに market:"us" を付けて米国の場面の並びにする。
// 保存は ssgus_video（東証の ssg_video とは別）。音声は部品の IndexedDB に namespace「us-日付」で置く。
const US_VID_KEY = 'ssgus_video';
let usVidHandle = null;
function usVidLoad(){ try{ return JSON.parse(localStorage.getItem(US_VID_KEY) || 'null'); }catch(e){ return null; } }
function usVidSave(o){ try{ localStorage.setItem(US_VID_KEY, JSON.stringify(o)); }catch(e){ console.warn('米国版の動画の保存に失敗', e); } }
function usVidStatus(msg, cls){ usStatus('usVidStatus', msg, cls); }

// 台本の区切り → 動画の場面
const US_NAR_MAP = { cover: 'オープニング', index: '米国指数', usOthers: 'その他の指数', usAssets: US_TAG_ASSETS, news: 'ニュース', usStocks: '個別株', usEarnings1: '決算', summary: 'まとめ' };
function usNarration(){
  const sec = usScriptSections(), out = {};
  for(const [id, tag] of Object.entries(US_NAR_MAP)){ const v = sec[tag]; if(v) out[id] = { text: v, seconds: null, src: v }; }
  return out;
}

// 場面のデータ（usVideoData）→ 動画の部品の TseData
function usTseData(){
  const v = usVideoData(); if(!v) return null;
  const s = v.scenes;
  const chart = (r) => ({ name: r.name, close: r.value, change: r.change || 0, pct: r.pct || 0, points: (r.history || []).map(p => ({ date: p.date, close: p.close })) });
  const q = (r, o = {}) => r ? Object.assign({ name: r.name, value: r.value, change: r.change, pct: r.pct, decimals: 2 }, o) : null;
  const by = (arr, key) => arr.find(r => r.key === key);
  const f = s.japan.futures;
  const japan = [];
  if(f && f.value != null){
    const d = Math.round(usN(f.vsNk225) || 0);
    japan.push({ name: f.source === 'CME' ? '日経平均先物（CME）' : '日経平均先物', value: f.value, unit: '円', decimals: 0, change: f.vsNk225 == null ? null : d,
      changeLabel: '日経平均比', changeText: f.vsNk225 == null ? undefined : `${d > 0 ? '+' : d < 0 ? '-' : '±'}${Math.abs(d).toLocaleString('en-US')}円`,
      note: `日経平均の前日終値 ${usFmt(f.nk225Close, 0)}円` });
  }
  const jpy = by(s.japan.items, 'usdjpy'); if(jpy) japan.push(q(jpy, { unit: '円', decimals: 2 }));
  const t10 = by(s.assets.items, 'us10y');
  const assets = [
    t10 && q(t10, { unit: '%', decimals: 3, changeText: `${usSign(t10.changeBp, 1)}bp` }),
    q(by(s.assets.items, 'gold'), { unit: 'ドル', decimals: 1 }),
    q(by(s.assets.items, 'btc'), { unit: 'ドル', decimals: 0 }),
    q(by(s.assets.items, 'wti'), { unit: 'ドル', decimals: 2 }),
  ].filter(Boolean);
  const after = usPickedEarn().filter(r => r.afterTime).map(r => r.afterTime)[0] || null;
  return {
    market: 'us', brand: '米国マーケット振り返り', date: v.date, headline: '',
    // 時刻は台本で読まず、画面の下の注記に出す（2026-11-14 すみぽん）
    notes: { usAssets: `日本時間 ${usFetchedJst()} 時点${f && f.time ? `（日経平均先物は ${f.time} 時点）` : ''}`, usStocks: after && s.stocks.items.some(i => i.after) ? `時間外の値動きは日本時間 ${after} 時点` : '' },
    charts: s.indices.items.map(chart), others: [],
    contrib: { plus: [], minus: [] }, sectors: { up: [], down: [] }, rise: [], fall: [], trading: [],
    news: s.news.items.map(n => ({ title: n.title, body: n.detail })), news_image: null, summary: null, thumbnail: null,
    us: {
      others: s.otherIndices.items.map(r => q(r)), japan: [], assets: [...japan, ...assets],   // 日本への影響と金利・資産は1つの場面（usAssets）に出す
      stocks: s.stocks.items.map(i => ({ symbol: i.symbol, name: i.name, pct: i.pct, headline: i.headline, detail: i.detail })),
      earnings: s.earnings.pages.map(p => p.map(e => ({ symbol: e.symbol, name: e.name, timing: e.timing, dayPct: e.dayPct, afterPct: e.session === 'afterhours' ? e.afterPct : null, revenue: e.revenue || null, eps: e.eps || null, guidance: e.guidance || null, comment: e.comment || '' }))),
      afterAsOf: after,
    },
  };
}

// 画面の文（冒頭の一言・まとめ）。東証版の VID_SCREEN_PROMPT と同じ決まり（銘柄の添え物は無し）
const US_SCREEN_PROMPT = `以下の資料と台本をもとに、この日の米国株式市場を振り返る動画の画面に出す文を作ってください。
・headline：動画の最初に大きく出す、この日の市場をひと言で表す文。25文字以内。台本のオープニングと同じ内容にしてください。
・feature：最後の「まとめ」に出す、この日のマーケットの特長がわかる1文。40文字以内。日付や銘柄名を入れ替えても使える文（どの日にも言える一般論）にせず、その日ならではの具体を書いてください。
・points：まとめに出す注目点を3つ。title は何が起きたかがわかる見出しで15文字以内、body は40文字以内。全ての情報を書かず、注目点だけを選んでください（日本市場への影響を1つ入れてよい）。
・closing：まとめの図の最後に出す、この日の相場の流れをひと言で表す1文。30文字以内。これも、どの日にも言える文（例：「見通しの強弱で明暗が分かれた」）にしないでください。
・数字と銘柄名は資料と台本のとおりに書いてください。銘柄名はカタカナの社名にしてください。
・次の形の JSON だけを出力してください。
{"headline":"","feature":"","points":[{"title":"","body":""}],"closing":""}`;
async function usScreenText(){
  const resources = usResources().concat([{ label: '台本', text: usScriptBody() }]);
  const res = await aiFetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: US_SCREEN_PROMPT, resources, temperature: 0.3, models: autoModelChain('low'), json: true }) });
  const d = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if(!d.ok) throw new Error(d.error || '画面の文を作れませんでした');
  const m = String(d.text || '').match(/\{[\s\S]*\}/); if(!m) throw new Error('画面の文の形が読めませんでした');
  const o = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
  return { headline: String(o.headline || '').trim(), summary: { feature: String(o.feature || '').trim(), closing: String(o.closing || '').trim() || null, points: (Array.isArray(o.points) ? o.points : []).slice(0, 3).map(x => ({ title: String(x.title || '').trim(), body: String(x.body || '').trim() })).filter(x => x.title) } };
}

// 動画のデータを作る（AI は呼ばない）。台本のその区切りが前と同じなら、前の文と音声の長さを引き継ぐ（東証版の vidBuild と同じ）
async function usVidBuild(btn, quiet){
  if(!US.data){ usVidStatus('先に①データ取得をしてください', 'error'); return false; }
  if(btn) btn.disabled = true;
  try{
    const data = usTseData();
    const prev = usVidLoad() || {};
    if(prev.data && prev.data.date === data.date){ data.headline = prev.data.headline || ''; data.summary = prev.data.summary || null; }
    if(!data.headline) data.headline = (usScriptSections()['オープニング'] || '').split(/[。\n]/)[0];
    let narration = usNarration();
    const prevNar = (prev.settings && prev.settings.narration) || {};
    if(!Object.keys(narration).length && Object.keys(prevNar).length) narration = prevNar;
    for(const [id, v] of Object.entries(narration)){
      const p0 = prevNar[id]; if(!p0) continue;
      if(String(p0.src || '').trim() === String(v.src || '').trim()) narration[id] = { text: p0.text, seconds: p0.seconds ?? null, src: v.src };
    }
    const settings = Object.assign({}, prev.settings || {}, { narration });
    usVidSave(Object.assign({}, prev, { data, settings, builtAt: new Date().toISOString() }));
    await usVidMount(true);
    if(!quiet) usVidStatus('✅ 動画のデータを作りました' + (data.summary ? '' : '（まとめはまだありません。「一言・まとめを AI で作る」で作れます）'), 'ok');
    return true;
  }catch(e){ usVidStatus('❌ ' + e.message, 'error'); return false; }
  finally{ if(btn) btn.disabled = false; }
}
async function usVidScreenAi(btn){
  const o = usVidLoad();
  if(!o || !o.data){ if(!(await usVidBuild(null, true))) return; }
  if(btn) btn.disabled = true;
  try{
    usVidStatus('冒頭の一言とまとめを作成中…（AI）');
    const sc = await usScreenText();
    const cur = usVidLoad();
    if(sc.headline) cur.data.headline = sc.headline;
    cur.data.summary = sc.summary;
    usVidSave(cur);
    await usVidMount(true);
    usVidStatus('✅ 一言・まとめを作りました', 'ok');
  }catch(e){ usVidStatus('❌ ' + e.message, 'error'); }
  finally{ if(btn) btn.disabled = false; }
}

// サムネの文言：④のサムネ案の「最有力」の行（上段／中段／下段）を「：」区切りにして初期値にする
function usThumbDefault(){
  const t = String(US.snsThumb || '');
  const best = (t.match(/最有力[：:]\s*([①②③])/) || [])[1] || '①';
  const line = t.split(/\r?\n/).find(l => l.trim().startsWith(best)) || '';
  return line.replace(/^\s*[①②③]\s*/, '').split(/[／/]/).map(x => x.trim()).filter(Boolean).slice(0, 3).join('：');
}
function usThumbText(){
  const el = document.getElementById('usThumbText');
  const o = usVidLoad() || {};
  if(el && !el.value.trim() && !o.thumbEdited) el.value = usThumbDefault();
  return el ? el.value.trim() : '';
}
function usThumbChanged(){
  const o = usVidLoad() || {};
  o.thumbText = (document.getElementById('usThumbText') || {}).value || ''; o.thumbEdited = true;
  usVidSave(o);
  if(usVidHandle) usVidMount(true).catch(e => usVidStatus('❌ ' + e.message, 'error'));
}
async function usThumbImage(text){
  if(!text || typeof slideThumb !== 'function') return null;
  const box = document.getElementById('renderTarget'); if(!box) return null;
  box.innerHTML = slideThumb(text);
  await new Promise(r => setTimeout(r, 200));
  try{
    const c = await html2canvas(box.querySelector('.slide'), { width: SLIDE_W, height: SLIDE_H, scale: 1920 / SLIDE_W, useCORS: true, allowTaint: true, backgroundColor: '#ffffff', logging: false });
    return c.toDataURL('image/jpeg', 0.9);
  }catch(e){ console.warn('米国版のサムネの画像化に失敗', e); return null; }
  finally{ box.innerHTML = ''; }
}

// 東証版の vidMount と同じ順番待ち（サムネを画像にする renderTarget を同時に使わない）を通して描く
function usVidMount(force){ return (typeof vidQueue === 'function' ? vidQueue : (fn => fn()))(() => usVidMountNow(force)); }
async function usVidMountNow(force){
  const saved = usVidLoad();
  const el = document.getElementById('usThumbText');
  if(el && saved && saved.thumbText != null && !el.value) el.value = saved.thumbText;
  if(!saved || !saved.data) return;
  if(usVidHandle && !force) return;
  const KV = await vidLoadLib();
  const data = Object.assign({}, saved.data, { thumbnail: await usThumbImage(usThumbText()), thumbnail_portrait: null });
  const voice = () => (document.getElementById('autoTtsVoice') || {}).value || 'Erinome';
  const model = () => (document.getElementById('autoTtsModel') || {}).value || undefined;
  const props = {
    data, settings: saved.settings || null, namespace: 'us-' + data.date,
    controlsEl: document.getElementById('usVidControls'),
    tts: (t) => KV.tse.fetchTts('/api/tts', voice(), model())(t),
    transcribe: async (blob) => {
      const res = await fetch('/api/transcribe?lang=ja', { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/wav' }, body: blob });
      let d = {}; try{ d = await res.json(); }catch(e){}
      if(!res.ok || !d.ok) throw new Error(d.error || ('文字起こしに失敗しました（HTTP ' + res.status + '）'));
      return { words: d.words || [] };
    },
    onChange: (st) => { const o = usVidLoad() || {}; o.settings = st; usVidSave(o); },
    importBgm: typeof ssgBgmImport === 'function' ? ssgBgmImport : null,
    voiceCalls: 1,   // 読み上げは1回でまとめて作る（2026-11-14 すみぽん。分けない）
    exportEl: document.getElementById('usVidExport'),
    exportElPortrait: document.getElementById('usVidExportV'),
    exportButton: { className: 'btn-sm', labels: ['🎬 横動画', '🎬 縦動画'] },
    fileName: `usmarket_${data.date.replace(/-/g, '')}.mp4`,
  };
  document.getElementById('usVidControls').style.display = '';
  const hint = document.getElementById('usVidExportHint'); if(hint) hint.style.display = 'none';
  if(usVidHandle){ usVidHandle.update(props); return; }
  usVidHandle = KV.tse.mount(document.getElementById('usVidPreview'), props);
}
function usVidOpen(){ usVidMount(!!usVidHandle).catch(e => usVidStatus('❌ ' + e.message, 'error')); }
