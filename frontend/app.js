/* ═══════════════════════════════════════════════════════════════════════
   FACTORA — application logic
   Markets · Invest · Raise · Settlement · Intelligence · Developer console
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

/* ── Tiny DOM helpers ─────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const short = (s, n = 10) => (String(s || '').length > n ? String(s).slice(0, n) + '…' : String(s || ''));
const store = {
  get: (k, d = '') => localStorage.getItem('factora.' + k) ?? d,
  set: (k, v) => localStorage.setItem('factora.' + k, v),
};

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('toastStack').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 3200);
  setTimeout(() => t.remove(), 3700);
}

/* Action log — browser console (console.log is visible at the default level). */
const sessionLog = [];
function devlog(msg, kind = '') {
  sessionLog.unshift({ t: new Date(), msg, kind });
  if (sessionLog.length > 200) sessionLog.pop();
  try { console.log('%c[factora]' + (kind ? ':' + kind : ''), 'color:#D4AF6A;font-weight:600', msg); } catch { /* noop */ }
}

/* Never fail silently: any runtime error becomes a toast + session-log entry. */
window.addEventListener('error', (e) => {
  try { devlog('JS error: ' + e.message + ' @ ' + (e.filename || '') + ':' + (e.lineno || '?'), 'err'); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { devlog('Unhandled promise rejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason), 'err'); } catch {}
});

/* ── x402 helpers ─────────────────────────────────────────────────────── */
function decodePaymentRequired(res) {
  const b64 = res.headers.get('payment-required');
  if (!b64) return null;
  try { return JSON.parse(atob(b64)); } catch { return null; }
}
const hbarFromTinybars = (tb) => String(parseFloat((Number(tb || 0) / 1e8).toFixed(6)));
function settlementText(settlement) {
  if (!settlement) return '';
  const tx = settlement.transaction || settlement.transactionId || '';
  const network = String(settlement.network || 'hedera:testnet').replace('hedera:', '');
  const link = tx ? ` — <a href="https://hashscan.io/${network}/transaction/${encodeURIComponent(tx)}" target="_blank" rel="noopener">hashscan ↗</a>` : '';
  return `Settlement tx: <span class="hashchip">${esc(tx || '—')}</span>${link}`;
}
function hashscanLink(tx) {
  if (!tx) return '';
  return `<a href="https://hashscan.io/testnet/transaction/${encodeURIComponent(tx)}" target="_blank" rel="noopener">hashscan ↗</a>`;
}

/* Reads the NDJSON progress stream from /api/agent/paid-request/stream. */
async function runAgentPaymentStream(path, payload, onStep) {
  const res = await fetch('/api/agent/paid-request/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, payload }),
  });
  if (!res.ok || !res.body) throw new Error('Agent stream failed (HTTP ' + res.status + ')');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', final = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt; try { evt = JSON.parse(line); } catch { continue; }
      if (evt.type === 'step') onStep(evt);
      else if (evt.type === 'final') final = evt;
    }
  }
  if (!final) throw new Error('Agent stream ended without a final result');
  return final;
}

/* Payment-pipeline visual (invoice → sign → settle → execute). */
function pipelineHtml() {
  const steps = ['Requesting invoice', 'Signing payment', 'Settling on Hedera', 'Executing request'];
  return `<div class="pipeline">${steps.map((s, i) => `
    <div class="pipeline-step" data-i="${i}">
      <div class="pipeline-rail"><div class="pipeline-dot"></div>${i < steps.length - 1 ? '<div class="pipeline-line"></div>' : ''}</div>
      <div class="pipeline-label">${s}</div>
    </div>`).join('')}</div>`;
}
function updatePipeline(container, step, status, detail) {
  const labels = ['invoice', 'sign', 'settle', 'execute'];
  const idx = labels.findIndex((l) => String(step || '').toLowerCase().includes(l));
  const steps = container.querySelectorAll('.pipeline-step');
  steps.forEach((el, i) => {
    el.classList.remove('active', 'done', 'error');
    if (idx >= 0) {
      if (i < idx) el.classList.add('done');
      else if (i === idx) el.classList.add(status === 'done' ? 'done' : 'active');
      // When a phase completes, the next phase is implicitly in flight.
      else if (i === idx + 1 && status === 'done') el.classList.add('active');
    }
  });
  if (idx >= 0 && detail) {
    const stepEl = steps[idx];
    if (stepEl) {
      const d = stepEl.querySelector('.pipeline-label');
      if (d) d.innerHTML = esc(d.textContent.split(' — ')[0]) + ` <span class="pipeline-detail">— ${esc(detail)}</span>`;
    }
  }
}
/* Light the whole rail green (called when the final result lands). */
function completePipeline(container) {
  container.querySelectorAll('.pipeline-step').forEach((el) => {
    el.classList.remove('active', 'error');
    el.classList.add('done');
  });
}
async function settleThenReplace(container, renderFn) {
  completePipeline(container);
  await new Promise((r) => setTimeout(r, 700)); // let the user see the all-green rail
  renderFn();
}

/* Unpaid → 402 invoice panel with one-click agent payment. */
function payPanelHtml(invoice, payLabel, onPayName) {
  const req = invoice && invoice.accepts && invoice.accepts[0];
  if (!req) return `<div class="resultbox err">Payment required, but the invoice header could not be decoded.</div>`;
  const hbar = hbarFromTinybars(req.amount);
  return `
    <div class="paypanel">
      <h4>Payment required — x402 invoice</h4>
      <div class="paygrid">
        <div class="payrow"><span>Price</span><strong>${hbar} HBAR</strong></div>
        <div class="payrow"><span>Network</span><strong>${esc(req.network)}</strong></div>
        <div class="payrow"><span>Scheme</span><strong>${esc(req.scheme)}</strong></div>
        <div class="payrow"><span>Pay to</span><strong>${esc(short(req.payTo, 16))}</strong></div>
        <div class="payrow"><span>Fee payer</span><strong>${esc(short((req.extra && req.extra.feePayer) || '—', 16))}</strong></div>
      </div>
      <button class="btn btn-gold" onclick="${onPayName}()">${esc(payLabel)} — ${hbar} HBAR</button>
      <p class="paynote">Signed server-side by the agent wallet; settled through the Blocky402 facilitator. Your browser never holds keys.</p>
    </div>`;
}

/* ── System pills (topbar) ────────────────────────────────────────────── */
function setPill(id, state) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('online', 'offline', 'checking');
  el.classList.add(state);
}
async function checkServerHealth() {
  setPill('sysServer', 'checking');
  try {
    const r = await fetch('/health');
    if (!r.ok) throw new Error();
    setPill('sysServer', 'online');
    return true;
  } catch { setPill('sysServer', 'offline'); return false; }
}
let agentNetwork = 'hedera:testnet';
async function checkAgentStatus() {
  setPill('sysAgent', 'checking');
  try {
    const r = await fetch('/api/agent/status', { cache: 'no-store' });
    const d = await r.json();
    if (!d.configured) throw new Error('not configured');
    agentNetwork = d.network || agentNetwork;
    setPill('sysAgent', 'online');
    $('sysAgent').title = `Agent wallet ${d.accountId} · ${d.network}`;
    $('netPillText').textContent = d.network === 'hedera:mainnet' ? 'Hedera Mainnet' : 'Hedera Testnet';
    return d;
  } catch { setPill('sysAgent', 'offline'); return null; }
}
async function checkAtsHealth() {
  setPill('sysAts', 'checking');
  try {
    const r = await fetch('/api/ats/health');
    const d = await r.json();
    if (!r.ok || !d.connected) throw new Error(d.error || 'unreachable');
    setPill('sysAts', 'online');
    $('sysAts').title = `ATS sidecar ${d.serviceUrl} · ${d.service}`;
    return d;
  } catch { setPill('sysAts', 'offline'); return null; }
}

/* ── Router ───────────────────────────────────────────────────────────── */
const VIEWS = ['markets', 'invest', 'raise', 'settlement', 'intelligence'];
const viewLoaders = {};
function navigate(name) {
  if (!VIEWS.includes(name)) name = 'markets';
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const view = $('view-' + name);
  if (view) view.classList.add('active');
  document.querySelectorAll('.navlink').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  if (viewLoaders[name]) viewLoaders[name]();
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', () => navigate(location.hash.replace('#', '')));
document.querySelectorAll('[data-nav]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    navigate(a.dataset.nav);
  });
});

/* ═══════════════════════ MARKETS ═══════════════════════ */
let proposalsCache = [];

function statusPill(p) {
  if (p.status === 'ACCEPTED') return '<span class="pill pill-accepted">Signed</span>';
  return '<span class="pill pill-pending">Open</span>';
}
function verifiedBadge(p) {
  if (p.selfieCheck && p.selfieCheck.status === 'VERIFIED') {
    return ' <span class="pill pill-verified" title="World ID Selfie Check verified">Identity verified</span>';
  }
  return '';
}
function listingCard(p, opts = {}) {
  const dd = p.debtDocument || {};
  const shortAddr = String(p.proposerAddress || '').startsWith('0x')
    ? p.proposerAddress.slice(0, 6) + '…' + p.proposerAddress.slice(-4)
    : (p.proposerAddress || '—');
  const actions = opts.actions ? `<div class="listing-foot" style="margin-top:12px;">${opts.actions(p)}</div>` : '';
  return `
    <article class="listing">
      <div class="listing-top">
        <div>
          <span class="listing-id">${esc(short(p.id, 8))} · ${new Date(p.createdAt).toLocaleDateString()}</span>
          <h4 class="listing-name">${esc(dd.debtorCompany || 'Unnamed obligor')}</h4>
          <span class="listing-sub">${esc(dd.debtType || 'Debt')} · ${esc(dd.industry || 'n/a')} · inv ${esc(dd.invoiceNumber || '—')}</span>
        </div>
        <div>${statusPill(p)}${verifiedBadge(p)}</div>
      </div>
      <div class="listing-metrics">
        <div><span class="metric-label">Nominal</span><span class="metric-value">${usd(p.amount)}</span></div>
        <div><span class="metric-label">Advance</span><span class="metric-value">${usd(p.requiredAmount)}</span></div>
        <div><span class="metric-label">Term</span><span class="metric-value">${p.returnDateInDays}d</span></div>
        <div><span class="metric-label">APY</span><span class="metric-value apy">${Number(p.apy).toFixed(1)}%</span></div>
      </div>
      <div class="listing-foot">
        <span class="addr" title="${esc(p.proposerAddress)}">issuer ${esc(shortAddr)}</span>
        <span class="addr">due ${esc(dd.dueDate || '—')}</span>
      </div>
      ${actions}
    </article>`;
}

async function loadProposals() {
  const grid = $('poolGrid');
  try {
    const status = $('poolStatusFilter').value;
    const res = await fetch('/api/proposals' + (status ? '?status=' + encodeURIComponent(status) : ''));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    proposalsCache = data.proposals || [];
    renderPool(proposalsCache);
    updateMarketStats(proposalsCache);
  } catch (err) {
    grid.innerHTML = `<div class="placeholder"><p>Could not load listings — ${esc(err.message)}</p></div>`;
  }
}
function renderPool(list) {
  const grid = $('poolGrid');
  if (!list.length) {
    grid.innerHTML = `<div class="placeholder"><p>No listings${$('poolStatusFilter').value ? ' match this filter' : ' yet'}. Be the first — <a href="#raise" data-nav="raise">raise capital</a>.</p></div>`;
    return;
  }
  grid.innerHTML = list.map((p) => listingCard(p, {
    actions: (pp) => (pp.status === 'PENDING' && !pp.buyerAddress
      ? `<button class="btn btn-ghost btn-sm" onclick="openSelfie('${pp.id}','buyer')">Invest in this receivable</button>`
      : (pp.status === 'ACCEPTED' ? '<span class="pill pill-accepted">Reserved by investor</span>' : '')),
  })).join('');
  grid.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.nav); }));
}
function updateMarketStats(list) {
  $('statListings').textContent = list.length;
  const vol = list.reduce((s, p) => s + Number(p.amount || 0), 0);
  $('statVolume').textContent = vol >= 1000 ? '$' + (vol / 1000).toFixed(1) + 'k' : usd(vol);
  const apys = list.map((p) => Number(p.apy || 0)).sort((a, b) => a - b);
  $('statApy').textContent = apys.length ? apys[Math.floor(apys.length / 2)].toFixed(1) + '%' : '—';
  const terms = list.map((p) => Number(p.returnDateInDays || 0)).filter(Boolean);
  $('statTerm').textContent = terms.length ? Math.round(terms.reduce((a, b) => a + b, 0) / terms.length) + 'd' : '—';
}
viewLoaders.markets = loadProposals;

/* ═══════════════════════ INVEST ═══════════════════════ */
let investCriteria = null;
let reportData = null;

function getInvestCriteria() {
  return {
    amountMin: parseFloat($('invAmountMin').value),
    amountMax: parseFloat($('invAmountMax').value),
    durationInDaysMin: parseInt($('invDurationMin').value, 10),
    durationInDaysMax: parseInt($('invDurationMax').value, 10),
    apyInPercentMin: parseFloat($('invApyMin').value),
  };
}
function getReportPayload() {
  const note = ($('invNote').value || '').trim();
  return { ...investCriteria, ...(note ? { userMessage: note } : {}) };
}
function criteriaLine() {
  if (!investCriteria) return '';
  return `$${investCriteria.amountMin.toLocaleString()}–$${investCriteria.amountMax.toLocaleString()} · ${investCriteria.durationInDaysMin}–${investCriteria.durationInDaysMax}d · min APY ${investCriteria.apyInPercentMin}%`;
}

let lastSearchResults = null;
function renderInvestResults(results) {
  const out = $('investResults');
  const count = $('resultsCount');
  if (count) {
    count.textContent = results.length + (results.length === 1 ? ' match' : ' matches');
    count.classList.remove('hidden');
  }
  if (!results.length) {
    out.innerHTML = '<div class="placeholder placeholder-quiet"><p>No receivables matched this mandate. Loosen the criteria or come back when new listings publish.</p></div>';
    return;
  }
  out.innerHTML = results.map((item) => {
    const p = item.proposal || item;
    return listingCard(p, {
      actions: (pp) => (pp.status === 'PENDING' && !pp.buyerAddress
        ? `<button class="btn btn-gold btn-sm" onclick="openSelfie('${pp.id}','buyer')">Buy this debt</button>`
        : '<span class="pill pill-accepted">Signed · reserved for you</span>'),
    });
  }).join('');
}
async function handleInvestSearch(e) {
  e.preventDefault();
  investCriteria = getInvestCriteria();
  reportData = null;
  $('smartReportSection').classList.add('hidden');
  $('smartReportBtn').classList.add('hidden');
  $('resultsCount').classList.add('hidden');
  const out = $('investResults');
  out.innerHTML = '<div class="placeholder placeholder-quiet"><div class="spinner"></div><p>Screening the book…</p></div>';
  devlog('Investor screen: ' + criteriaLine());
  try {
    const res = await fetch('/api/buyer/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(investCriteria),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = (data.issues || []).map((i) => `${i.field}: ${i.message}`).join(' · ') || data.error || 'Search failed';
      out.innerHTML = `<div class="resultbox err">${esc(msg)}</div>`;
      return;
    }
    lastSearchResults = data.proposals || data.results || [];
    renderInvestResults(lastSearchResults);
    $('smartReportBtn').classList.remove('hidden');
    toast(`${lastSearchResults.length} match${lastSearchResults.length === 1 ? '' : 'es'} found`, 'ok');
  } catch (err) {
    out.innerHTML = `<div class="resultbox err">Network error: ${esc(err.message)}</div>`;
  }
}

/* Paid AI credit report — direct (402) then via agent stream. */
async function handleSmartReport() {
  if (!investCriteria) return;
  const section = $('smartReportSection');
  const container = $('smartReportContainer');
  const btn = $('smartReportBtn');
  section.classList.remove('hidden');
  btn.disabled = true;
  $('reportMeta').classList.add('hidden');
  container.innerHTML = '<div class="placeholder placeholder-quiet"><div class="spinner"></div><p>Preparing AI credit report…</p></div>';
  try {
    const res = await fetch('/api/buyer/smart-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getReportPayload()),
    });
    if (res.status === 402) {
      const invoice = decodePaymentRequired(res);
      container.innerHTML = payPanelHtml(invoice, 'Pay & generate report', 'generateReportViaAgent');
      btn.disabled = false;
      devlog('Smart report: 402 invoice received');
      toast('Invoice received — confirm the payment to generate the report', 'ok');
      container.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Report failed (HTTP ' + res.status + ')');
    finishReport({ ...data, generatedAt: new Date().toISOString() }, null);
  } catch (err) {
    container.innerHTML = `<div class="resultbox err">${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}
async function generateReportViaAgent() {
  const container = $('smartReportContainer');
  const metaEl = $('reportMeta');
  if (!investCriteria) return;
  container.innerHTML = pipelineHtml();
  try {
    const final = await runAgentPaymentStream('/api/buyer/smart-report', getReportPayload(), (evt) =>
      updatePipeline(container, evt.step, evt.status, evt.detail));
    if (!final.ok || !final.data || typeof final.data.count === 'undefined') {
      container.innerHTML = `<div class="resultbox err">${esc(final.error || 'Agent payment failed')}</div>`;
      return;
    }
    await settleThenReplace(container, () => {
      finishReport({ ...final.data, generatedAt: new Date().toISOString() }, final.settlement);
    });
  } catch (err) {
    container.innerHTML = `<div class="resultbox err">${esc(err.message)}</div>`;
  }
}
function finishReport(report, settlement) {
  reportData = report;
  renderSmartReport($('smartReportContainer'), report);
  const usage = report.usage;
  const usageEl = $('reportUsage');
  if (usageEl) {
    usageEl.textContent = usage && usage.totalTokens
      ? `${usage.totalTokens} LLM tokens · ${hbarFromTinybars(usage.chargedTinybars || 0)} HBAR`
      : 'per-token billing';
    usageEl.classList.remove('hidden');
  }
  $('reportMeta').innerHTML = `Criteria: ${esc(criteriaLine())}${settlement ? ' · ' + settlementText(settlement) : ''} · Generated ${new Date().toLocaleTimeString()}`;
  $('reportMeta').classList.remove('hidden');
  $('smartReportSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  devlog('AI credit report rendered (' + report.count + ' evaluated)', 'ok');
}

/* ── Smart report rendering ───────────────────────────────────────────── */
function marketApyStats(mb) {
  const benchmarks = Object.values((mb && mb.messari && mb.messari.benchmarks) || {});
  if (!benchmarks.length) return null;
  const best = benchmarks.reduce((a, b) => ((b.maxSupplyApy || 0) > (a.maxSupplyApy || 0) ? b : a));
  if (!(best.maxSupplyApy > 0)) return null;
  return {
    maxApyPct: (best.maxSupplyApy * 100).toFixed(2),
    topMarket: best.topMarket,
    marketsTracked: (mb.messari.detailedRates || []).length,
  };
}
function riskPill(level) {
  const map = { LOW: 'pill-low', MEDIUM: 'pill-medium', HIGH: 'pill-high' };
  return `<span class="pill ${map[level] || 'pill-medium'}">${esc(level || 'N/A')} risk</span>`;
}
function gaugeSvg(score) {
  const R = 26, C = 2 * Math.PI * R;
  return `<svg class="fit-gauge" viewBox="0 0 60 60" data-score="${score}">
    <circle class="gauge-track" cx="30" cy="30" r="${R}"></circle>
    <circle class="gauge-fill" cx="30" cy="30" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C}"></circle>
    <text class="gauge-num" x="30" y="35" text-anchor="middle" data-target="${score}">0</text>
  </svg>`;
}
function renderSmartReport(container, report) {
  const mb = report.marketBenchmark || {};
  const results = report.results || [];
  const scores = results.map((r) => Number(r.evaluation && r.evaluation.fitScore) || 0);
  const best = scores.length ? Math.max(...scores) : 0;
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const counts = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  results.forEach((r) => { const lv = (r.evaluation && r.evaluation.riskLevel) || 'MEDIUM'; counts[lv] = (counts[lv] || 0) + 1; });
  const market = marketApyStats(mb);

  container.innerHTML = `
    <div class="report-strip">
      <div class="report-stat tone-cyan"><span class="metric-label">Matches evaluated</span><span class="report-stat-value">${report.count}</span><span class="report-stat-sub">passed hard filter</span></div>
      <div class="report-stat tone-gold"><span class="metric-label">Best fit score</span><span class="report-stat-value">${best}</span><span class="report-stat-sub">out of 100</span></div>
      <div class="report-stat"><span class="metric-label">Average fit</span><span class="report-stat-value">${avg.toFixed(1)}</span><span class="report-stat-sub">portfolio mean</span></div>
      <div class="report-stat ${counts.HIGH > 0 ? 'tone-rose' : 'tone-emerald'}"><span class="metric-label">High-risk picks</span><span class="report-stat-value">${counts.HIGH}</span><span class="report-stat-sub">${counts.HIGH > 0 ? 'review rationale' : 'nothing alarming'}</span></div>
      <div class="report-stat tone-emerald"><span class="metric-label">Market APY</span><span class="report-stat-value">${Number(mb.averageMarketApy || 0).toFixed(2)}%</span><span class="report-stat-sub">${market ? `max ${market.maxApyPct}% (${esc(market.topMarket)})` : 'benchmark feed'}</span></div>
    </div>
    ${report.overallSummary ? `
    <div class="ai-panel ai-verdict">
      <div class="ai-panel-label"><span class="ai-chip">AI</span> Desk verdict — AI underwriter</div>
      <p class="ai-panel-text">${esc(report.overallSummary)}</p>
    </div>` : ''}
    ${report.marketReview ? `
    <div class="ai-panel">
      <div class="ai-panel-label"><span class="ai-chip">AI</span> Market review — how today's DeFi yields frame this mandate</div>
      <p class="ai-panel-text">${esc(report.marketReview)}</p>
    </div>` : ''}
    ${results.length === 0
      ? '<div class="placeholder placeholder-quiet"><p>No proposals were available to underwrite for this mandate.</p></div>'
      : `<div class="evaluation-grid">${results.map((item, i) => renderEvaluationCard(item, i)).join('')}</div>`}`;

  const C = 2 * Math.PI * 26;
  requestAnimationFrame(() => {
    container.querySelectorAll('.fit-gauge').forEach((g) => {
      const score = Number(g.dataset.score) || 0;
      g.querySelector('.gauge-fill').style.strokeDashoffset = String(C * (1 - score / 100));
      const num = g.querySelector('.gauge-num');
      const target = Number(num.dataset.target) || 0;
      const t0 = performance.now();
      (function tick(now) {
        const p = Math.min((now - t0) / 900, 1);
        num.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(tick);
      })(t0);
    });
  });
}

/* ═══════════════════════ RAISE ═══════════════════════ */
function raiseTermDays() {
  const from = $('raiseInvoiceDate').value, to = $('raiseDueDate').value;
  if (!from || !to) return 0;
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
}
function updateApyPreview() {
  const face = parseFloat($('raiseFaceValue').value) || 0;
  const advance = parseFloat($('raiseAdvance').value) || 0;
  const days = raiseTermDays();
  const out = $('raiseApyPreview'), details = $('raiseApyDetails');
  if (face <= 0 || advance <= 0 || days <= 0) {
    out.textContent = '0.00%';
    details.textContent = days < 0 ? 'Maturity must fall after the invoice date.' : 'Yield: $0 (0%) · Term: 0 days';
    return;
  }
  const yieldUsd = face - advance;
  const apy = (yieldUsd / advance) * (365 / days) * 100;
  out.textContent = apy.toFixed(2) + '%';
  details.textContent = `Yield: ${usd(yieldUsd)} (${((yieldUsd / face) * 100).toFixed(1)}% discount) · Term: ${days} days`;
}
function randomAddress() {
  let a = '0x';
  for (let i = 0; i < 40; i++) a += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return a;
}
function buildRaisePayload() {
  const debtDocument = {
    debtType: $('raiseDebtType').value,
    industry: $('raiseIndustry').value.trim(),
    debtorCompany: $('raiseDebtor').value.trim(),
    invoiceNumber: $('raiseInvoiceNo').value.trim(),
    invoiceDate: $('raiseInvoiceDate').value,
    dueDate: $('raiseDueDate').value,
    faceValue: parseFloat($('raiseFaceValue').value),
    currency: 'USD',
  };
  const jurisdiction = $('raiseJurisdiction').value.trim();
  if (jurisdiction) debtDocument.jurisdiction = jurisdiction;
  const collateral = $('raiseCollateral').value.trim();
  if (collateral) debtDocument.collateralDescription = collateral;
  if ($('raiseRecourse').checked) debtDocument.recourse = true;
  return { proposerAddress: $('raiseProposer').value.trim(), requiredAmount: parseFloat($('raiseAdvance').value), debtDocument };
}
function raiseMessage(html, kind) {
  $('raiseMessages').innerHTML = html ? `<div class="resultbox ${kind || ''}">${html}</div>` : '';
}
async function handleRaiseSubmit(e) {
  e.preventDefault();
  const payload = buildRaisePayload();
  const btn = $('raiseSubmitBtn');
  btn.disabled = true;
  $('raiseSubmitSpinner').classList.remove('hidden');
  devlog('Publishing listing…');
  try {
    const res = await fetch('/api/proposals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 402) {
      const invoice = decodePaymentRequired(res);
      raiseMessage(payPanelHtml(invoice, 'Pay & publish listing', 'publishViaAgent'));
      devlog('Listing publish: 402 invoice received');
      toast('Invoice received — confirm the payment to publish', 'ok');
      $('raiseMessages').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      const msg = (data.issues || []).map((i) => `${i.field}: ${i.message}`).join(' · ') || data.error || 'Publishing failed';
      raiseMessage(esc(msg), 'err');
      return;
    }
    raiseMessage(`✓ <strong>Listing published.</strong> ID ${esc(short(data.proposal.id, 8))} · APY ${data.proposal.apy}% — now visible on the Markets order book.`, 'ok');
    devlog('Listing published: ' + data.proposal.id, 'ok');
    $('raiseForm').reset();
    updateApyPreview();
    loadProposals();
  } catch (err) {
    raiseMessage('Network error: ' + esc(err.message), 'err');
  } finally {
    btn.disabled = false;
    $('raiseSubmitSpinner').classList.add('hidden');
  }
}
async function publishViaAgent() {
  raiseMessage(pipelineHtml());
  try {
    const final = await runAgentPaymentStream('/api/proposals', buildRaisePayload(), (evt) =>
      updatePipeline($('raiseMessages'), evt.step, evt.status, evt.detail));
    if (final.ok && final.data && final.data.proposal) {
      const tx = settlementText(final.settlement);
      await settleThenReplace($('raiseMessages'), () => {
        raiseMessage(`✓ <strong>Listing published &amp; paid on-chain.</strong> ID ${esc(short(final.data.proposal.id, 8))} · APY ${final.data.proposal.apy}%<br><small>${tx}</small>`, 'ok');
      });
      devlog('Listing published via x402: ' + final.data.proposal.id, 'ok');
      $('raiseForm').reset();
      updateApyPreview();
      loadProposals();
    } else {
      raiseMessage(esc(final.error || 'Agent payment failed'), 'err');
    }
  } catch (err) {
    raiseMessage(esc(err.message), 'err');
  }
}

function renderEvaluationCard(item, index) {
  const p = item.proposal;
  const ev = item.evaluation || {};
  const da = ev.debtAnalysis || {};
  const score = Number(ev.fitScore) || 0;
  const dd = p.debtDocument || {};
  return `
    <div class="evaluation">
      <div class="evaluation-head">
        ${gaugeSvg(score)}
        <div class="evaluation-title">
          <strong>#${index + 1} ${esc(dd.debtorCompany || short(p.id, 8))}</strong>
          <small>${usd(p.amount)} face · ${usd(p.requiredAmount)} advance · ${p.returnDateInDays}d · APY ${Number(p.apy).toFixed(1)}%</small>
        </div>
        ${riskPill(ev.riskLevel)}
      </div>
      <p class="evaluation-rec">${esc(ev.recommendation || 'No recommendation recorded.')}</p>
      ${da.status ? `
      <div class="debt-review">
        <b>Debt document review</b> — ${esc(da.status)} · collection confidence <b>${Number.isFinite(Number(da.collectionConfidenceScore)) ? da.collectionConfidenceScore : 0}/100</b> · debt quality <b>${esc(da.debtQuality || 'UNKNOWN')}</b><br/>
        ${esc(da.underwriterComment || '')}
        ${da.keyRisks && da.keyRisks.length ? `<div class="risk-note">Key risks: ${esc(da.keyRisks.join('; '))}</div>` : ''}
        ${da.missingEvidence && da.missingEvidence.length ? `<div class="risk-note">Missing evidence: ${esc(da.missingEvidence.join('; '))}</div>` : ''}
      </div>` : ''}
      <div class="listing-foot" style="margin-top:12px;">
        <span class="addr">${esc(dd.debtType || '')} · inv ${esc(dd.invoiceNumber || '—')} · due ${esc(dd.dueDate || '—')}</span>
        ${p.status === 'PENDING' ? `<button class="btn btn-gold btn-sm" onclick="openSelfie('${p.id}','buyer')">Buy this debt</button>` : '<span class="pill pill-accepted">Signed</span>'}
      </div>
    </div>`;
}
function copyReportSummary() {
  if (!reportData) return;
  const mb = reportData.marketBenchmark || {};
  const lines = [`Factora AI Credit Report — ${new Date(reportData.generatedAt).toLocaleString()}`, `Matches: ${reportData.count}`, `Market APY: ${mb.averageMarketApy}%`];
  if (reportData.marketReview) lines.push(`Review: ${reportData.marketReview}`);
  if (reportData.overallSummary) lines.push(`Verdict: ${reportData.overallSummary}`);
  (reportData.results || []).forEach((item, i) => {
    const p = item.proposal, ev = item.evaluation || {};
    lines.push(`${i + 1}. ${(p.debtDocument && p.debtDocument.debtorCompany) || p.id} — fit ${ev.fitScore}/100 — ${ev.riskLevel} risk — APY ${p.apy}%`);
    if (ev.recommendation) lines.push('   ' + ev.recommendation);
  });
  navigator.clipboard.writeText(lines.join('\n')).then(() => toast('Report summary copied', 'ok'));
}
function downloadReportJson() {
  if (!reportData) return;
  const blob = new Blob([JSON.stringify(reportData, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `factora-credit-report-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Report JSON exported', 'ok');
}


/* Seller: my listings + World ID verification states. */
async function loadMyListings(e) {
  if (e) e.preventDefault();
  const key = $('myListingsKey').value.trim();
  const listEl = $('myListings');
  const meta = $('myListingsMeta');
  if (!key.startsWith('0x')) {
    meta.textContent = 'Enter a valid issuer wallet (0x…).';
    return;
  }
  store.set('proposerKey', key);
  try {
    const res = await fetch('/api/proposals?proposer=' + encodeURIComponent(key));
    const data = await res.json();
    const mine = data.proposals || [];
    meta.textContent = mine.length ? `${mine.length} listing${mine.length === 1 ? '' : 's'} on record.` : 'No listings found for this wallet.';
    listEl.innerHTML = mine.map(renderMyListing).join('');
  } catch (err) {
    meta.textContent = 'Could not load listings: ' + err.message;
  }
}
function renderMyListing(p) {
  const dd = p.debtDocument || {};
  const signed = p.status === 'ACCEPTED' || p.buyerSignature;
  let action, note;
  if (p.selfieCheck && p.selfieCheck.status === 'VERIFIED') {
    action = '<span class="pill pill-verified">Identity verified</span>';
    note = `Verified ${p.selfieCheck.verifiedAt ? new Date(p.selfieCheck.verifiedAt).toLocaleString() : ''}`;
  } else if (signed) {
    action = `<button class="btn btn-ghost btn-sm" onclick="openSelfie('${p.id}','seller')">Complete identity verification</button>`;
    note = `Signed by a World ID-verified buyer${p.buyerSignature && p.buyerSignature.signedAt ? ' · ' + new Date(p.buyerSignature.signedAt).toLocaleString() : ''}`;
  } else {
    action = '<span class="pill pill-pending">Awaiting investor</span>';
    note = 'A verified investor signs this listing to reserve it.';
  }
  return `
    <article class="listing">
      <div class="listing-top">
        <div>
          <span class="listing-id">${esc(short(p.id, 8))}</span>
          <h4 class="listing-name">${esc(dd.debtorCompany || 'Unnamed obligor')}</h4>
          <span class="listing-sub">${usd(p.amount)} face · ${usd(p.requiredAmount)} advance · APY ${Number(p.apy).toFixed(1)}% · ${p.returnDateInDays}d</span>
        </div>
        ${signed ? '<span class="pill pill-accepted">Signed</span>' : '<span class="pill pill-pending">Open</span>'}
      </div>
      <div class="listing-foot" style="margin-top:10px;">
        <span class="addr">${esc(note)}</span>
        ${action}
      </div>
    </article>`;
}
viewLoaders.raise = () => {};

/* ── World ID Selfie Check modal (buyer sign / seller verify) ─────────── */
const selfieState = { proposalId: null, mode: 'seller' };
const SELFIE_DEFAULT_APP_ID = 'app_d5e4029b334e9d0ee4d9c45408af8035';

function openSelfie(proposalId, mode = 'seller') {
  selfieState.proposalId = proposalId;
  selfieState.mode = mode === 'buyer' ? 'buyer' : 'seller';
  const isBuyer = selfieState.mode === 'buyer';
  $('selfieModeLabel').textContent = isBuyer ? 'Purchase · proof of personhood' : 'Issuer verification';
  $('selfieTitle').textContent = isBuyer ? 'Buy this debt' : 'Verify your identity';
  $('selfieDesc').innerHTML = isBuyer
    ? `To sign (buy) listing <strong>#${esc(short(proposalId, 8))}</strong>, verify you are a real, live human with World ID Selfie Check. Your verified signature reserves the listing (status → <strong>ACCEPTED</strong>) and notifies the issuer.`
    : `Prove you are the real, live human behind listing <strong>#${esc(short(proposalId, 8))}</strong>. Selfie Check (Beta) is an abuse-prevention signal that reduces sybil and scripted-listing risk.`;
  if (!$('selfieAppId').value.trim()) $('selfieAppId').value = store.get('worldAppId', SELFIE_DEFAULT_APP_ID);
  if (!$('selfieKey').value.trim()) $('selfieKey').value = store.get('worldSigningKey', '');
  $('selfieConnector').classList.add('hidden');
  $('selfieResult').classList.add('hidden');
  setSelfieStatus('Enter the World App ID and start the flow.', false);
  $('selfieModal').classList.remove('hidden');
}
function closeSelfie() {
  $('selfieModal').classList.add('hidden');
  selfieState.proposalId = null;
}
function setSelfieStatus(msg, isErr) {
  const el = $('selfieStatus');
  el.textContent = msg;
  el.classList.toggle('err', Boolean(isErr));
}
async function startSelfie() {
  const proposalId = selfieState.proposalId;
  if (!proposalId) return;
  const appId = $('selfieAppId').value.trim();
  if (!appId.startsWith('app_')) { setSelfieStatus('Enter a valid World App ID (app_…).', true); return; }
  store.set('worldAppId', appId);
  const signingKey = $('selfieKey').value.trim();
  if (signingKey && !/^0x[0-9a-fA-F]{64}$/.test(signingKey)) {
    setSelfieStatus('The RP signing key must be 0x + 64 hex chars.', true);
    return;
  }
  if (signingKey) store.set('worldSigningKey', signingKey);

  const btn = $('selfieStartBtn');
  btn.disabled = true;
  $('selfieSpinner').classList.remove('hidden');
  $('selfieResult').classList.add('hidden');
  try {
    setSelfieStatus('① Requesting signed RP context…');
    const rpRes = await fetch('/api/world/rp-signature', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signingKey ? { proposalId, signingKey } : { proposalId }),
    });
    if (!rpRes.ok) throw new Error('RP signature failed: ' + (await rpRes.text()));
    const rp = await rpRes.json();

    setSelfieStatus('② Preparing World ID request (staging)…');
    const { IDKit, selfieCheckLegacy } = await import('https://cdn.jsdelivr.net/npm/@worldcoin/idkit-core@4/+esm');
    const request = await IDKit.request({
      app_id: appId,
      action: 'mandatory-selfie-check',
      rp_context: { rp_id: rp.rp_id, nonce: rp.nonce, created_at: rp.created_at, expires_at: rp.expires_at, signature: rp.signature },
      allow_legacy_proofs: true,
      environment: 'staging',
    }).preset(selfieCheckLegacy({ signal: proposalId }));

    const uri = request.connectorURI;
    if (!uri) throw new Error('No connectorURI returned — check the App ID and RP configuration.');
    $('selfieConnectorUri').textContent = uri;
    $('selfieConnector').classList.remove('hidden');
    setSelfieStatus('③ Complete the flow in the World App / Simulator. Waiting…');

    const completion = await request.pollUntilCompletion({ pollInterval: 2000, timeout: 180000 });
    if (!completion.success) throw new Error('Selfie Check failed: ' + (completion.error || 'unknown'));

    setSelfieStatus('④ Proof received — verifying with World…');
    const verifyRes = await fetch('/api/world/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, proof: completion.result, role: selfieState.mode }),
    });
    const verifyData = await verifyRes.json();
    if (!verifyRes.ok) throw new Error(verifyData.message || verifyData.error || 'Verification rejected (HTTP ' + verifyRes.status + ')');

    const isBuyer = selfieState.mode === 'buyer';
    const box = $('selfieResult');
    box.className = 'resultbox ok';
    box.innerHTML = isBuyer
      ? '✓ <strong>Selfie check successful — proposal signed!</strong> The listing is now ACCEPTED and the issuer can verify their identity.'
      : `✓ <strong>Selfie check successful</strong> — issuer verified${verifyData.selfieCheck && verifyData.selfieCheck.nullifier ? ` <small>(nullifier ${esc(short(verifyData.selfieCheck.nullifier, 12))}…)</small>` : ''}`;
    box.classList.remove('hidden');
    setSelfieStatus(isBuyer ? 'Done. Refresh Markets to see the reserved listing.' : 'Done. This listing is now marked identity-verified.', false);
    devlog('Selfie check verified (' + selfieState.mode + ') for ' + proposalId, 'ok');
    if (isBuyer && Array.isArray(lastSearchResults)) {
      const hit = lastSearchResults.find((it) => (it.proposal || it).id === proposalId);
      if (hit) {
        const p = hit.proposal || hit;
        p.status = 'ACCEPTED';
        p.buyerAddress = p.buyerAddress || 'world-id verified buyer';
      }
      renderInvestResults(lastSearchResults);
      toast('Listing reserved — the issuer has been notified', 'ok');
    }
    loadProposals();
  } catch (err) {
    setSelfieStatus('⚠ ' + (err && err.message ? err.message : String(err)), true);
  } finally {
    btn.disabled = false;
    $('selfieSpinner').classList.add('hidden');
  }
}

/* ═══════════════════════ SETTLEMENT (ATS) ═══════════════════════ */
let atsRegistrations = [];

const PILL_BY_STATUS = {
  REGISTERED: 'pill-registered', FUNDED: 'pill-funded', MATURED: 'pill-matured',
  REDEEMED: 'pill-redeemed', DEFAULTED: 'pill-defaulted',
};
function atsStatusPill(s) {
  return `<span class="pill ${PILL_BY_STATUS[s] || 'pill-pending'}">${esc(s || '—')}</span>`;
}
function markRail(regs) {
  const seen = new Set(regs.map((r) => r.status));
  document.querySelectorAll('.rail-step').forEach((el) => {
    const step = Number(el.dataset.step);
    const reached =
      (step === 2 && regs.length > 0) ||
      (step === 3 && (seen.has('REGISTERED') || seen.has('FUNDED') || seen.has('MATURED') || seen.has('REDEEMED'))) ||
      (step === 4 && (seen.has('FUNDED') || seen.has('MATURED') || seen.has('REDEEMED'))) ||
      (step === 5 && (seen.has('FUNDED') || seen.has('MATURED') || seen.has('REDEEMED'))) ||
      (step === 6 && (seen.has('REDEEMED') || seen.has('DEFAULTED')));
    el.classList.toggle('done', Boolean(reached));
  });
}
function proposalLabel(p) {
  const dd = (p && p.debtDocument) || {};
  return `${dd.debtorCompany ? dd.debtorCompany + ' — ' : ''}${usd(p && p.amount)} (${short(p && p.id, 8)})`;
}
async function loadAts() {
  await checkAtsHealth();
  try {
    const [regsRes, propsRes] = await Promise.all([fetch('/api/ats/registrations'), fetch('/api/proposals')]);
    atsRegistrations = ((await regsRes.json()).registrations) || [];
    const proposals = ((await propsRes.json()).proposals) || [];
    markRail(atsRegistrations);
    fillAtsSelects(proposals);
    renderAtsLedger();
  } catch (err) {
    devlog('ATS load failed: ' + err.message, 'err');
  }
}
function fillAtsSelects(proposals) {
  const registeredIds = new Set(atsRegistrations.map((r) => r.proposalId));
  const signable = proposals.filter((p) => p.status === 'ACCEPTED' && !registeredIds.has(p.id));
  fillSelect('atsRegProposal', signable, 'No signed listings available — an investor must sign first.');
  fillSelect('atsAuthReg', atsRegistrations.filter((r) => r.status === 'REGISTERED'),
    'No registered receivables — complete step 02.', (r) => r.receivableId + ' — ' + usd(r.faceValueUsd));
  fillSelect('atsExecReg', atsRegistrations.filter((r) => r.status === 'REGISTERED'),
    'No registered receivables — complete step 02.', (r) => r.receivableId + ' — ' + usd(r.minimumProceedsUsd) + ' min.');
  fillSelect('atsMatReg', atsRegistrations.filter((r) => ['FUNDED', 'MATURED'].includes(r.status)),
    'No funded receivables yet — execute a trade first.', (r) => r.receivableId + ' — ' + r.status);
  updateAtsDefaults();
}
function fillSelect(id, items, emptyMsg, labelFn) {
  const sel = $(id);
  if (!items.length) {
    sel.innerHTML = `<option value="">${esc(emptyMsg)}</option>`;
    return;
  }
  sel.innerHTML = items.map((item) => {
    const val = item.id && item.debtDocument ? item.id : item.proposalId;
    const label = labelFn ? labelFn(item) : proposalLabel(item);
    return `<option value="${esc(val)}">${esc(label)}</option>`;
  }).join('');
}
function regById(proposalId) {
  return atsRegistrations.find((r) => r.proposalId === proposalId) || null;
}
function updateAtsDefaults() {
  const reg = regById($('atsExecReg').value);
  if (reg && !$('atsExecPrice').value) $('atsExecPrice').placeholder = 'Auto — ' + Number(reg.minimumProceedsUsd).toFixed(0);
  const mreg = regById($('atsMatReg').value);
  if (mreg && !$('atsDebtorAmount').value) $('atsDebtorAmount').placeholder = 'Auto — ' + Number(mreg.faceValueUsd).toFixed(0);
}

function atsResult(id, ok, html) {
  const el = $(id);
  el.className = 'resultbox ' + (ok ? 'ok' : 'err');
  el.innerHTML = html;
  el.classList.remove('hidden');
}
async function atsPost(url, payload, btnId, resultId, renderFn) {
  const btn = btnId ? $(btnId) : null;
  if (btn) btn.disabled = true;
  try {
    devlog('ATS POST ' + url);
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok;
    atsResult(resultId, ok, renderFn(ok, data));
    if (ok) { devlog('ATS ' + url + ' → OK', 'ok'); loadAts(); }
    else devlog('ATS ' + url + ' → ' + (data.error || res.status), 'err');
  } catch (err) {
    atsResult(resultId, false, esc(err.message));
    devlog('ATS ' + url + ' failed: ' + err.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}
async function handleAtsRegister(e) {
  e.preventDefault();
  const proposalId = $('atsRegProposal').value;
  if (!proposalId) return;
  const supplierAccountId = $('atsSupplierAccount').value.trim();
  if (!/^0\.0\.\d+$/.test(supplierAccountId)) {
    atsResult('atsRegisterResult', false, 'Enter a valid Hedera account id (0.0.xxxx).');
    return;
  }
  store.set('supplierAccount', supplierAccountId);
  await atsPost('/api/ats/receivables',
    { proposalId, supplierAccountId, force: $('atsForce').checked },
    'atsRegisterBtn', 'atsRegisterResult',
    (ok, d) => ok
      ? `✓ <strong>${esc(d.message || 'Registered.')}</strong><div class="kv"><b>Receivable</b><span>${esc(d.registration && d.registration.receivableId)}</span></div><div class="kv"><b>Face / min.</b><span>${usd(d.registration && d.registration.faceValueUsd)} / ${usd(d.registration && d.registration.minimumProceedsUsd)}</span></div>`
      : `⚠ ${esc(d.message || d.error || 'Registration failed')}`);
}
async function handleAtsAuthorize(e) {
  e.preventDefault();
  const proposalId = $('atsAuthReg').value;
  if (!proposalId) return;
  await atsPost('/api/ats/suppliers/' + encodeURIComponent((regById(proposalId) || {}).supplierAccountId) + '/authorize-operator',
    { proposalId, securityId: $('atsSecurityId').value.trim() || undefined },
    'atsAuthorizeBtn', 'atsAuthorizeResult',
    (ok, d) => ok
      ? `✓ <strong>${esc(d.message || 'Operator authorized.')}</strong>${d.transactionId ? `<div class="kv"><b>tx</b><span>${esc(d.transactionId)} ${hashscanLink(d.transactionId)}</span></div>` : ''}`
      : `⚠ ${esc(d.message || d.error || 'Authorization failed')}`);
}
async function handleAtsAllowance(e) {
  e.preventDefault();
  const proposalId = $('atsExecReg').value;
  const investorAccountId = $('atsInvestorAccount').value.trim();
  if (!proposalId || !/^0\.0\.\d+$/.test(investorAccountId)) {
    atsResult('atsAllowanceResult', false, 'Select a registered receivable (step 05 list) and a valid investor account (0.0.xxxx).');
    return;
  }
  store.set('investorAccount', investorAccountId);
  const payload = { proposalId, investorAccountId };
  if ($('atsAllowanceAmount').value) payload.amountUsd = parseFloat($('atsAllowanceAmount').value);
  await atsPost('/api/ats/investors/' + encodeURIComponent(investorAccountId) + '/approve-usdc-allowance',
    payload, 'atsAllowanceBtn', 'atsAllowanceResult',
    (ok, d) => {
      if (!ok) return `⚠ ${esc(d.message || d.error || 'Allowance failed')}`;
      const a = d.registration && d.registration.usdcAllowance;
      return `✓ <strong>${esc(d.message || 'Allowance approved.')}</strong>${a ? `<div class="kv"><b>Amount</b><span>${usd(a.amountUsd)}</span></div><div class="kv"><b>Mode</b><span>${esc(a.mode)}${a.transactionId ? ' · ' + esc(a.transactionId) : ''}</span></div>` : ''}`;
    });
}
async function handleAtsExecute(e) {
  e.preventDefault();
  const proposalId = $('atsExecReg').value;
  if (!proposalId) return;
  const investorAccountId = $('atsInvestorAccount').value.trim() || store.get('investorAccount') || undefined;
  const payload = { proposalId };
  if (investorAccountId) payload.investorAccountId = investorAccountId;
  if ($('atsExecPrice').value) payload.purchasePriceUsd = parseFloat($('atsExecPrice').value);
  await atsPost('/api/ats/trades/execute', payload, 'atsExecuteBtn', 'atsExecuteResult',
    (ok, d) => {
      if (!ok) return `⚠ ${esc(d.message || d.error || 'Execution failed')}`;
      const reg = d.registration || {};
      const s = d.settlement || {};
      return `✓ <strong>${esc(d.message || 'Trade executed — receivable FUNDED.')}</strong>
        <div class="kv"><b>Security</b><span>${esc(reg.securityId || '—')}</span></div>
        <div class="kv"><b>Payout schedule</b><span>${esc(reg.payoutScheduleId || s.scheduleId || '—')}</span></div>
        <div class="kv"><b>ISIN</b><span>${esc(reg.isin || '—')}</span></div>
        <div class="kv"><b>Price</b><span>${usd(s.purchasePriceUsd)}</span></div>
        ${s.tokenizationTxId ? `<div class="kv"><b>Tokenize tx</b><span>${esc(s.tokenizationTxId)} ${hashscanLink(s.tokenizationTxId)}</span></div>` : ''}
        ${s.cashTransferTxId ? `<div class="kv"><b>USDC transfer</b><span>${esc(s.cashTransferTxId)} ${hashscanLink(s.cashTransferTxId)}</span></div>` : ''}`;
    });
}

async function handleAtsCheck() {
  const proposalId = $('atsMatReg').value;
  if (!proposalId) return;
  try {
    const res = await fetch('/api/ats/maturity/' + encodeURIComponent(proposalId) + '/check');
    const d = await res.json();
    if (!res.ok) { atsResult('atsMaturityResult', false, esc(d.error || 'Check failed')); return; }
    atsResult('atsMaturityResult', true,
      `<div class="kv"><b>Registration</b><span>${esc(d.registrationStatus || '—')}</span></div>
       <div class="kv"><b>Maturity reached</b><span>${d.maturityReached ? 'Yes' : 'Not yet'}</span></div>
       <div class="kv"><b>Debtor payment</b><span>${d.debtorPayment && d.debtorPayment.confirmed ? 'Confirmed' : 'Not confirmed'}</span></div>
       <div class="kv"><b>Redemption eligible</b><span>${d.redemptionEligible ? 'Yes' : 'No'}</span></div>`);
    devlog('ATS maturity check: ' + (d.registrationStatus || 'ok'), 'ok');
  } catch (err) {
    atsResult('atsMaturityResult', false, esc(err.message));
  }
}
async function handleAtsConfirm() {
  const proposalId = $('atsMatReg').value;
  if (!proposalId) return;
  const transactionId = $('atsDebtorTx').value.trim();
  if (!transactionId) {
    atsResult('atsMaturityResult', false, 'Enter the debtor payment reference first.');
    return;
  }
  const payload = { transactionId };
  if ($('atsDebtorAmount').value) payload.amountUsd = parseFloat($('atsDebtorAmount').value);
  await atsPost('/api/ats/maturity/' + encodeURIComponent(proposalId) + '/confirm-payment',
    payload, 'atsConfirmBtn', 'atsMaturityResult',
    (ok, d) => ok
      ? `✓ <strong>${esc(d.message || 'Debtor payment confirmed — receivable MATURED.')}</strong> Redemption unlocked.`
      : `⚠ ${esc(d.message || d.error || 'Confirmation failed')}`);
}
async function handleAtsRedeem() {
  const proposalId = $('atsMatReg').value;
  if (!proposalId) return;
  await atsPost('/api/ats/maturity/' + encodeURIComponent(proposalId) + '/redeem',
    {}, 'atsRedeemBtn', 'atsMaturityResult',
    (ok, d) => {
      if (!ok) return `⚠ ${esc(d.message || d.error || 'Redemption failed')}`;
      const r = (d.result && d.result.redemption) || {};
      return r.status === 'REDEEMED'
        ? `🏁 <strong>REDEEMED</strong> — investor received face value on-chain.${r.redemptionTransactionId ? `<div class="kv"><b>Redemption tx</b><span>${esc(r.redemptionTransactionId)} ${hashscanLink(r.redemptionTransactionId)}</span></div>` : ''}`
        : `⚠ <strong>DEFAULTED</strong> — debtor did not pay; scheduled payout cancelled${r.cancelledScheduleId ? ` (${esc(r.cancelledScheduleId)})` : ''}.`;
    });
}
function renderAtsLedger() {
  const tbody = $('atsLedger').querySelector('tbody');
  if (!atsRegistrations.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No registrations yet. Register a signed listing to open the ledger.</td></tr>';
    return;
  }
  tbody.innerHTML = atsRegistrations.map((r) => `
    <tr>
      <td>${esc(r.debtorName || short(r.proposalId, 8))}<br/><span class="addr">${esc(short(r.proposalId, 8))}</span></td>
      <td class="mono">${esc(r.receivableId)}</td>
      <td>${usd(r.faceValueUsd)}</td>
      <td>${usd(r.minimumProceedsUsd)}</td>
      <td>${r.maturityTimestamp ? new Date(r.maturityTimestamp * 1000).toLocaleDateString() : '—'}</td>
      <td class="mono">${esc(r.securityId || '—')}</td>
      <td class="mono">${esc(r.isin || '—')}</td>
      <td>${r.usdcAllowance ? `${usd(r.usdcAllowance.amountUsd)}<br/><span class="addr">${esc(r.usdcAllowance.mode)}</span>` : '—'}</td>
      <td>${atsStatusPill(r.status)}</td>
    </tr>`).join('');
}
viewLoaders.settlement = loadAts;

/* ═══════════════════════ INTELLIGENCE ═══════════════════════ */
async function handleIntelRun() {
  const btn = $('intelRunBtn');
  const status = $('intelStatus');
  btn.disabled = true;
  $('intelRunSpinner').classList.remove('hidden');
  $('intelPayment').innerHTML = '';
  status.classList.add('hidden');
  devlog('Requesting market intelligence…');
  try {
    const res = await fetch('/api/graph/insights', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (res.status === 402) {
      const invoice = decodePaymentRequired(res);
      $('intelPayment').innerHTML = payPanelHtml(invoice, 'Pay & run analysis', 'intelPay');
      status.classList.remove('hidden');
      status.textContent = 'Live market analysis is a paid micro-service — review the invoice above and confirm the payment.';
      devlog('Graph insights: 402 invoice received');
      $('intelPayment').scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('Invoice received — confirm the payment to run the analysis', 'ok');
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analysis failed (HTTP ' + res.status + ')');
    renderIntel(data, null);
  } catch (err) {
    status.classList.remove('hidden');
    status.textContent = '⚠ ' + err.message;
  } finally {
    btn.disabled = false;
    $('intelRunSpinner').classList.add('hidden');
  }
}
async function intelPay() {
  const status = $('intelStatus');
  $('intelPayment').innerHTML = pipelineHtml();
  status.classList.add('hidden');
  try {
    const final = await runAgentPaymentStream('/api/graph/insights', {}, (evt) =>
      updatePipeline($('intelPayment'), evt.step, evt.status, evt.detail));
    if (!final.ok || !final.data) throw new Error(final.error || 'Agent payment failed');
    await settleThenReplace($('intelPayment'), () => renderIntel(final.data, final.settlement));
  } catch (err) {
    status.classList.remove('hidden');
    status.textContent = '⚠ ' + err.message;
  }
}
function renderAiTopPicks(benchmarks) {
  const ranked = [...benchmarks]
    .filter((b) => b.maxSupplyApyPct > 0)
    .sort((a, b) => (b.maxSupplyApyPct - a.maxSupplyApyPct) || (b.averageSupplyApyPct - a.averageSupplyApyPct))
    .slice(0, 4);
  if (!ranked.length) return '';
  return `
    <div class="ai-panel" style="margin-top:16px;">
      <div class="ai-panel-label"><span class="ai-chip">AI</span> Top 4 markets by yield ceiling — where receivables capital competes best today</div>
      <div class="picks-grid">
        ${ranked.map((b, i) => `
        <div class="pick-card">
          <div class="pick-rank">PICK #${i + 1}${i === 0 ? ' · BEST CEILING' : ''}</div>
          <div class="pick-symbol">${esc(b.symbol)}</div>
          <div class="pick-apy">${b.maxSupplyApyPct}%</div>
          <span class="pick-sub">max supply APY · avg ${b.averageSupplyApyPct}% · ${b.marketsCount} venue${b.marketsCount === 1 ? '' : 's'}</span>
          <div class="pick-why">Yield ceiling of ${b.maxSupplyApyPct}% across ${b.marketsCount} live venue${b.marketsCount === 1 ? '' : 's'} — deepest liquidity on ${esc(b.topMarket)}. Floor sits at ${b.minSupplyApyPct}%, so venue selection matters.</div>
        </div>`).join('')}
      </div>
      <p class="meta-line" style="margin-top:12px;">Ranked by maximum supply APY across tracked venues (average APY as tie-breaker) — a deterministic screen over the live feed, not investment advice.</p>
    </div>`;
}
function renderIntel(data, settlement) {
  const m = data.market || {};
  const benchmarks = m.benchmarks || [];
  const best = benchmarks.reduce((a, b) => ((b.maxSupplyApyPct || 0) > (a.maxSupplyApyPct || 0) ? b : a), { maxSupplyApyPct: -1, topMarket: '—', symbol: '—' });
  const review = data.review || data.marketReview || null;
  $('intelOutput').innerHTML = `
    <div class="report-strip">
      <div class="report-stat tone-emerald"><span class="metric-label">Market APY (AI median)</span><span class="report-stat-value">${Number(m.unifiedApyPct || 0).toFixed(2)}%</span><span class="report-stat-sub">DeFi hurdle rate</span></div>
      <div class="report-stat"><span class="metric-label">Raw average</span><span class="report-stat-value">${m.averageApyPct != null ? Number(m.averageApyPct).toFixed(2) + '%' : '—'}</span><span class="report-stat-sub">arithmetic mean</span></div>
      <div class="report-stat tone-gold"><span class="metric-label">Max supply APY</span><span class="report-stat-value">${best.maxSupplyApyPct > 0 ? best.maxSupplyApyPct + '%' : '—'}</span><span class="report-stat-sub">${best.maxSupplyApyPct > 0 ? esc(best.symbol) + ' · ' + esc(best.topMarket) : ''}</span></div>
      <div class="report-stat tone-cyan"><span class="metric-label">Markets tracked</span><span class="report-stat-value">${(m.detailedRates || []).length}</span><span class="report-stat-sub">${benchmarks.length} benchmark assets</span></div>
    </div>
    ${renderAiTopPicks(benchmarks)}
    ${settlement ? `<p class="meta-line" style="margin:14px 0 0;">${settlementText(settlement)}</p>` : ''}
    ${review ? `
    <div class="ai-panel">
      <div class="ai-panel-label"><span class="ai-chip">AI</span> Market review — AI-assessed hurdle rate for receivables capital</div>
      <p class="ai-panel-text">${esc(review)}</p>
    </div>` : ''}
    ${benchmarks.length ? `
      <p class="intel-h">Benchmarks by asset</p>
      <div class="bench-card"><table class="bench-table">
        <thead><tr><th>Asset</th><th class="num">Avg APY</th><th class="num">Min</th><th class="num">Max APY</th><th class="num">Venues</th></tr></thead>
        <tbody>${benchmarks.map((b) => `
          <tr class="${b.symbol === best.symbol ? 'bench-best' : ''}">
            <td><span class="asset-badge">${esc(b.symbol)}</span>${b.symbol === best.symbol ? '<span class="bench-best-tag">TOP</span>' : ''}<br/><small class="dim">top: ${esc(b.topMarket)}</small></td>
            <td class="num"><span class="apy-chip">${b.averageSupplyApyPct}%</span></td>
            <td class="num dim">${b.minSupplyApyPct}%</td>
            <td class="num"><span class="apy-chip" style="color:var(--gold-bright);background:var(--gold-dim);border-color:rgba(212,175,106,0.35);">${b.maxSupplyApyPct}%</span></td>
            <td class="num">${b.marketsCount}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : ''}
    ${(m.detailedRates || []).length ? `
      <p class="intel-h">Detailed rates · ${m.detailedRates.length} live markets</p>
      <div class="bench-card"><table class="bench-table">
        <thead><tr><th>Protocol</th><th>Chain</th><th>Asset</th><th class="num">Supply APY</th><th class="num">Borrow APY</th><th class="num">TVL</th></tr></thead>
        <tbody>${m.detailedRates.map((r) => `
          <tr><td><span class="asset-badge">${esc(r.protocol)}</span></td><td class="dim">${esc(r.chain)}</td><td>${esc(r.symbol)}</td><td class="num"><span class="apy-chip">${r.supplyApyPct}%</span></td><td class="num dim">${r.borrowApyPct}%</td><td class="num tvl">$${Math.round(r.totalValueLockedUSD).toLocaleString()}</td></tr>`).join('')}
        </tbody>
      </table></div>` : ''}
    ${(m.mcpOpportunities || []).length ? `
      <p class="intel-h">MCP opportunities</p>
      <div class="bench-card"><table class="bench-table">
        <thead><tr><th>Protocol</th><th>Chain</th><th>Asset</th><th class="num">Supply APY</th><th class="num">TVL</th><th>Category / tier</th></tr></thead>
        <tbody>${m.mcpOpportunities.map((o) => `
          <tr><td><span class="asset-badge">${esc(o.protocol)}</span></td><td class="dim">${esc(o.chain)}</td><td>${esc(o.symbol)}</td><td class="num"><span class="apy-chip">${o.supplyApyPct}%</span></td><td class="num tvl">$${Math.round(o.totalValueLockedUSD).toLocaleString()}</td><td class="dim">${esc(o.category)} / ${esc(o.tier)}</td></tr>`).join('')}
        </tbody>
      </table></div>` : ''}`;
  devlog('Market intelligence rendered', 'ok');
}
viewLoaders.intelligence = () => {};

/* ═══════════════════════ DEVELOPER CONSOLE ═══════════════════════ */
function setCheck(name, cls, statusText, subText) {
  const card = document.querySelector(`.dev-check[data-check="${name}"]`);
  if (card) {
    card.classList.remove('ok', 'err', 'warn');
    if (cls) card.classList.add(cls);
  }
  const statusEl = $('dev' + name.charAt(0).toUpperCase() + name.slice(1) + 'Status');
  if (statusEl && statusText != null) statusEl.textContent = statusText;
  const subEl = $('dev' + name.charAt(0).toUpperCase() + name.slice(1) + 'Sub');
  if (subEl && subText != null) subEl.textContent = subText;
  updateDevDot();
}
function updateDevDot() {
  const cards = [...document.querySelectorAll('.dev-check')];
  const dot = $('devFabDot');
  if (!dot) return;
  dot.className = 'dev-fab-dot';
  if (cards.some((c) => c.classList.contains('err'))) dot.classList.add('bad');
  else if (cards.some((c) => c.classList.contains('warn'))) dot.classList.add('warn');
}
async function diagServer() {
  try {
    const r = await fetch('/health');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    setCheck('server', 'ok', 'online · ' + r.status, `GET /health → ${d.status} @ ${new Date(d.timestamp).toLocaleTimeString()}`);
    return true;
  } catch (e) { setCheck('server', 'err', 'offline', 'GET /health failed: ' + e.message); return false; }
}
async function diagAgent() {
  try {
    const r = await fetch('/api/agent/status', { cache: 'no-store' });
    const d = await r.json();
    if (!d.configured) throw new Error('agent wallet not configured');
    setCheck('agent', 'ok', 'configured', `${d.accountId} · ${d.network} · paid: ${(d.paidEndpoints || []).length} route(s)`);
    return true;
  } catch (e) { setCheck('agent', 'err', 'unavailable', e.message); return false; }
}
async function diagAts() {
  try {
    const r = await fetch('/api/ats/health');
    const d = await r.json();
    if (!r.ok || !d.connected) throw new Error(d.error || 'unreachable');
    if (d.service !== 'factored-hedera') {
      setCheck('ats', 'warn', 'identity mismatch', `Something else answers on ${d.serviceUrl} (got "${d.service}") — start: cd hedera && PORT=3001 npm run dev`);
      return false;
    }
    setCheck('ats', 'ok', d.service, `${d.serviceUrl} · identity verified`);
    return true;
  } catch (e) { setCheck('ats', 'err', 'unreachable', e.message + ' — start: cd hedera && PORT=3001 npm run dev'); return false; }
}
async function diagWorld() {
  try {
    const r = await fetch('/api/world/config');
    const d = await r.json();
    if (!d.enabled) throw new Error('disabled (missing WORLD_RP_ID / key)');
    setCheck('world', 'ok', 'enabled', `${d.rpId} · ${d.environment} · action ${d.action}`);
    return true;
  } catch (e) { setCheck('world', 'err', 'unavailable', e.message); return false; }
}
/* Gate probe: an unpaid request MUST come back 402 with a decodable invoice. */
async function gateProbe(path, body, name, label) {
  try {
    const res = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.status !== 402) throw new Error('expected 402, got ' + res.status);
    const invoice = decodePaymentRequired(res);
    const req = invoice && invoice.accepts && invoice.accepts[0];
    if (!req) throw new Error('402 without a decodable invoice');
    setCheck(name, 'ok', '402 · ' + hbarFromTinybars(req.amount) + ' HBAR', `${label} — gate live, ${req.amount} tinybars → ${req.payTo}`);
    return invoice;
  } catch (e) { setCheck(name, 'err', 'gate error', `${label} — ${e.message}`); return null; }
}
async function diagX402() {
  return gateProbe('/api/proposals', {
    proposerAddress: '0x1111111111111111111111111111111111111111', requiredAmount: 4500,
    debtDocument: { debtType: 'INVOICE', industry: 'Food distribution', debtorCompany: 'Northstar Foods Distribution Ltd.',
      invoiceNumber: 'INV-2026-00421', invoiceDate: '2026-09-01', dueDate: '2026-10-01', faceValue: 5000, currency: 'USD' },
  }, 'x402', 'proposal publishing');
}
async function diagLlm() {
  return gateProbe('/api/buyer/smart-report', {
    amountMin: 1000, amountMax: 50000, durationInDaysMin: 15, durationInDaysMax: 120, apyInPercentMin: 1,
  }, 'llm', 'AI credit report pricing');
}
async function diagGraph() { return gateProbe('/api/graph/insights', {}, 'graph', 'market intelligence pricing'); }
async function runAllDiagnostics() {
  devlog('Running full diagnostics…');
  const ok = await Promise.all([diagServer(), diagAgent(), diagAts(), diagWorld(), diagX402(), diagLlm(), diagGraph()]);
  const passed = ok.filter(Boolean).length;
  toast(`Diagnostics: ${passed}/${ok.length} checks passed`, passed === ok.length ? 'ok' : 'err');
}

/* x402 inspector */
const INSPECTOR_BODY = {
  proposerAddress: '0x1111111111111111111111111111111111111111', requiredAmount: 4500,
  debtDocument: { debtType: 'INVOICE', industry: 'Food distribution', debtorCompany: 'Northstar Foods Distribution Ltd.',
    invoiceNumber: 'INV-2026-00421', invoiceDate: '2026-09-01', dueDate: '2026-10-01', faceValue: 5000, currency: 'USD' },
};
async function devInspect() {
  const out = $('devInspectorOutput');
  out.textContent = '// ① POST /api/proposals without payment → expecting HTTP 402…';
  try {
    const res = await fetch('/api/proposals', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(INSPECTOR_BODY),
    });
    const invoice = decodePaymentRequired(res);
    const req = invoice && invoice.accepts && invoice.accepts[0];
    out.textContent = JSON.stringify({
      step: '① unpaid request', httpStatus: res.status, statusText: res.statusText,
      decodedInvoice: invoice,
      interpretation: req ? {
        scheme: req.scheme, network: req.network,
        price: `${hbarFromTinybars(req.amount)} HBAR (${req.amount} tinybars)`, payTo: req.payTo,
        facilitatorFeePayer: req.extra && req.extra.feePayer,
        nextStep: 'Retry with X-PAYMENT header carrying a partially-signed Hedera TransferTransaction',
      } : null,
    }, null, 2);
    $('devInspectorPay').classList.toggle('hidden', !req);
  } catch (e) {
    out.textContent = '// Request error: ' + e.message;
  }
}
async function devInspectorPay() {
  const out = $('devInspectorOutput');
  const btn = $('devInspectorPay');
  btn.disabled = true;
  out.textContent += '\n\n// ② paying via agent wallet (streamed)…';
  try {
    const final = await runAgentPaymentStream('/api/proposals', INSPECTOR_BODY, (evt) => {
      out.textContent += `\n// step: ${evt.step} ${evt.status || ''} ${evt.detail || ''}`;
    });
    out.textContent += '\n\n// ③ FINAL:\n' + JSON.stringify(final, null, 2);
    devlog('Inspector paid request finished: ' + (final.ok ? 'ok' : final.error), final.ok ? 'ok' : 'err');
  } catch (e) {
    out.textContent += '\n\n// ERROR: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

/* ═══════════════════════ EVENT WIRING & INIT ═══════════════════════ */
function wireEvents() {
  // Markets
  $('poolRefreshBtn').addEventListener('click', loadProposals);
  $('poolStatusFilter').addEventListener('change', loadProposals);
  // Invest
  $('investForm').addEventListener('submit', handleInvestSearch);
  $('smartReportBtn').addEventListener('click', handleSmartReport);
  $('reportCopyBtn').addEventListener('click', copyReportSummary);
  $('reportDownloadBtn').addEventListener('click', downloadReportJson);
  // Raise
  $('raiseForm').addEventListener('submit', handleRaiseSubmit);
  $('raiseRandomAddrBtn').addEventListener('click', () => { $('raiseProposer').value = randomAddress(); });
  ['raiseInvoiceDate', 'raiseDueDate', 'raiseFaceValue', 'raiseAdvance'].forEach((id) =>
    $(id).addEventListener('input', updateApyPreview));
  $('myListingsForm').addEventListener('submit', loadMyListings);
  // Selfie modal
  $('selfieCloseBtn').addEventListener('click', closeSelfie);
  $('selfieModal').addEventListener('click', (e) => { if (e.target === $('selfieModal')) closeSelfie(); });
  $('selfieStartBtn').addEventListener('click', startSelfie);
  $('selfieCopyBtn').addEventListener('click', () => {
    const uri = $('selfieConnectorUri').textContent;
    if (uri) navigator.clipboard.writeText(uri).then(() => toast('Link copied', 'ok'));
  });
  // Settlement
  $('atsRegisterForm').addEventListener('submit', handleAtsRegister);
  $('atsAuthorizeForm').addEventListener('submit', handleAtsAuthorize);
  $('atsAllowanceForm').addEventListener('submit', handleAtsAllowance);
  $('atsExecuteForm').addEventListener('submit', handleAtsExecute);
  $('atsCheckBtn').addEventListener('click', handleAtsCheck);
  $('atsConfirmBtn').addEventListener('click', handleAtsConfirm);
  $('atsRedeemBtn').addEventListener('click', handleAtsRedeem);
  $('atsLedgerRefresh').addEventListener('click', loadAts);
  $('atsExecReg').addEventListener('change', updateAtsDefaults);
  $('atsMatReg').addEventListener('change', updateAtsDefaults);
  // Intelligence
  $('intelRunBtn').addEventListener('click', handleIntelRun);
  // Developer console
  $('devFab').addEventListener('click', () => {
    const drawer = $('devDrawer');
    const open = !drawer.classList.contains('open');
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    if (open) runAllDiagnostics();
  });
  $('devCloseBtn').addEventListener('click', () => {
    $('devDrawer').classList.remove('open');
    $('devDrawer').setAttribute('aria-hidden', 'true');
  });
  $('devRunAll').addEventListener('click', runAllDiagnostics);
  $('devInspectBtn').addEventListener('click', devInspect);
  $('devInspectorPay').addEventListener('click', devInspectorPay);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSelfie();
      $('devDrawer').classList.remove('open');
    }
  });
}

async function init() {
  // Show content immediately — even if wiring or health checks fail.
  navigate((location.hash || '#markets').replace('#', ''));
  try {
    wireEvents();
  } catch (err) {
    console.error('[factora] event wiring failed:', err);
  }
  devlog('Factora interface loaded');
  const savedKey = store.get('proposerKey');
  if (savedKey) $('myListingsKey').value = savedKey;
  const savedSupplier = store.get('supplierAccount');
  if (savedSupplier) $('atsSupplierAccount').value = savedSupplier;
  const savedInvestor = store.get('investorAccount');
  if (savedInvestor) $('atsInvestorAccount').value = savedInvestor;
  loadProposals();
  if (savedKey) loadMyListings();
  Promise.all([checkServerHealth(), checkAgentStatus(), checkAtsHealth()]);
  setInterval(() => { checkServerHealth(); checkAtsHealth(); }, 15000);
  setInterval(checkAgentStatus, 30000);
  window.addEventListener('focus', () => { checkServerHealth(); checkAgentStatus(); checkAtsHealth(); });
  window.addEventListener('online', () => { checkServerHealth(); checkAgentStatus(); checkAtsHealth(); });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
