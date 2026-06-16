'use strict';

// ---------- ユーティリティ ----------
const $ = (s) => document.querySelector(s);
const OKU = 1_0000_0000;
const toOku = (yen) => yen / OKU;

function fmtYen(yen) {
  if (yen == null) return '-';
  const s = yen < 0 ? '−' : '';
  const v = Math.abs(yen);
  if (v >= 1e12) {
    const oku = Math.round(v / OKU), cho = Math.floor(oku / 10000), rest = oku % 10000;
    return rest === 0 ? `${s}${cho}兆円` : `${s}${cho}兆${rest.toLocaleString()}億円`;
  }
  if (v >= OKU) return `${s}${Math.round(v / OKU).toLocaleString()}億円`;
  if (v >= 1e6) return `${s}${Math.round(v / 1e6).toLocaleString()}百万円`;
  return `${s}${Math.round(v).toLocaleString()}円`;
}
const yen0 = (n) => n == null ? '-' : '¥' + Math.round(n).toLocaleString();

function badgeColor(score) {
  if (score >= 80) return getCss('--green');
  if (score >= 60) return getCss('--teal');
  if (score >= 40) return getCss('--orange');
  return '#9aa3ad';
}
function getCss(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

async function fetchJSON(url) {
  try { const r = await fetch(url + '?t=' + Date.now()); if (!r.ok) return null; return await r.json(); }
  catch (e) { return null; }
}

// ---------- 状態 ----------
let records = [];
let current = null;       // 選択中の調査レコード
let selectedCode = null;
let priceChart = null, quarterChart = null;
let simMarkerDate = null;   // 購入シミュレーションの購入日マーカー
let viewMode = 'ranking';     // 'ranking' | 'watchlist'
const WATCH_KEY = 'kuroten.watchlist';
let watchlist = loadWatchlist();

// ---------- 初期化 ----------
async function kurotenReload() {
  const [latest, history] = await Promise.all([fetchJSON('data/latest.json'), fetchJSON('data/history.json')]);
  records = (history && history.length) ? history.slice() : (latest ? [latest] : []);
  if (latest && records.length) records[0] = latest; // 最新は株価込みのフルデータ
  const sel = $('#historySelect');
  sel.innerHTML = '';
  records.forEach((r, i) => {
    const opt = document.createElement('option');
    const d = new Date(r.date);
    opt.value = i;
    opt.textContent = `${d.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })} (${r.results.length}件)`;
    sel.appendChild(opt);
  });
  sel.onchange = () => selectRecord(parseInt(sel.value, 10));
  $('#viewRanking').onclick = () => setViewMode('ranking');
  $('#viewWatch').onclick = () => setViewMode('watchlist');
  refreshWatchlistFromLatest();
  updateWatchCount();
  if (syncConfigured()) { await syncPull(); refreshWatchlistFromLatest(); }
  if (records.length) selectRecord(0);
  else { $('#emptyState').hidden = false; $('#summary').textContent = 'データがありません'; }
}
window.kurotenReload = kurotenReload;
kurotenReload();

function selectRecord(i) {
  current = records[i];
  if (!current) return;
  if (viewMode === 'watchlist') { renderList(); return; }
  $('#summary').textContent = `${current.mode} ・ ${current.summary}`;
  renderList();
  const first = current.results[0];
  selectStock(first ? first.code : null);
}

function renderList() {
  const list = $('#rankingList');
  list.innerHTML = '';
  const results = activeResults();
  const empty = $('#emptyState');
  empty.hidden = results.length > 0;
  empty.textContent = viewMode === 'watchlist'
    ? '★ウォッチリストは空です。銘柄の☆を押して追加してください。'
    : '条件に該当する銘柄がありません。';
  results.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'row' + (s.code === selectedCode ? ' active' : '');
    row.onclick = () => selectStock(s.code);
    const col = badgeColor(s.score);
    const watched = isWatched(s.code);
    row.innerHTML = `
      <div class="badge" style="color:${col};background:${col}22;border:2px solid ${col}">
        ${Math.round(s.score)}<small>点</small></div>
      <div class="rowmain">
        <div class="rowname">${esc(s.name)}</div>
        <div class="rowsub">${s.code}・${esc(s.market)}・${esc(s.sector33 || '')}</div>
      </div>
      <div class="rowprice">
        <div>${yen0(s.price)}</div>
        ${s.target ? `<div class="tgt">目標 ${yen0(s.target)}</div>` : ''}
      </div>
      <button class="star${watched ? ' on' : ''}" title="ウォッチリスト">${watched ? '★' : '☆'}</button>`;
    const st = row.querySelector('.star');
    st.onclick = (e) => { e.stopPropagation(); toggleWatch(s.code); };
    list.appendChild(row);
  });
}

// ---------- ウォッチリスト ----------
function loadWatchlist() {
  try { return JSON.parse(localStorage.getItem(WATCH_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function saveWatchlist() {
  try { localStorage.setItem(WATCH_KEY, JSON.stringify(watchlist)); } catch (e) {}
  updateWatchCount();
}
function isWatched(code) { return !!watchlist[code]; }
function updateWatchCount() {
  const el = $('#watchCount'); if (!el) return;
  const n = Object.keys(watchlist).length;
  el.textContent = n ? ' (' + n + ')' : '';
}
function snapshotOf(code) {
  const fromLatest = ((records[0] && records[0].results) || []).find(x => x.code === code);
  const fromCurrent = ((current && current.results) || []).find(x => x.code === code);
  return fromLatest || fromCurrent || null;
}
function toggleWatch(code) {
  if (watchlist[code]) { delete watchlist[code]; }
  else {
    const s = snapshotOf(code);
    if (!s) return;
    watchlist[code] = Object.assign({}, s, { addedAt: Date.now() });
  }
  saveWatchlist();
  syncPushDebounced();
  renderList();
  const res = activeResults();
  const sel = res.find(x => x.code === selectedCode) ? selectedCode : (res[0] ? res[0].code : null);
  selectStock(sel);
}
function refreshWatchlistFromLatest() {
  const latest = (records[0] && records[0].results) || [];
  let changed = false;
  latest.forEach(s => {
    if (watchlist[s.code]) {
      const addedAt = watchlist[s.code].addedAt;
      watchlist[s.code] = Object.assign({}, s, { addedAt });
      changed = true;
    }
  });
  if (changed) saveWatchlist();
}
function watchlistResults() {
  return Object.values(watchlist).sort((a, b) => (b.score || 0) - (a.score || 0));
}
function activeResults() {
  return viewMode === 'watchlist' ? watchlistResults() : ((current && current.results) || []);
}
function setViewMode(mode) {
  viewMode = mode;
  $('#viewRanking').classList.toggle('active', mode === 'ranking');
  $('#viewWatch').classList.toggle('active', mode === 'watchlist');
  const histLabel = $('#historySelect').closest('label');
  if (histLabel) histLabel.style.display = (mode === 'ranking') ? '' : 'none';
  renderList();
  const res = activeResults();
  if (mode === 'watchlist') $('#summary').textContent = `ウォッチリスト ・ ${res.length}銘柄`;
  else if (current) $('#summary').textContent = `${current.mode} ・ ${current.summary}`;
  const sel = res.find(x => x.code === selectedCode) ? selectedCode : (res[0] ? res[0].code : null);
  selectStock(sel);
}

function selectStock(code) {
  selectedCode = code;
  renderList();
  const s = activeResults().find((x) => x.code === code);
  const detail = $('#detail'), empty = $('#detailEmpty');
  if (!s) { detail.hidden = true; empty.hidden = false; return; }
  empty.hidden = true; detail.hidden = false;
  const col = badgeColor(s.score);
  detail.innerHTML = `
    <div class="head">
      <div class="badge" style="color:${col};background:${col}22;border:2px solid ${col}">
        ${Math.round(s.score)}<small>点</small></div>
      <div>
        <h2>${esc(s.name)}</h2>
        <div class="headsub">${s.code}・${esc(s.market)}・${esc(s.sector33 || '')}</div>
        <div class="headsub" style="font-size:12px">直近開示: ${s.lastDisclosed || '-'}</div>
      </div>
      <button class="detailstar${isWatched(s.code) ? ' on' : ''}" title="ウォッチリスト">${isWatched(s.code) ? '★ ウォッチ中' : '☆ ウォッチ'}</button>
    </div>
    <div class="section-title">売買プラン(メソッド: 2倍で利確)</div>
    <div class="cards">
      <div class="card"><div class="k">現在値(買い目安)</div><div class="v" style="color:var(--blue)">${yen0(s.price)}</div></div>
      <div class="card"><div class="k">2倍ターゲット(利確目安)</div><div class="v" style="color:var(--green)">${yen0(s.target)}</div></div>
      <div class="card"><div class="k">最低投資額(単元100株)</div><div class="v">${yen0(s.minLot)}</div></div>
      <div class="card"><div class="k">想定保有</div><div class="v" style="font-size:15px">3か月〜2年</div></div>
      ${s.forecastOP != null ? `<div class="card"><div class="k">通期営業利益予想</div><div class="v" style="font-size:15px">${fmtYen(s.forecastOP)}</div></div>` : ''}
    </div>

    <div class="chartbox">
      <div class="section-title" style="margin-top:0">株価の推移(日次終値)</div>
      <div style="height:200px"><canvas id="priceChart"></canvas></div>
      <div class="cap">単位: 円。縦軸は変動が見やすいよう自動調整(0起点ではありません)。</div>
    </div>

    <div class="section-title">購入シミュレーション</div>
    <div class="chartbox simbox">
      <div class="simctl">
        <span><label for="simDate">購入日</label><input type="date" id="simDate"></span>
        <span><label for="simShares">株数</label><input type="number" id="simShares" min="100" step="100" value="100" style="width:110px"> 株</span>
        <span class="simhint" id="simLot"></span>
      </div>
      <div id="simResult" class="cards" style="margin:0"></div>
      <div class="cap">購入日の終値で取得し、最新終値で評価した想定です(手数料・税金・配当は含みません)。購入日が休場の場合は直後の営業日の終値を使用します。既定は<b>決算開示日の翌営業日</b>(黒字転換が判明し、現実に買える最短の初動)。四半期末は開示前で実際には買えないため使いません。</div>
    </div>

    <div class="chartbox">
      <div class="legend">
        <span><span class="sq" style="background:var(--green)"></span>営業利益</span>
        <span><span class="dot" style="background:var(--blue)"></span>経常利益</span>
        <span style="color:var(--orange)">┊ 黒字転換</span>
      </div>
      <div style="height:220px"><canvas id="quarterChart"></canvas></div>
      <div class="cap">単位: 億円。棒=営業利益(赤字は赤)、折れ線=経常利益。横軸は株価チャートと同じ期間。</div>
    </div>

    <div class="section-title">スコア内訳(メソッド適合度 ${Math.round(s.score)}点)</div>
    <div>${(s.factors || []).map(f => `
      <div class="factor">
        <div class="pt ${f.points >= 0 ? 'pos' : 'neg'}">${f.points >= 0 ? '+' : ''}${f.points}</div>
        <div><div class="ft">${esc(f.title)}</div><div class="fd">${esc(f.detail)}</div></div>
      </div>`).join('')}</div>
  `;
  const dstar = detail.querySelector('.detailstar');
  if (dstar) dstar.onclick = () => toggleWatch(s.code);
  drawCharts(s);
  renderSimSetup(s);
}


// ---------- クラウド同期(jsonbin.io) ----------
const JSONBIN = 'https://api.jsonbin.io/v3/b';
function syncKeyVal() { return localStorage.getItem('sync.key') || ''; }
function syncBinVal() { return localStorage.getItem('sync.bin') || ''; }
function syncConfigured() { return !!(syncKeyVal() && syncBinVal()); }
function setSyncStatus(msg, ok) {
  const el = $('#syncStatus'); if (!el) return;
  el.textContent = msg; el.className = 'cfgstatus ' + (ok === true ? 'ok' : ok === false ? 'err' : '');
}
async function syncPull() {
  const key = syncKeyVal(), bin = syncBinVal();
  if (!key || !bin) { setSyncStatus('APIキーとBin IDを入力してください', false); return false; }
  setSyncStatus('クラウドから読み込み中…');
  try {
    const r = await fetch(`${JSONBIN}/${bin}/latest`, { headers: { 'X-Master-Key': key, 'X-Bin-Meta': 'false' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const obj = (data && data.record) ? data.record : data;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      watchlist = obj;
      try { localStorage.setItem(WATCH_KEY, JSON.stringify(watchlist)); } catch (e) {}
      updateWatchCount(); renderList();
      if (selectedCode) selectStock(selectedCode);
    }
    setSyncStatus('クラウドから読み込みました', true);
    return true;
  } catch (e) { setSyncStatus('読み込み失敗: ' + e.message, false); return false; }
}
async function syncPush() {
  const key = syncKeyVal(); let bin = syncBinVal();
  if (!key) { setSyncStatus('APIキーを入力してください', false); return false; }
  setSyncStatus('クラウドへ保存中…');
  try {
    let r;
    if (bin) {
      r = await fetch(`${JSONBIN}/${bin}`, { method: 'PUT', headers: { 'X-Master-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(watchlist) });
    } else {
      r = await fetch(`${JSONBIN}`, { method: 'POST', headers: { 'X-Master-Key': key, 'Content-Type': 'application/json', 'X-Bin-Private': 'true', 'X-Bin-Name': 'kuroten-watchlist' }, body: JSON.stringify(watchlist) });
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (!bin && data && data.metadata && data.metadata.id) {
      bin = data.metadata.id;
      localStorage.setItem('sync.bin', bin);
      const f = $('#cfgSyncBin'); if (f) f.value = bin;
    }
    setSyncStatus('クラウドへ保存しました' + (bin ? ` (Bin ID: ${bin})` : ''), true);
    return true;
  } catch (e) { setSyncStatus('保存失敗: ' + e.message, false); return false; }
}
let __syncTimer = null;
function syncPushDebounced() {
  if (!syncConfigured()) return;
  clearTimeout(__syncTimer);
  __syncTimer = setTimeout(() => { syncPush(); }, 1500);
}
window.kurotenSyncUpload = syncPush;
window.kurotenSyncDownload = syncPull;

// ---------- チャート ----------
function sharedDomain(s) {
  const dates = [];
  (s.prices || []).forEach(p => dates.push(new Date(p.date)));
  (s.quarterly || []).forEach(q => { if (q.periodEnd) dates.push(new Date(q.periodEnd)); });
  if (!dates.length) return null;
  return { min: new Date(Math.min(...dates)), max: new Date(Math.max(...dates)) };
}

function drawCharts(s) {
  if (priceChart) priceChart.destroy();
  if (quarterChart) quarterChart.destroy();
  const dom = sharedDomain(s);
  const xScale = { type: 'time', time: { unit: 'month', displayFormats: { month: 'yy/MM' } },
    ticks: { font: { size: 10 } }, grid: { color: '#eef0f3' } };
  if (dom) { xScale.min = dom.min; xScale.max = dom.max; }

  // 株価
  const pricePts = (s.prices || []).map(p => ({ x: p.date, y: p.close }));
  const up = pricePts.length >= 2 ? pricePts[pricePts.length - 1].y >= pricePts[0].y : true;
  const pc = up ? getCss('--green') : getCss('--red');
  if (pricePts.length >= 2) {
    const ys = pricePts.map(p => p.y), lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.08 || hi * 0.05;
    priceChart = new Chart($('#priceChart'), {
      type: 'line',
      data: { datasets: [{ data: pricePts, borderColor: pc, backgroundColor: pc + '22',
        fill: true, pointRadius: 0, borderWidth: 1.6, tension: .25 }] },
      options: baseOpts(xScale, { min: lo - pad, max: hi + pad,
        ticks: { callback: v => '¥' + Math.round(v).toLocaleString(), font: { size: 10 } } }),
      plugins: [buyMarkerPlugin]
    });
  } else {
    const ctx = $('#priceChart').getContext('2d');
    ctx.font = '12px sans-serif'; ctx.fillStyle = getCss('--muted');
    ctx.fillText('株価データがありません(履歴または取得期間外)', 10, 30);
  }

  // 四半期 営業/経常
  const q = s.quarterly || [];
  const opData = q.filter(x => x.periodEnd != null).map(x => ({ x: x.periodEnd, y: toOku(x.op) }));
  const odData = q.filter(x => x.periodEnd != null && x.ord != null).map(x => ({ x: x.periodEnd, y: toOku(x.ord) }));
  const barColors = opData.map(d => d.y >= 0 ? getCss('--green') : getCss('--red'));
  const turnDate = (s.turnoverIndex >= 0 && q[s.turnoverIndex]) ? q[s.turnoverIndex].periodEnd : null;
  const turnPlugin = {
    id: 'turn',
    afterDatasetsDraw(chart) {
      if (!turnDate) return;
      const x = chart.scales.x.getPixelForValue(new Date(turnDate).getTime());
      const { top, bottom } = chart.chartArea;
      const c = chart.ctx; c.save();
      c.setLineDash([4, 3]); c.strokeStyle = getCss('--orange'); c.lineWidth = 2;
      c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
      c.setLineDash([]); c.fillStyle = getCss('--orange');
      c.font = 'bold 10px sans-serif'; c.textAlign = 'center';
      c.fillText('黒字転換', x, top + 10); c.restore();
    }
  };
  quarterChart = new Chart($('#quarterChart'), {
    data: {
      datasets: [
        { type: 'bar', data: opData, backgroundColor: barColors, barThickness: 16, order: 2 },
        { type: 'line', data: odData, borderColor: getCss('--blue'), backgroundColor: getCss('--blue'),
          pointRadius: 3, borderWidth: 1.6, order: 1, tension: .2 }
      ]
    },
    options: baseOpts(xScale, { ticks: { callback: v => v.toLocaleString(), font: { size: 10 } },
      grid: { color: '#eef0f3' } }),
    plugins: [turnPlugin]
  });
}

function baseOpts(xScale, yScale) {
  return {
    responsive: true, maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: true } },
    scales: { x: xScale, y: yScale }
  };
}

function esc(s) { return (s ?? '').toString().replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- 購入シミュレーション ----------
const buyMarkerPlugin = {
  id: 'buyMarker',
  afterDatasetsDraw(chart) {
    if (!simMarkerDate) return;
    const x = chart.scales.x.getPixelForValue(new Date(simMarkerDate).getTime());
    if (x == null || isNaN(x)) return;
    const { top, bottom } = chart.chartArea;
    const c = chart.ctx; c.save();
    c.setLineDash([4, 3]); c.strokeStyle = getCss('--blue'); c.lineWidth = 2;
    c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
    c.setLineDash([]); c.fillStyle = getCss('--blue');
    c.font = 'bold 10px sans-serif'; c.textAlign = 'center';
    c.fillText('購入', x, top + 10); c.restore();
  }
};

// 指定日「以降」で最初に存在する終値を返す(休場日対策)。無ければ最後の終値。
function closeOnOrAfter(prices, dateStr) {
  if (!prices || !prices.length) return null;
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return null;
  for (const p of prices) { if (new Date(p.date).getTime() >= t) return p; }
  return prices[prices.length - 1];
}

function renderSimSetup(s) {
  const dateEl = $('#simDate'), shEl = $('#simShares');
  if (!dateEl || !shEl) return;
  const prices = s.prices || [];
  if (!prices.length) {
    simMarkerDate = null;
    $('#simResult').innerHTML = '<div class="cap">株価データがないためシミュレーションできません。</div>';
    $('#simLot').textContent = '';
    return;
  }
  const minD = prices[0].date, maxD = prices[prices.length - 1].date;
  // 既定の購入日 = 決算開示日の翌営業日(現実に買える最短の初動)。
  // 黒字転換は四半期末ではなく開示時に判明するため、開示日以前は先読みになる。
  let defD = minD;
  if (s.lastDisclosed) {
    const ld = s.lastDisclosed;
    const after = prices.find(p => p.date > ld);     // 開示日の翌営業日(引け後開示が多いため)
    if (after) defD = after.date;
    else { const oa = closeOnOrAfter(prices, ld); if (oa) defD = oa.date; }
    if (defD < minD) defD = minD;
    if (defD > maxD) defD = maxD;
  }
  dateEl.min = minD; dateEl.max = maxD; dateEl.value = defD;
  if (!shEl.value || +shEl.value < 100) shEl.value = 100;
  const run = () => renderSim(s);
  dateEl.oninput = run; shEl.oninput = run;
  run();
}

function renderSim(s) {
  const out = $('#simResult'); if (!out) return;
  const prices = s.prices || [];
  const dateEl = $('#simDate'), shEl = $('#simShares'), lotEl = $('#simLot');
  let shares = Math.floor((parseInt(shEl.value, 10) || 0) / 100) * 100;
  if (shares < 100) shares = 100;
  const buy = closeOnOrAfter(prices, dateEl.value);
  const last = prices.length ? prices[prices.length - 1] : null;
  if (!buy || !last) {
    out.innerHTML = '<div class="cap">株価データがないためシミュレーションできません。</div>';
    simMarkerDate = null; if (priceChart) priceChart.update(); return;
  }
  simMarkerDate = buy.date; if (priceChart) priceChart.update();
  if (lotEl) lotEl.textContent = (shares / 100) + '単元';
  const cost = buy.close * shares;
  const val = last.close * shares;
  const pl = val - cost;
  const pct = cost > 0 ? pl / cost * 100 : 0;
  const tgtPl = (s.target != null) ? (s.target - buy.close) * shares : null;
  const plCol = pl >= 0 ? 'var(--green)' : 'var(--red)';
  const signYen = (n) => (n >= 0 ? '+' : '−') + '¥' + Math.abs(Math.round(n)).toLocaleString();
  const signPct = (n) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(1) + '%';
  out.innerHTML = `
    <div class="card"><div class="k">取得単価 (${buy.date})</div><div class="v">${yen0(buy.close)}</div></div>
    <div class="card"><div class="k">取得額 (${shares.toLocaleString()}株)</div><div class="v">${yen0(cost)}</div></div>
    <div class="card"><div class="k">現在値 (${last.date})</div><div class="v">${yen0(last.close)}</div></div>
    <div class="card"><div class="k">評価額</div><div class="v">${yen0(val)}</div></div>
    <div class="card"><div class="k">評価損益</div><div class="v" style="color:${plCol}">${signYen(pl)}</div></div>
    <div class="card"><div class="k">騰落率</div><div class="v" style="color:${plCol}">${signPct(pct)}</div></div>
    ${tgtPl != null ? `<div class="card"><div class="k">2倍利確時の損益(参考)</div><div class="v" style="color:var(--green)">${signYen(tgtPl)}</div></div>` : ''}
  `;
}
