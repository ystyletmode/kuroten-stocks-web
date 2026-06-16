'use strict';
// 設定をブラウザから変更し、GitHub API 経由で config.json を更新／ワークフローを起動する。
(function () {
  const g = (id) => document.getElementById(id);
  const WORKFLOW_FILE = 'screening.yml';
  const WORKFLOW_PATH = '.github/workflows/screening.yml';
  let configSha = null;
  let workflowSha = null;

  // --- リポジトリ自動判定(<owner>.github.io/<repo>/ から) ---
  function detectRepo() {
    const saved = localStorage.getItem('gh.repo');
    if (saved) return saved;
    const host = location.hostname;       // <owner>.github.io
    const m = host.match(/^([^.]+)\.github\.io$/);
    if (m) {
      const owner = m[1];
      const seg = location.pathname.split('/').filter(Boolean);
      const repo = seg.length ? seg[0] : (owner + '.github.io');
      return owner + '/' + repo;
    }
    return '';
  }

  function setStatus(msg, ok) {
    const el = g('cfgStatus');
    el.textContent = msg;
    el.className = 'cfgstatus ' + (ok === true ? 'ok' : ok === false ? 'err' : '');
  }
  const b64encode = (s) => btoa(unescape(encodeURIComponent(s)));
  const b64decode = (b) => decodeURIComponent(escape(atob((b || '').replace(/\s/g, ''))));

  function ghHeaders() {
    return {
      'Authorization': 'Bearer ' + g('cfgPat').value.trim(),
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }
  function repoPath() {
    const r = g('cfgRepo').value.trim();
    if (!/^[^/]+\/[^/]+$/.test(r)) throw new Error('リポジトリは owner/repo 形式で入力してください');
    return r;
  }

  // --- フォーム ⇄ config ---
  function fillFiscalOptions() {
    const sel = g('cfgFiscal');
    for (let mm = 1; mm <= 12; mm++) {
      const o = document.createElement('option'); o.value = String(mm); o.textContent = mm + '月'; sel.appendChild(o);
    }
  }
  function configToForm(c) {
    g('cfgScanMode').value = c.scanMode || 'codeList';
    g('cfgCodeList').value = (c.codeList || []).join(', ');
    g('cfgLookback').value = c.lookbackDays ?? 60;
    g('cfgMaxCand').value = c.maxCandidates ?? 50;
    g('cfgBudgetOn').checked = !!c.applyBudgetFilter;
    g('cfgBudget').value = c.budgetYen ?? 100000;
    g('cfgMarket').value = c.market || '';
    g('cfgFiscal').value = c.fiscalMonth ? String(c.fiscalMonth) : '';
    g('cfgTheme').value = c.themeKeyword || '';
    g('cfgMinScore').value = c.minScore ?? 40;
    g('cfgRpm').value = String(c.requestsPerMinute ?? 5);
    g('cfgDelay').value = c.dataDelayDays ?? 90;
    const e = c.email || {};
    g('cfgEmailOn').checked = !!e.enabled;
    g('cfgEmailFrom').value = e.from || '';
    g('cfgEmailTo').value = e.to || '';
    toggleCodeRow();
  }
  function formToConfig() {
    const codes = g('cfgCodeList').value.split(/[\s,，]+/).map(s => s.trim()).filter(Boolean);
    return {
      scanMode: g('cfgScanMode').value,
      codeList: codes,
      minScore: num(g('cfgMinScore').value, 40),
      market: g('cfgMarket').value || null,
      fiscalMonth: g('cfgFiscal').value ? parseInt(g('cfgFiscal').value, 10) : null,
      themeKeyword: g('cfgTheme').value.trim(),
      budgetYen: num(g('cfgBudget').value, 100000),
      applyBudgetFilter: g('cfgBudgetOn').checked,
      requestsPerMinute: num(g('cfgRpm').value, 5),
      dataDelayDays: num(g('cfgDelay').value, 90),
      lookbackDays: (() => { const v = num(g('cfgLookback').value, 60); return v < 1 ? 60 : v; })(),
      maxCandidates: num(g('cfgMaxCand').value, 50),
      email: { enabled: g('cfgEmailOn').checked, from: g('cfgEmailFrom').value.trim(), to: g('cfgEmailTo').value.trim() },
    };
  }
  const num = (v, d) => { const n = parseInt(v, 10); return isNaN(n) ? d : n; };
  function toggleCodeRow() { g('rowCodeList').style.display = g('cfgScanMode').value === 'codeList' ? '' : 'none'; }

  // --- GitHub API ---
  async function loadConfig() {
    try {
      setStatus('読み込み中…');
      const res = await fetch(`https://api.github.com/repos/${repoPath()}/contents/config.json`, { headers: ghHeaders() });
      if (!res.ok) throw new Error('HTTP ' + res.status + '(トークン/リポジトリ名を確認)');
      const j = await res.json();
      configSha = j.sha;
      configToForm(JSON.parse(b64decode(j.content)));
      setStatus('現在の設定を読み込みました', true);
    } catch (e) { setStatus('読み込み失敗: ' + e.message, false); }
  }
  async function saveConfig() {
    const cfg = formToConfig();
    const res = await fetch(`https://api.github.com/repos/${repoPath()}/contents/config.json`, {
      method: 'PUT', headers: ghHeaders(),
      body: JSON.stringify({ message: 'config 更新(Webから)', content: b64encode(JSON.stringify(cfg, null, 2)), sha: configSha, branch: 'main' }),
    });
    if (!res.ok) throw new Error('保存失敗 HTTP ' + res.status + '(Contents権限を確認)');
    const j = await res.json();
    configSha = j.content.sha;
  }
  async function runWorkflow() {
    const res = await fetch(`https://api.github.com/repos/${repoPath()}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST', headers: ghHeaders(), body: JSON.stringify({ ref: 'main' }),
    });
    if (!(res.status === 204 || res.ok)) throw new Error('実行起動失敗 HTTP ' + res.status + '(Actions権限を確認)');
  }

  function persistLocal() {
    localStorage.setItem('gh.repo', g('cfgRepo').value.trim());
    localStorage.setItem('gh.pat', g('cfgPat').value.trim());
  }

  // --- 自動実行(cron)の読み書き。JST = UTC + 9 ---
  function cronSetStatus(msg, ok) {
    const el = g('cronStatus');
    el.textContent = msg;
    el.className = 'cfgstatus ' + (ok === true ? 'ok' : ok === false ? 'err' : '');
  }
  function fillTimeOptions() {
    const h = g('cfgAutoHour'), m = g('cfgAutoMin');
    for (let i = 0; i < 24; i++) { const o = document.createElement('option'); o.value = i; o.textContent = String(i).padStart(2, '0'); h.appendChild(o); }
    for (let i = 0; i < 60; i++) { const o = document.createElement('option'); o.value = i; o.textContent = String(i).padStart(2, '0'); m.appendChild(o); }
  }
  async function loadCron() {
    try {
      cronSetStatus('読み込み中…');
      const res = await fetch(`https://api.github.com/repos/${repoPath()}/contents/${WORKFLOW_PATH}`, { headers: ghHeaders() });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      workflowSha = j.sha;
      const text = b64decode(j.content);
      const mm = text.match(/cron:\s*['"]([^'"]+)['"]/);
      if (mm) {
        const parts = mm[1].trim().split(/\s+/);   // m h dom mon dow
        const utcMin = parseInt(parts[0], 10) || 0;
        const utcHour = parseInt(parts[1], 10) || 0;
        g('cfgAutoMin').value = utcMin;
        g('cfgAutoHour').value = (utcHour + 9) % 24;   // UTC→JST
      }
      cronSetStatus('現在の実行時刻を読み込みました', true);
    } catch (e) { cronSetStatus('読み込み失敗: ' + e.message + '(トークン/権限を確認)', false); }
  }
  async function saveCron() {
    try {
      cronSetStatus('保存中…');
      // ユーザーが選んだ時刻を最初に読む(この後の取得処理でフォームを上書きしないこと)
      const jstHour = parseInt(g('cfgAutoHour').value, 10);
      const jstMin = parseInt(g('cfgAutoMin').value, 10);
      if (isNaN(jstHour) || isNaN(jstMin)) throw new Error('時刻を選択してください');
      // SHAは下のGET取得で得るため、フォームを上書きする loadCron は呼ばない
      const res0 = await fetch(`https://api.github.com/repos/${repoPath()}/contents/${WORKFLOW_PATH}`, { headers: ghHeaders() });
      if (!res0.ok) throw new Error('HTTP ' + res0.status);
      const j0 = await res0.json();
      workflowSha = j0.sha;
      let text = b64decode(j0.content);
      const utcHour = (jstHour - 9 + 24) % 24;
      const newCron = `${jstMin} ${utcHour} * * *`;
      if (!/cron:\s*['"][^'"]+['"]/.test(text)) throw new Error('cron行が見つかりません');
      text = text.replace(/cron:\s*['"][^'"]+['"]/, `cron: '${newCron}'`);
      const put = await fetch(`https://api.github.com/repos/${repoPath()}/contents/${WORKFLOW_PATH}`, {
        method: 'PUT', headers: ghHeaders(),
        body: JSON.stringify({ message: '実行時刻を更新(Webから)', content: b64encode(text), sha: workflowSha, branch: 'main' }),
      });
      if (!put.ok) throw new Error('保存失敗 HTTP ' + put.status + '(Workflows権限を確認)');
      const pj = await put.json();
      workflowSha = pj.content.sha;
      cronSetStatus(`実行時刻を ${String(jstHour).padStart(2, '0')}:${String(jstMin).padStart(2, '0')} JST に保存しました`, true);
    } catch (e) { cronSetStatus(e.message, false); }
  }

  // --- 実行の進捗表示(GitHub Actions を追跡) ---
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let progEl = null, progFill = null, progText = null, progStart = 0;
  function ensureProgress() {
    if (progEl) return;
    if (!document.getElementById('runprogCss')) {
      const st = document.createElement('style'); st.id = 'runprogCss';
      st.textContent =
        '.runprog{flex:1 0 100%;margin-top:12px}' +
        '.runprog-track{height:10px;border-radius:6px;background:#e7eaee;overflow:hidden}' +
        '.runprog-fill{height:100%;width:0;border-radius:6px;background:var(--teal,#2bb3a3);transition:width .6s ease}' +
        '.runprog-fill.done{background:var(--green,#2aa84a)}' +
        '.runprog-fill.err{background:var(--red,#d23b2e)}' +
        '.runprog-text{margin-top:6px;font-size:12px;color:var(--muted,#6b7480)}';
      document.head.appendChild(st);
    }
    const host = g('btnSaveRun').closest('.actions') || g('btnSaveRun').parentElement;
    progEl = document.createElement('div'); progEl.className = 'runprog'; progEl.hidden = true;
    progEl.innerHTML = '<div class="runprog-track"><div class="runprog-fill"></div></div><div class="runprog-text"></div>';
    host.appendChild(progEl);
    progFill = progEl.querySelector('.runprog-fill');
    progText = progEl.querySelector('.runprog-text');
  }
  function progShow(pct, text, state) {
    ensureProgress();
    progEl.hidden = false;
    progFill.className = 'runprog-fill' + (state ? ' ' + state : '');
    if (pct != null) progFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (text != null) progText.textContent = text;
  }
  const secs = () => Math.round((Date.now() - progStart) / 1000);
  async function ghJSON(url) {
    const r = await fetch(url, { headers: ghHeaders() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function currentDataDate() {
    try { const r = await fetch('data/latest.json?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) { const j = await r.json(); return j.date || null; } } catch (e) {}
    return null;
  }
  async function waitForNewData(prevDate) {
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch('data/latest.json?t=' + Date.now(), { cache: 'no-store' });
        if (r.ok) { const j = await r.json(); if (!prevDate || j.date !== prevDate) return true; }
      } catch (e) {}
      await sleep(5000);
    }
    return false;
  }
  async function findRun(dispatchTime) {
    for (let i = 0; i < 15; i++) {
      try {
        const j = await ghJSON(`https://api.github.com/repos/${repoPath()}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=5`);
        const runs = (j.workflow_runs || []).filter(r => new Date(r.created_at).getTime() >= dispatchTime - 60000);
        if (runs.length) { runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); return runs[0]; }
      } catch (e) {}
      progShow(6 + i, `起動を確認中… (${secs()}秒)`);
      await sleep(4000);
    }
    return null;
  }
  async function trackRun(dispatchTime, prevDate) {
    ensureProgress();
    progStart = Date.now();
    progShow(5, '起動しました。実行を追跡します…');
    const run = await findRun(dispatchTime);
    if (!run) {
      progShow(40, `実行中… 完了後に自動で反映します (${secs()}秒)`);
      const ok = await waitForNewData(prevDate);
      if (ok) { progShow(100, `完了しました (${secs()}秒)`, 'done'); if (window.kurotenReload) await window.kurotenReload(); setTimeout(() => { if (progEl) progEl.hidden = true; }, 5000); }
      else progShow(100, '結果の確認がタイムアウトしました。少し待って手動で再読み込みしてください。', 'err');
      return;
    }
    while (true) {
      let r;
      try { r = await ghJSON(`https://api.github.com/repos/${repoPath()}/actions/runs/${run.id}`); }
      catch (e) { await sleep(5000); continue; }
      const st = r.status;
      if (st === 'completed') {
        if (r.conclusion === 'success') {
          progShow(95, '完了。最新結果を取得中…', 'done');
          await waitForNewData(prevDate);
          if (window.kurotenReload) await window.kurotenReload();
          progShow(100, `完了しました — 結果を反映しました (${secs()}秒)`, 'done');
          setTimeout(() => { if (progEl) progEl.hidden = true; }, 6000);
        } else if (r.conclusion === 'cancelled') {
          progShow(100, 'キャンセルされました（別の実行と重複した可能性）。もう一度お試しください。', 'err');
        } else {
          progShow(100, `失敗: ${r.conclusion || '不明'} — GitHub の Actions ログを確認してください`, 'err');
        }
        return;
      } else if (st === 'in_progress') {
        progShow(Math.min(90, 30 + secs() * 1.2), `スクリーニング実行中… (${secs()}秒)`);
      } else {
        progShow(20, `順番待ち（実行枠の確保中）… (${secs()}秒)`);
      }
      await sleep(5000);
    }
  }

  // --- イベント ---
  function init() {
    fillFiscalOptions();
    g('cfgRepo').value = detectRepo();
    g('cfgPat').value = localStorage.getItem('gh.pat') || '';
    g('settingsToggle').onclick = () => {
      const p = g('settingsPanel'); p.hidden = !p.hidden;
      if (!p.hidden && g('cfgPat').value && !configSha) loadConfig();
      // パネルを開いたら保存済みのスケジュール時刻も自動で反映(0:00のままにしない)
      if (!p.hidden && g('cfgPat').value && workflowSha === null) loadCron();
    };
    g('cfgScanMode').onchange = toggleCodeRow;
    g('btnLoad').onclick = () => { persistLocal(); loadConfig(); };
    g('btnSave').onclick = async () => {
      try { persistLocal(); setStatus('保存中…'); if (configSha === null) await loadConfig(); await saveConfig(); setStatus('設定を保存しました', true); }
      catch (e) { setStatus(e.message, false); }
    };
    g('btnSaveRun').onclick = async () => {
      try {
        persistLocal(); setStatus('保存して実行中…');
        if (configSha === null) await loadConfig();
        await saveConfig();
        const prevDate = await currentDataDate();
        await runWorkflow();
        setStatus('保存し、スクリーニングを起動しました', true);
        trackRun(Date.now(), prevDate);
      } catch (e) { setStatus(e.message, false); }
    };
    g('btnRun').onclick = async () => {
      try {
        persistLocal(); setStatus('実行起動中…');
        const prevDate = await currentDataDate();
        await runWorkflow();
        setStatus('スクリーニングを起動しました', true);
        trackRun(Date.now(), prevDate);
      } catch (e) { setStatus(e.message, false); }
    };
    fillTimeOptions();
    g('btnLoadCron').onclick = loadCron;
    g('btnSaveCron').onclick = saveCron;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
