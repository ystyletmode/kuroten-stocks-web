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

// ---------- 初期化 ----------
(async function init() {
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
  if (records.length) selectRecord(0);
  else { $('#emptyState').hidden = false; $('#summary').textContent = 'データがありません'; }
})();

function selectRecord(i) {
  current = records[i];
  if (!current) return;
  $('#summary').textContent = `${current.mode} ・ ${current.summary}`;
  renderRanking();
  const first = current.results[0];
  selectStock(first ? first.code : null);
}

function renderRanking() {
  const list = $('#rankingList');
  list.innerHTML = '';
  $('#emptyState').hidden = current.results.length > 0;
  current.results.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'row' + (s.code === selectedCode ? ' active' : '');
    row.onclick = () => selectStock(s.code);
    const col = badgeColor(s.score);
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
      </div>`;
    list.appendChild(row);
  });
}

function selectStock(code) {
  selectedCode = code;
  renderRanking();
  const s = (current.results || []).find((x) => x.code === code);
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
  drawCharts(s);
}

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
        ticks: { callback: v => '¥' + Math.round(v).toLocaleString(), font: { size: 10 } } })
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
