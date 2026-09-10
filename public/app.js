// State
let proposalsState = [];
let latestBuyerCriteria = null;
let latestReportData = null;

// DOM Elements
const serverStatusBadge = document.getElementById('serverStatusBadge');
const serverStatusText = document.getElementById('serverStatusText');
const proposalsListEl = document.getElementById('proposalsList');
const proposalsLoadingEl = document.getElementById('proposalsLoading');
const proposalsEmptyEl = document.getElementById('proposalsEmpty');
const totalProposalsCountEl = document.getElementById('totalProposalsCount');
const avgApyValEl = document.getElementById('avgApyVal');
const totalVolumeValEl = document.getElementById('totalVolumeVal');

// Tab Switching
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

  if (tabId === 'proposals') {
    document.getElementById('tabBtnProposals').classList.add('active');
    document.getElementById('tabProposals').classList.add('active');
    loadProposals();
  } else if (tabId === 'matchmaking') {
    document.getElementById('tabBtnMatchmaking').classList.add('active');
    document.getElementById('tabMatchmaking').classList.add('active');
  } else if (tabId === 'x402') {
    document.getElementById('tabBtnX402').classList.add('active');
    document.getElementById('tabX402').classList.add('active');
  }
}

// Server Health Check
async function checkServerHealth() {
  try {
    const res = await fetch('/health');
    if (res.ok) {
      serverStatusBadge.className = 'status-indicator online';
      serverStatusText.textContent = 'Server Online (Port 3000)';
    } else {
      throw new Error('Server returned ' + res.status);
    }
  } catch (err) {
    serverStatusBadge.className = 'status-indicator offline';
    serverStatusText.textContent = 'Server Offline';
  }
}

// Live APY Calculation in Proposal Creator Form
function updateApyPreview() {
  const nominal = parseFloat(document.getElementById('nominalAmount').value) || 0;
  const required = parseFloat(document.getElementById('requiredAmount').value) || 0;
  const days = parseInt(document.getElementById('returnDateInDays').value, 10) || 0;

  const apyValEl = document.getElementById('previewApyValue');
  const detailsEl = document.getElementById('apyFormulaDetails');

  if (nominal <= 0 || required <= 0 || days <= 0 || required >= nominal) {
    apyValEl.textContent = '0.00%';
    apyValEl.style.color = 'var(--text-dim)';
    if (required >= nominal && nominal > 0 && required > 0) {
      detailsEl.textContent = '⚠️ Required amount must be less than nominal amount.';
      detailsEl.style.color = 'var(--accent-rose)';
    } else {
      detailsEl.textContent = 'Enter valid parameters to estimate annualized yield';
      detailsEl.style.color = 'var(--text-dim)';
    }
    return;
  }

  const yieldRatio = (nominal - required) / required;
  const apy = yieldRatio * (365 / days) * 100;
  const discount = nominal - required;
  const discountPercent = ((discount / nominal) * 100).toFixed(1);

  apyValEl.textContent = apy.toFixed(2) + '%';
  apyValEl.style.color = 'var(--accent-emerald)';
  detailsEl.textContent = `Discount: $${discount.toLocaleString()} (${discountPercent}%) | Duration: ${days} days`;
  detailsEl.style.color = 'var(--text-muted)';
}

// Random EVM Address Generator
function generateRandomAddress() {
  const hex = '0123456789abcdef';
  let addr = '0x';
  for (let i = 0; i < 40; i++) {
    addr += hex[Math.floor(Math.random() * hex.length)];
  }
  document.getElementById('proposerAddress').value = addr;
}

// Create Proposal API Call
async function handleCreateProposal(e) {
  e.preventDefault();

  const errBox = document.getElementById('proposalErrorBox');
  const succBox = document.getElementById('proposalSuccessBox');
  const btnText = document.getElementById('btnText');
  const btnSpinner = document.getElementById('btnSpinner');
  const submitBtn = document.getElementById('submitProposalBtn');

  errBox.classList.add('hidden');
  succBox.classList.add('hidden');
  errBox.textContent = '';
  succBox.textContent = '';

  const proposerAddress = document.getElementById('proposerAddress').value.trim();
  const amount = parseFloat(document.getElementById('nominalAmount').value);
  const requiredAmount = parseFloat(document.getElementById('requiredAmount').value);
  const returnDateInDays = parseInt(document.getElementById('returnDateInDays').value, 10);

  btnText.textContent = 'Publishing...';
  btnSpinner.classList.remove('hidden');
  submitBtn.disabled = true;

  try {
    const res = await fetch('/api/proposals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposerAddress, amount, requiredAmount, returnDateInDays })
    });

    const data = await res.json();

    if (!res.ok) {
      let msg = data.error || 'Failed to create proposal.';
      if (data.issues && data.issues.length) {
        msg = data.issues.map(i => `${i.field}: ${i.message}`).join(' | ');
      }
      errBox.textContent = msg;
      errBox.classList.remove('hidden');
    } else {
      succBox.textContent = `✓ Proposal created! ID: ${data.proposal.id.substring(0, 8)}... | APY: ${data.proposal.apy}%`;
      succBox.classList.remove('hidden');
      
      // Reset form
      document.getElementById('createProposalForm').reset();
      updateApyPreview();

      // Refresh proposals list
      await loadProposals();
    }
  } catch (err) {
    errBox.textContent = 'Network error: ' + err.message;
    errBox.classList.remove('hidden');
  } finally {
    btnText.textContent = 'Publish Debt Proposal';
    btnSpinner.classList.add('hidden');
    submitBtn.disabled = false;
  }
}

// Load and render Proposals Pool
async function loadProposals() {
  proposalsLoadingEl.classList.remove('hidden');
  proposalsEmptyEl.classList.add('hidden');
  proposalsListEl.innerHTML = '';

  const statusFilter = document.getElementById('statusFilter').value;
  let url = '/api/proposals';
  if (statusFilter) {
    url += `?status=${encodeURIComponent(statusFilter)}`;
  }

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    proposalsState = data.proposals || [];

    renderProposals(proposalsState);
    updateStats(proposalsState);
  } catch (err) {
    proposalsEmptyEl.querySelector('p').textContent = 'Error loading proposals.';
    proposalsEmptyEl.classList.remove('hidden');
  } finally {
    proposalsLoadingEl.classList.add('hidden');
  }
}

function updateStats(proposals) {
  totalProposalsCountEl.textContent = proposals.length;

  if (proposals.length === 0) {
    avgApyValEl.textContent = '0.0%';
    totalVolumeValEl.textContent = '$0';
    return;
  }

  const totalVol = proposals.reduce((sum, p) => sum + (p.amount || 0), 0);
  const totalApy = proposals.reduce((sum, p) => sum + (p.apy || 0), 0);
  const avgApy = totalApy / proposals.length;

  avgApyValEl.textContent = avgApy.toFixed(1) + '%';
  totalVolumeValEl.textContent = '$' + totalVol.toLocaleString();
}

function renderProposals(proposals) {
  if (proposals.length === 0) {
    proposalsEmptyEl.classList.remove('hidden');
    return;
  }

  proposalsListEl.innerHTML = proposals.map(p => {
    const shortAddr = p.proposerAddress.length > 14 
      ? p.proposerAddress.substring(0, 6) + '...' + p.proposerAddress.substring(p.proposerAddress.length - 4)
      : p.proposerAddress;

    const shortId = p.id.substring(0, 8);
    const createdDate = new Date(p.createdAt).toLocaleDateString() + ' ' + new Date(p.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return `
      <div class="proposal-item">
        <div class="proposal-item-header">
          <span class="proposal-id">#${shortId}</span>
          <span class="badge ${p.status === 'PENDING' ? 'badge-warning' : 'badge-success'}">${p.status}</span>
        </div>

        <div class="proposal-metrics">
          <div class="metric-col">
            <span class="metric-label">Nominal</span>
            <span class="metric-value">$${Number(p.amount).toLocaleString()}</span>
          </div>
          <div class="metric-col">
            <span class="metric-label">Required</span>
            <span class="metric-value">$${Number(p.requiredAmount).toLocaleString()}</span>
          </div>
          <div class="metric-col">
            <span class="metric-label">Duration</span>
            <span class="metric-value">${p.returnDateInDays}d</span>
          </div>
          <div class="metric-col">
            <span class="metric-label">APY</span>
            <span class="metric-value apy">${p.apy}%</span>
          </div>
        </div>

        <div class="proposal-item-footer">
          <span class="address-tag" title="${p.proposerAddress}">Proposer: ${shortAddr}</span>
          <span>${createdDate}</span>
        </div>
      </div>
    `;
  }).join('');
}

// Placeholder for Step 2: x402 Protected Endpoint Tester
async function testProtectedEndpoint() {
  const headerVal = document.getElementById('x402HeaderInput').value.trim();
  const outputEl = document.getElementById('x402InspectorOutput');

  outputEl.textContent = '// Sending request to POST /api/proposals with test header...';

  const headers = { 'Content-Type': 'application/json' };
  if (headerVal) {
    headers['X-Payment-Preimage'] = headerVal;
    headers['Authorization'] = `Bearer ${headerVal}`;
  }

  try {
    const res = await fetch('/api/proposals', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        proposerAddress: '0x1111111111111111111111111111111111111111',
        amount: 5000,
        requiredAmount: 4500,
        returnDateInDays: 30
      })
    });

    const resHeaders = {};
    res.headers.forEach((val, key) => { resHeaders[key] = val; });

    let body;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }

    outputEl.textContent = JSON.stringify({
      status: res.status,
      statusText: res.statusText,
      responseHeaders: resHeaders,
      responseBody: body
    }, null, 2);
  } catch (err) {
    outputEl.textContent = '// Request Error:\n' + err.message;
  }
}

function getBuyerCriteria() {
  return {
    amountMin: parseFloat(document.getElementById('buyerAmountMin').value),
    amountMax: parseFloat(document.getElementById('buyerAmountMax').value),
    durationInDaysMin: parseInt(document.getElementById('buyerDurationMin').value, 10),
    durationInDaysMax: parseInt(document.getElementById('buyerDurationMax').value, 10),
    apyInPercentMin: parseFloat(document.getElementById('buyerApyMin').value)
  };
}

function formatSearchError(data) {
  if (data.issues && data.issues.length) {
    return data.issues.map(i => `${i.field}: ${i.message}`).join(' | ');
  }
  return data.error || 'Request failed';
}

function renderMatchedProposal(proposal) {
  return `
    <div class="proposal-item" style="border-left: 4px solid var(--accent-cyan);">
      <div class="proposal-item-header">
        <span class="proposal-id">#${proposal.id.substring(0, 8)}</span>
        <span class="badge badge-warning">${proposal.status}</span>
      </div>
      <div class="proposal-metrics">
        <div class="metric-col"><span class="metric-label">Nominal</span><span class="metric-value">$${Number(proposal.amount).toLocaleString()}</span></div>
        <div class="metric-col"><span class="metric-label">Required</span><span class="metric-value">$${Number(proposal.requiredAmount).toLocaleString()}</span></div>
        <div class="metric-col"><span class="metric-label">Duration</span><span class="metric-value">${proposal.returnDateInDays}d</span></div>
        <div class="metric-col"><span class="metric-label">APY</span><span class="metric-value apy">${proposal.apy}%</span></div>
      </div>
    </div>
  `;
}

// Free buyer matchmaking: performs only the deterministic hard filter.
async function handleBuyerSearch(e) {
  e.preventDefault();
  const resultsContainer = document.getElementById('matchmakerResultsContainer');
  const smartReportBtn = document.getElementById('smartReportBtn');
  const smartReportSection = document.getElementById('smartReportSection');
  const criteria = getBuyerCriteria();

  latestBuyerCriteria = null;
  latestReportData = null;
  smartReportBtn.classList.add('hidden');
  smartReportSection.classList.add('hidden');
  document.getElementById('reportActions')?.classList.add('hidden');
  document.getElementById('reportMeta')?.classList.add('hidden');

  resultsContainer.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <span>Filtering pending proposals...</span>
    </div>
  `;

  try {
    const res = await fetch('/api/buyer/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(criteria)
    });

    const data = await res.json();

    if (!res.ok) {
      resultsContainer.innerHTML = `
        <div class="alert-box error-box">
          ⚠️ ${formatSearchError(data)}
        </div>
      `;
      return;
    }

    if (data.count === 0) {
      resultsContainer.innerHTML = `
        <div class="info-placeholder">
          <span>🔍</span>
          <p>No pending proposals matched your criteria.</p>
          <small>Try widening your nominal amount or maturity duration filters.</small>
        </div>
      `;
      return;
    }

    latestBuyerCriteria = criteria;
    smartReportBtn.classList.remove('hidden');
    resultsContainer.innerHTML = `
      <div class="search-summary-pill" style="margin-bottom: 12px; font-size: 0.8rem; color: var(--text-muted);">
        Found <strong>${data.count}</strong> matching pending proposal(s):
      </div>
      <div class="proposals-list">
        ${data.proposals.map(renderMatchedProposal).join('')}
      </div>
    `;
  } catch (err) {
    resultsContainer.innerHTML = `
      <div class="alert-box error-box">
        Network error: ${err.message}
      </div>
    `;
  }
}

// ---------- AI Smart Report (paid service) ----------

function escapeHtml(value) {
  const entityMap = { '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' };
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&${entityMap[c]};`);
}

function scoreTone(score) {
  return score >= 75 ? 'tone-emerald' : score >= 50 ? 'tone-amber' : 'tone-rose';
}

function verdictOf(score) {
  if (score >= 75) return { label: 'Strong buy', cls: 'v-strong' };
  if (score >= 50) return { label: 'Consider', cls: 'v-consider' };
  return { label: 'Pass', cls: 'v-pass' };
}

function riskBadgeClass(risk) {
  return risk === 'LOW' ? 'badge-success' : risk === 'MEDIUM' ? 'badge-warning' : 'badge-primary';
}

function reportSkeletonHtml() {
  return `
    <div class="skel-report">
      <div class="skel-row">
        <div class="skel-block"></div>
        <div class="skel-block"></div>
        <div class="skel-block"></div>
        <div class="skel-block"></div>
      </div>
      <div class="skel-card">
        <div class="skel-line w40"></div>
        <div class="skel-line"></div>
        <div class="skel-line w60"></div>
      </div>
      <div class="skel-card">
        <div class="skel-line w40"></div>
        <div class="skel-line"></div>
        <div class="skel-line w60"></div>
      </div>
    </div>
  `;
}

function renderEvaluationCard(item, index, marketBenchmark) {
  const { proposal: p, evaluation: ev } = item;
  const tone = scoreTone(ev.fitScore);
  const verdict = verdictOf(ev.fitScore);
  const isBest = index === 0;
  const delta = Number(p.apy) - Number(marketBenchmark.averageMarketApy);
  const deltaSign = delta >= 0 ? '+' : '';

  return `
    <div class="result-card ${isBest ? 'best-pick' : ''}" style="animation-delay: ${Math.min(index * 90, 500)}ms">
      <div class="result-card-top">
        <div class="result-id-block">
          <span class="rank-chip">${isBest ? '★ Best pick' : '#' + (index + 1)}</span>
          <span class="verdict-badge ${verdict.cls}">${verdict.label}</span>
          <span class="proposal-id">#${p.id.substring(0, 8)}</span>
        </div>
        <div class="fit-gauge ${tone}" data-score="${ev.fitScore}">
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <circle class="gauge-track" cx="32" cy="32" r="26"></circle>
            <circle class="gauge-fill" cx="32" cy="32" r="26"></circle>
          </svg>
          <div class="gauge-center">
            <span class="gauge-num" data-target="${ev.fitScore}">0</span>
            <small>fit</small>
          </div>
        </div>
      </div>
      <div class="proposal-metrics">
        <div class="metric-col"><span class="metric-label">Nominal</span><span class="metric-value">$${Number(p.amount).toLocaleString()}</span></div>
        <div class="metric-col"><span class="metric-label">Required</span><span class="metric-value">$${Number(p.requiredAmount).toLocaleString()}</span></div>
        <div class="metric-col"><span class="metric-label">Duration</span><span class="metric-value">${p.returnDateInDays}d</span></div>
        <div class="metric-col">
          <span class="metric-label">APY</span>
          <span class="metric-value apy">${p.apy}%</span>
          <span class="apy-delta ${delta >= 0 ? 'up' : 'down'}" title="Delta vs market APY">${deltaSign}${delta.toFixed(1)}% vs market</span>
        </div>
      </div>
      <div class="ai-writing">
        <div class="ai-writing-label">
          <span class="badge ${riskBadgeClass(ev.riskLevel)}">${ev.riskLevel} risk</span>
          <strong>AI rationale</strong>
        </div>
        <p>${escapeHtml(ev.recommendation)}</p>
      </div>
    </div>
  `;
}

function renderSmartReport(container, report) {
  const mb = report.marketBenchmark;
  const scores = report.results.map((r) => Number(r.evaluation.fitScore) || 0);
  const best = scores.length ? Math.max(...scores) : 0;
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const low = report.results.filter((r) => r.evaluation.riskLevel === 'LOW').length;
  const med = report.results.filter((r) => r.evaluation.riskLevel === 'MEDIUM').length;
  const high = report.results.filter((r) => r.evaluation.riskLevel === 'HIGH').length;
  const total = report.results.length || 1;
  const pct = (n) => (n / total) * 100;

  container.className = 'smart-report-container';
  container.innerHTML = `
    <div class="report-stat-strip">
      <div class="report-stat tone-cyan">
        <span class="stat-label">Matches evaluated</span>
        <span class="report-stat-value">${report.count}</span>
        <span class="report-stat-sub">passed hard filter</span>
      </div>
      <div class="report-stat ${scoreTone(best)}">
        <span class="stat-label">Best fit score</span>
        <span class="report-stat-value">${best}</span>
        <span class="report-stat-sub">out of 100</span>
      </div>
      <div class="report-stat ${scoreTone(Math.round(avg))}">
        <span class="stat-label">Average fit</span>
        <span class="report-stat-value">${avg.toFixed(1)}</span>
        <span class="report-stat-sub">portfolio mean</span>
      </div>
      <div class="report-stat ${high > 0 ? 'tone-rose' : 'tone-emerald'}">
        <span class="stat-label">High-risk picks</span>
        <span class="report-stat-value">${high}</span>
        <span class="report-stat-sub">${high > 0 ? 'review rationale' : 'nothing alarming'}</span>
      </div>
    </div>

    <div class="verdict-card">
      <span class="verdict-quote-mark">”</span>
      <div class="report-kicker"><span>✦</span> AI portfolio verdict</div>
      <p>${escapeHtml(report.overallSummary)}</p>
    </div>

    <div class="report-panels">
      <div class="report-panel">
        <div class="report-kicker"><span>◌</span> Market context</div>
        <div class="benchmark-grid">
          <div class="benchmark-item"><span>Market APY</span> <strong>${mb.averageMarketApy}%</strong></div>
          <div class="benchmark-item"><span>Default rate</span> <strong>${(mb.benchmarkDefaultRate * 100).toFixed(2)}%</strong></div>
          <div class="benchmark-item"><span>Liquidity index</span> <strong>${mb.liquidityIndex}<small>/100</small></strong></div>
        </div>
        <div class="liquidity-meter"><div class="liquidity-fill" data-target="${mb.liquidityIndex}"></div></div>
        <div class="liquidity-meta"><span>Capital depth</span><span>${mb.liquidityIndex}/100</span></div>
      </div>
      <div class="report-panel">
        <div class="report-kicker"><span>◔</span> Risk distribution</div>
        <div class="risk-bar">
          <span class="risk-seg seg-low" data-target="${pct(low)}"></span>
          <span class="risk-seg seg-med" data-target="${pct(med)}"></span>
          <span class="risk-seg seg-high" data-target="${pct(high)}"></span>
        </div>
        <div class="risk-legend">
          <span><i class="legend-dot low"></i>${low} low</span>
          <span><i class="legend-dot med"></i>${med} medium</span>
          <span><i class="legend-dot high"></i>${high} high</span>
        </div>
      </div>
    </div>

    ${report.results.length === 0 ? `
      <div class="info-placeholder">
        <span>🤖</span>
        <p>No proposals were available to underwrite for this criteria.</p>
      </div>
    ` : `
      <div class="report-results-heading">
        <span>Proposal assessments</span>
        <small>${report.results.length} AI-reviewed match${report.results.length === 1 ? '' : 'es'} · ranked by fit</small>
      </div>
      <div class="proposals-list smart-report-list">
        ${report.results.map((item, index) => renderEvaluationCard(item, index, mb)).join('')}
      </div>
    `}
  `;
}

function animateCountUp(el, target, duration = 900) {
  const start = performance.now();
  const step = (now) => {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = String(Math.round(target * eased));
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function animateReport(container) {
  const GAUGE_LEN = 2 * Math.PI * 26; // circumference for r=26

  requestAnimationFrame(() => {
    container.querySelectorAll('.fit-gauge').forEach((gauge) => {
      const score = Number(gauge.dataset.score) || 0;
      const fill = gauge.querySelector('.gauge-fill');
      const num = gauge.querySelector('.gauge-num');
      if (fill) fill.style.strokeDashoffset = String(GAUGE_LEN * (1 - score / 100));
      if (num) animateCountUp(num, Number(num.dataset.target) || 0);
    });

    container.querySelectorAll('.liquidity-fill').forEach((bar) => {
      bar.style.width = Math.min(100, Number(bar.dataset.target) || 0) + '%';
    });

    container.querySelectorAll('.risk-seg').forEach((seg) => {
      seg.style.width = (Number(seg.dataset.target) || 0) + '%';
    });
  });
}

function buildReportSummaryText(report) {
  const mb = report.marketBenchmark;
  const lines = [];
  lines.push(`Factora AI Smart Report — ${new Date(report.generatedAt).toLocaleString()}`);
  lines.push(`Matches evaluated: ${report.count}`);
  lines.push(`Market: APY ${mb.averageMarketApy}% | default rate ${(mb.benchmarkDefaultRate * 100).toFixed(2)}% | liquidity ${mb.liquidityIndex}/100`);
  lines.push('');
  lines.push(`Verdict: ${report.overallSummary}`);
  report.results.forEach((item, i) => {
    const { proposal: p, evaluation: ev } = item;
    lines.push(`${i + 1}. #${p.id.substring(0, 8)} — fit ${ev.fitScore}/100 — ${ev.riskLevel} risk — APY ${p.apy}% — $${Number(p.amount).toLocaleString()} over ${p.returnDateInDays}d`);
    lines.push(`   ${ev.recommendation}`);
  });
  return lines.join('\n');
}

function flashReportMeta(message) {
  const metaEl = document.getElementById('reportMeta');
  if (!metaEl) return;
  const prev = metaEl.getAttribute('data-prev') || metaEl.textContent;
  metaEl.setAttribute('data-prev', prev);
  metaEl.textContent = message;
  setTimeout(() => { metaEl.textContent = prev; }, 2200);
}

function copyReportSummary() {
  if (!latestReportData) return;
  const text = buildReportSummaryText(latestReportData);
  navigator.clipboard.writeText(text)
    .then(() => flashReportMeta('✓ Report summary copied to clipboard'))
    .catch(() => flashReportMeta('⚠ Clipboard unavailable — use Export JSON instead'));
}

function downloadReportJson() {
  if (!latestReportData) return;
  const blob = new Blob([JSON.stringify(latestReportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `claimflow-smart-report-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  flashReportMeta('⬇️ Report JSON exported');
}

// Paid smart-report service: calls the LLM only after the buyer requests it.
async function handleSmartReport() {
  if (!latestBuyerCriteria) return;

  const section = document.getElementById('smartReportSection');
  const container = document.getElementById('smartReportContainer');
  const button = document.getElementById('smartReportBtn');
  const actionsEl = document.getElementById('reportActions');
  const metaEl = document.getElementById('reportMeta');

  section.classList.remove('hidden');
  button.disabled = true;
  actionsEl.classList.add('hidden');
  metaEl.classList.add('hidden');
  container.className = 'smart-report-container';
  container.innerHTML = reportSkeletonHtml();

  try {
    const res = await fetch('/api/buyer/smart-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(latestBuyerCriteria)
    });
    const data = await res.json();

    if (!res.ok) {
      container.className = 'info-placeholder';
      container.innerHTML = `<div class="alert-box error-box">⚠️ ${formatSearchError(data)}</div>`;
      return;
    }

    latestReportData = { ...data, generatedAt: new Date().toISOString() };
    renderSmartReport(container, latestReportData);
    animateReport(container);

    metaEl.textContent = `Underwriter agent · Generated ${new Date().toLocaleTimeString()} · criteria: $${latestBuyerCriteria.amountMin.toLocaleString()}–$${latestBuyerCriteria.amountMax.toLocaleString()} · ${latestBuyerCriteria.durationInDaysMin}–${latestBuyerCriteria.durationInDaysMax}d · min APY ${latestBuyerCriteria.apyInPercentMin}%`;
    metaEl.classList.remove('hidden');
    actionsEl.classList.remove('hidden');
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    container.className = 'info-placeholder';
    container.innerHTML = `<div class="alert-box error-box">Network error: ${err.message}</div>`;
  } finally {
    button.disabled = false;
  }
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  checkServerHealth();
  loadProposals();
  setInterval(checkServerHealth, 10000);
});
