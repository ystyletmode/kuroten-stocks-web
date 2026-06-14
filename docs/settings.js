'use strict';
// 設定をブラウザから変更し、GitHub API 経由で config.json を更新／ワークフローを起動する。
(function () {
  const g = (id) => document.getElementById(id);
  const WORKFLOW_FILE = 'screening.yml';
  let configSha = null;

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
      lookbackDays: num(g('cfgLookback').value, 60),
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

  // --- イベント ---
  function init() {
    fillFiscalOptions();
    g('cfgRepo').value = detectRepo();
    g('cfgPat').value = localStorage.getItem('gh.pat') || '';
    g('settingsToggle').onclick = () => {
      const p = g('settingsPanel'); p.hidden = !p.hidden;
      if (!p.hidden && g('cfgPat').value && !configSha) loadConfig();
    };
    g('cfgScanMode').onchange = toggleCodeRow;
    g('btnLoad').onclick = () => { persistLocal(); loadConfig(); };
    g('btnSave').onclick = async () => {
      try { persistLocal(); setStatus('保存中…'); if (configSha === null) await loadConfig(); await saveConfig(); setStatus('設定を保存しました', true); }
      catch (e) { setStatus(e.message, false); }
    };
    g('btnSaveRun').onclick = async () => {
      try { persistLocal(); setStatus('保存して実行中…'); if (configSha === null) await loadConfig(); await saveConfig(); await runWorkflow();
        setStatus('保存し、スクリーニングを起動しました(数分後にこのページを再読み込み)', true); }
      catch (e) { setStatus(e.message, false); }
    };
    g('btnRun').onclick = async () => {
      try { persistLocal(); setStatus('実行起動中…'); await runWorkflow();
        setStatus('スクリーニングを起動しました(数分後に再読み込み)', true); }
      catch (e) { setStatus(e.message, false); }
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
