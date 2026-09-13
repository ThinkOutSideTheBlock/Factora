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
  } else if (tabId === 'graph') {
    document.getElementById('tabBtnGraph').classList.add('active');
    document.getElementById('tabGraph').classList.add('active');
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

// Live APY Calculation in Proposal Creator Form.
// Proposal economics derive from the debt document: nominal = face value,
// maturity = payment terms (invoice → due). Only the advance is decided.
function proposalTermDays() {
  const from = document.getElementById('invoiceDate').value;
  const to = document.getElementById('dueDate').value;
  if (!from || !to) return 0;
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
}

function updateApyPreview() {
  const nominal = parseFloat(document.getElementById('faceValue').value) || 0;
  const required = parseFloat(document.getElementById('requiredAmount').value) || 0;
  const days = proposalTermDays();

  const apyValEl = document.getElementById('previewApyValue');
  const detailsEl = document.getElementById('apyFormulaDetails');

  if (nominal <= 0 || required <= 0 || days <= 0) {
    apyValEl.textContent = '0.00%';
    apyValEl.style.color = 'var(--text-dim)';
    if (days <= 0 && document.getElementById('invoiceDate').value && document.getElementById('dueDate').value) {
      detailsEl.textContent = '⚠️ Due date must be after the invoice date.';
      detailsEl.style.color = 'var(--accent-rose)';
    } else {
      detailsEl.textContent = 'Enter the debt document and requested advance to estimate annualized yield';
      detailsEl.style.color = 'var(--text-dim)';
    }
    return;
  }

  if (required >= nominal) {
    apyValEl.textContent = '0.00%';
    apyValEl.style.color = 'var(--text-dim)';
    detailsEl.textContent = '⚠️ Requested advance must be less than the document face value.';
    detailsEl.style.color = 'var(--accent-rose)';
    return;
  }

  const yieldRatio = (nominal - required) / required;
  const apy = yieldRatio * (365 / days) * 100;
  const discount = nominal - required;
  const discountPercent = ((discount / nominal) * 100).toFixed(1);

  apyValEl.textContent = apy.toFixed(2) + '%';
  apyValEl.style.color = 'var(--accent-emerald)';
  detailsEl.textContent = `Discount: $${discount.toLocaleString()} (${discountPercent}%) | Terms: ${days} days (invoice → due)`;
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

function getDebtDocument() {
  return {
    debtType: document.getElementById('debtType').value,
    industry: document.getElementById('debtIndustry').value.trim(),
    debtorCompany: document.getElementById('debtorCompany').value.trim(),
    invoiceNumber: document.getElementById('invoiceNumber').value.trim(),
    invoiceDate: document.getElementById('invoiceDate').value,
    dueDate: document.getElementById('dueDate').value,
    faceValue: parseFloat(document.getElementById('faceValue').value),
    currency: 'USD'
  };
}

// ---------- In-browser x402 payment panel ----------
// Renders the decoded 402 invoice and lets the user pay through the agent.

function renderPaymentPanelHtml(contextKey, payLabel) {
  const invoice = (pendingPayments[contextKey] || {}).invoice;
  const req = invoice && invoice.accepts && invoice.accepts[0];
  if (!req) {
    return '<div class="alert-box error-box">⚠️ Payment required, but the invoice header could not be decoded.</div>';
  }
  const hbar = hbarFromTinybars(req.amount);
  return `
    <div class="payment-panel">
      <div class="payment-panel-title">🛡️ Payment required — x402 challenge received</div>
      <div class="payment-grid">
        <div class="payment-row"><span>Price</span><strong>${hbar} HBAR</strong></div>
        <div class="payment-row"><span>Network</span><strong>${req.network}</strong></div>
        <div class="payment-row"><span>Scheme</span><strong>${req.scheme}</strong></div>
        <div class="payment-row"><span>Pay to (service)</span><strong>${req.payTo}</strong></div>
        <div class="payment-row"><span>Fee payer (Blocky402)</span><strong>${(req.extra && req.extra.feePayer) || '—'}</strong></div>
      </div>
      <button class="btn btn-primary" onclick="payPendingPayment('${contextKey}')">
        💸 ${payLabel} (${hbar} HBAR)
      </button>
      <p class="payment-note">Signed server-side by the agent wallet, settled via the Blocky402 facilitator. Your browser never holds keys.</p>
    </div>
  `;
}

async function payPendingPayment(contextKey) {
  const pending = pendingPayments[contextKey];
  if (!pending) return;
  pending.busy = true;
  await pending.onPay();
}

// ---------- Proposal creation with x402 ----------
async function publishProposalViaAgent(payload) {
  const errBox = document.getElementById('proposalErrorBox');
  const succBox = document.getElementById('proposalSuccessBox');

  errBox.innerHTML = renderPipelineHtml();
  errBox.classList.remove('hidden');
  succBox.classList.add('hidden');

  try {
    const final = await runAgentPaymentStream('/api/proposals', payload, (evt) =>
      updatePipeline(errBox, evt.step, evt.status, evt.detail)
    );

    if (final.ok && final.data && final.data.proposal) {
      errBox.classList.add('hidden');
      const txLine = settlementText(final.settlement);
      succBox.innerHTML = `✓ Proposal created! ID: ${final.data.proposal.id.substring(0, 8)}… | APY: ${final.data.proposal.apy}%${txLine ? `<br><small>${txLine}</small>` : ''}`;
      succBox.classList.remove('hidden');
      document.getElementById('createProposalForm').reset();
      updateApyPreview();
      await loadProposals();
    } else {
      errBox.innerHTML = `<div class="alert-box error-box">⚠️ ${escapeHtml(final.error || 'Agent payment failed')}</div>`;
    }
  } catch (err) {
    errBox.innerHTML = `<div class="alert-box error-box">⚠️ ${escapeHtml(err.message)}</div>`;
  }
  delete pendingPayments.proposal;
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
  const requiredAmount = parseFloat(document.getElementById('requiredAmount').value);
  const debtDocument = getDebtDocument();

  btnText.textContent = 'Publishing...';
  btnSpinner.classList.remove('hidden');
  submitBtn.disabled = true;

  try {
    const res = await fetch('/api/proposals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposerAddress, requiredAmount, debtDocument })
    });

    // x402 gate: unpaid request → decode invoice, offer agent payment.
    if (res.status === 402) {
      const invoice = decodePaymentRequired(res);
      pendingPayments.proposal = {
        invoice,
        onPay: () => publishProposalViaAgent({ proposerAddress, requiredAmount, debtDocument })
      };
      succBox.classList.add('hidden');
      errBox.innerHTML = renderPaymentPanelHtml('proposal', 'Pay & Publish Proposal');
      errBox.classList.remove('hidden');
      return;
    }

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

/**
 * Renders the permanent "Selfie Verified" badge for a verified proposal.
 */
function renderSelfieVerifiedBadge(proposal) {
  const shortNullifier = escapeHtml(String(proposal.selfieCheck?.nullifier || '').substring(0, 12));
  return `<span class="badge badge-success selfie-badge" title="World ID Selfie Check verified${shortNullifier ? ` (nullifier ${shortNullifier}…)` : ''}">🪪 Selfie Verified</span>`;
}

/**
 * Renders the World ID Selfie Check action for a proposal that a buyer has
 * already signed (seller's "My Proposals" view). Verification is only
 * possible after a buyer signature — that's the track's continuity gate.
 */
function renderSelfieCheckAction(proposal, label) {
  if (proposal.selfieCheck && proposal.selfieCheck.status === 'VERIFIED') {
    return renderSelfieVerifiedBadge(proposal);
  }
  return `<button type="button" class="btn btn-secondary btn-sm" onclick="openSelfieModal('${proposal.id}')">${escapeHtml(label)}</button>`;
}

/**
 * Buyer-side action: sign ("buy") the proposal. Signing flips the proposal
 * to ACCEPTED, which is what tells the seller to perform their Selfie Check.
 */
function renderBuyAction(proposal) {
  if (proposal.status === 'ACCEPTED' || proposal.buyerAddress) {
    const who = escapeHtml(proposal.buyerAddress || 'a buyer');
    return `<span class="badge badge-success" title="Signed by ${who}">✓ Signed</span>`;
  }
  return `<button type="button" class="btn btn-secondary btn-sm" onclick="openSelfieModal('${proposal.id}','buyer')">💰 Buy this debt</button>`;
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
        ${renderDebtDocumentSummary(p.debtDocument)}
        ${p.selfieCheck && p.selfieCheck.status === 'VERIFIED' ? `<div class="proposal-item-actions">${renderSelfieVerifiedBadge(p)}</div>` : ''}
      </div>
    `;
  }).join('');
}

function renderDebtDocumentSummary(document) {
  if (!document) return '';
  return `
    <div class="debt-document-summary">
      <span><strong>${escapeHtml(document.debtType || 'Debt')}</strong> · ${escapeHtml(document.industry || 'Industry unknown')}</span>
      <span>${escapeHtml(document.debtorCompany || 'Debtor unknown')}</span>
      <span>${escapeHtml(document.invoiceNumber || 'No invoice number')} · due ${escapeHtml(document.dueDate || 'unknown')}</span>
    </div>
  `;
}

// ---------- World ID Selfie Check (Beta) ----------
// Every proposal card carries a "Selfie Check" button. Clicking it opens a
// popup that runs the real World ID flow: signed RP context from our backend →
// IDKit (staging, selfieCheckLegacy preset) → proof verified server-side
// against the World verify API → proposal marked "Selfie Verified".
// The pk (World App ID) is entered by the user in the popup and remembered.

const selfieState = { proposalId: null, mode: 'seller' };
const SELFIE_DEFAULT_APP_ID = 'app_d5e4029b334e9d0ee4d9c45408af8035';

function openSelfieModal(proposalId, mode = 'seller') {
  selfieState.proposalId = proposalId;
  selfieState.mode = mode === 'buyer' ? 'buyer' : 'seller';
  const isBuyer = selfieState.mode === 'buyer';

  document.getElementById('selfieModalIcon').textContent = isBuyer ? '💰' : '🪪';
  document.getElementById('selfieModalTitle').textContent = isBuyer
    ? 'Buy this debt — Selfie Check'
    : 'World ID Selfie Check';
  document.getElementById('selfieModalDesc').innerHTML = isBuyer
    ? `To sign (buy) proposal <strong id="selfieProposalLabel">#${String(proposalId).substring(0, 8)}</strong>, verify you are a real, live human with World ID Selfie Check. Your verified signature flips the listing to <strong>ACCEPTED</strong> and notifies the seller.`
    : `Prove the proposer of <strong id="selfieProposalLabel">#${String(proposalId).substring(0, 8)}</strong> is a real, live human. Selfie Check (Beta) is an abuse-prevention / eligibility signal that reduces sybil and scripted-listing risk on this proposal.`;

  const appIdInput = document.getElementById('selfieAppIdInput');
  if (!appIdInput.value.trim()) {
    appIdInput.value = localStorage.getItem('factoraWorldAppId') || SELFIE_DEFAULT_APP_ID;
  }

  const keyInput = document.getElementById('selfieSigningKeyInput');
  if (!keyInput.value.trim()) {
    keyInput.value = localStorage.getItem('factoraWorldSigningKey') || '';
  }

  document.getElementById('selfieConnectorBox').classList.add('hidden');
  document.getElementById('selfieResultBox').classList.add('hidden');
  setSelfieStatus('Enter the World App ID (pk) and start the flow.', false);
  document.getElementById('selfieModal').classList.remove('hidden');
}

function closeSelfieModal() {
  document.getElementById('selfieModal').classList.add('hidden');
  selfieState.proposalId = null;
}

function setSelfieStatus(message, isError) {
  const el = document.getElementById('selfieStatus');
  el.textContent = message;
  el.classList.toggle('selfie-status-error', Boolean(isError));
}

function copySelfieConnectorUri() {
  const uri = document.getElementById('selfieConnectorUri').textContent;
  if (uri) navigator.clipboard.writeText(uri).catch(() => {});
}

/**
 * Flips every buyer "Buy this debt" button for this proposal into a
 * "✓ Signed" badge across all views without re-running a (possibly paid)
 * search.
 */
function markSignedEverywhere(proposalId) {
  document.querySelectorAll(`button[onclick*="openSelfieModal('${proposalId}','buyer')"]`).forEach((btn) => {
    const badge = document.createElement('span');
    badge.className = 'badge badge-success';
    badge.title = 'Signed by a World ID verified buyer';
    badge.textContent = '✓ Signed';
    btn.replaceWith(badge);
  });
}

/**
 * Flips every "Perform Selfie Check" button for this proposal into the
 * verified badge — across My Proposals and any other view — without
 * re-running a (possibly paid) search.
 */
function markSelfieVerifiedEverywhere(proposalId, nullifier) {
  const shortNullifier = escapeHtml(String(nullifier || '').substring(0, 12));
  document.querySelectorAll(`button[onclick*="openSelfieModal('${proposalId}','seller')"]`).forEach((btn) => {
    const badge = document.createElement('span');
    badge.className = 'badge badge-success selfie-badge';
    badge.title = 'World ID Selfie Check verified' + (shortNullifier ? ` (nullifier ${shortNullifier}…)` : '');
    badge.textContent = '🪪 Selfie Verified';
    btn.replaceWith(badge);
  });
}

// ---------- My Proposals (seller side) ----------
// The seller enters their public key and sees only their own listings. A
// proposal that a buyer has signed (status ACCEPTED) shows the Selfie Check
// button — the track's continuity gate before the deal proceeds.

function getMyProposalsKey() {
  return document.getElementById('myProposalsKeyInput').value.trim();
}

async function loadMyProposals(options = {}) {
  const key = getMyProposalsKey();
  const statusEl = document.getElementById('myProposalsStatus');
  const listEl = document.getElementById('myProposalsList');

  if (!/^0x[0-9a-fA-F]{40}$/i.test(key)) {
    if (!options.silent) {
      statusEl.textContent = 'Enter a valid public key: a 0x-prefixed EVM address (0x + 40 hex chars).';
      statusEl.classList.remove('hidden');
      statusEl.classList.add('selfie-status-error');
    }
    return;
  }

  localStorage.setItem('factoraProposerKey', key);

  try {
    const res = await fetch('/api/proposals?proposer=' + encodeURIComponent(key));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const mine = data.proposals || [];

    if (!options.silent || mine.length > 0) {
      statusEl.textContent = mine.length === 0
        ? 'No proposals found for this public key.'
        : `${mine.length} proposal${mine.length === 1 ? '' : 's'} found.`;
      statusEl.classList.remove('hidden', 'selfie-status-error');
    }

    listEl.innerHTML = mine.map(renderMyProposal).join('');
  } catch (err) {
    if (!options.silent) {
      statusEl.textContent = '⚠️ Could not load your proposals: ' + (err && err.message ? err.message : String(err));
      statusEl.classList.remove('hidden');
      statusEl.classList.add('selfie-status-error');
    }
  }
}

function renderMyProposal(p) {
  const shortId = String(p.id).substring(0, 8);
  const signedDate = p.buyerSignature?.signedAt
    ? new Date(p.buyerSignature.signedAt).toLocaleDateString() + ' ' + new Date(p.buyerSignature.signedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  let action;
  let signingInfo = '';
  if (p.selfieCheck && p.selfieCheck.status === 'VERIFIED') {
    action = renderSelfieVerifiedBadge(p);
    signingInfo = '<span class="my-proposals-signed">✓ Signed by a World ID verified buyer' + (signedDate ? ' · ' + signedDate : '') + '</span>';
  } else if (p.status === 'ACCEPTED' || p.buyerSignature) {
    action = renderSelfieCheckAction(p, '🪪 Perform Selfie Check');
    signingInfo = '<span class="my-proposals-signed">✓ Signed by a World ID verified buyer' + (signedDate ? ' · ' + signedDate : '') + '</span>';
  } else {
    action = '<span class="my-proposals-waiting">⏳ Waiting for a buyer to sign…</span>';
  }

  return `
    <div class="proposal-item my-proposal-item">
      <div class="proposal-item-header">
        <span class="proposal-id">#${shortId}</span>
        <span class="badge ${p.status === 'PENDING' ? 'badge-warning' : 'badge-success'}">${p.status}</span>
      </div>
      <div class="proposal-metrics">
        <div class="metric-col"><span class="metric-label">Nominal</span><span class="metric-value">$${Number(p.amount).toLocaleString()}</span></div>
        <div class="metric-col"><span class="metric-label">Required</span><span class="metric-value">$${Number(p.requiredAmount).toLocaleString()}</span></div>
        <div class="metric-col"><span class="metric-label">Duration</span><span class="metric-value">${p.returnDateInDays}d</span></div>
        <div class="metric-col"><span class="metric-label">APY</span><span class="metric-value apy">${p.apy}%</span></div>
      </div>
      ${renderDebtDocumentSummary(p.debtDocument)}
      <div class="proposal-item-actions">
        ${signingInfo}
        ${action}
      </div>
    </div>
  `;
}

async function startSelfieCheck() {
  const proposalId = selfieState.proposalId;
  if (!proposalId) return;

  const appIdInput = document.getElementById('selfieAppIdInput');
  const appId = appIdInput.value.trim();
  if (!appId || !appId.startsWith('app_')) {
    setSelfieStatus('Enter a valid World App ID (pk), e.g. app_…', true);
    return;
  }
  localStorage.setItem('factoraWorldAppId', appId);

  // Optional RP signing key (private key) pasted by the user on the UI.
  // When left empty the backend uses its configured WORLD_RP_SIGNING_KEY.
  const signingKeyInput = document.getElementById('selfieSigningKeyInput');
  const signingKey = signingKeyInput.value.trim();
  if (signingKey && !/^0x[0-9a-fA-F]{64}$/.test(signingKey)) {
    setSelfieStatus('The RP signing key must be a 0x-prefixed 32-byte hex string (0x + 64 hex chars).', true);
    return;
  }
  if (signingKey) localStorage.setItem('factoraWorldSigningKey', signingKey);

  const btn = document.getElementById('selfieStartBtn');
  const spinner = document.getElementById('selfieSpinner');
  btn.disabled = true;
  spinner.classList.remove('hidden');
  document.getElementById('selfieResultBox').classList.add('hidden');

  try {
    // ① Signed RP context from our backend — binds this Selfie Check request
    //    to this proposal and cannot be replayed or reused after expiry.
    setSelfieStatus('① Requesting signed RP context from backend…');
    const rpRes = await fetch('/api/world/rp-signature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signingKey ? { proposalId, signingKey } : { proposalId }),
    });
    if (!rpRes.ok) throw new Error('RP signature failed: ' + (await rpRes.text()));
    const rp = await rpRes.json();

    // ② Real IDKit core request, staging environment, Selfie Check preset.
    setSelfieStatus('② Preparing World ID request (staging)…');
    const { IDKit, selfieCheckLegacy } = await import(
      'https://cdn.jsdelivr.net/npm/@worldcoin/idkit-core@4/+esm'
    );

    const request = await IDKit.request({
      app_id: appId,
      action: 'mandatory-selfie-check',
      rp_context: {
        rp_id: rp.rp_id,
        nonce: rp.nonce,
        created_at: rp.created_at,
        expires_at: rp.expires_at,
        signature: rp.signature,
      },
      allow_legacy_proofs: true,
      environment: 'staging',
    }).preset(selfieCheckLegacy({ signal: proposalId }));

    // ③ Hand off to the World App / Simulator (deep link / QR).
    const uri = request.connectorURI;
    if (!uri) throw new Error('No connectorURI returned — check the App ID (pk) and RP configuration.');
    document.getElementById('selfieConnectorUri').textContent = uri;
    document.getElementById('selfieConnectorBox').classList.remove('hidden');
    setSelfieStatus('③ Complete the flow in the World App / Simulator. Waiting…');

    const completion = await request.pollUntilCompletion({ pollInterval: 2000, timeout: 180000 });
    if (!completion.success) {
      throw new Error('Selfie Check failed: ' + (completion.error || 'unknown'));
    }

    // ④ Server-side verification against the World verify API.
    setSelfieStatus('④ Proof received — verifying with World…');
    const verifyRes = await fetch('/api/world/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, proof: completion.result, role: selfieState.mode }),
    });
    const verifyData = await verifyRes.json();
    if (!verifyRes.ok) {
      throw new Error(verifyData.message || verifyData.error || 'Verification rejected (HTTP ' + verifyRes.status + ')');
    }

    const isBuyer = selfieState.mode === 'buyer';
    const resultBox = document.getElementById('selfieResultBox');
    if (isBuyer) {
      resultBox.innerHTML =
        '✓ <strong>Selfie check successful — proposal signed!</strong> ' +
        'The listing is now ACCEPTED and the seller can verify their identity.';
    } else {
      const nullifier = String(verifyData.selfieCheck?.nullifier || '');
      resultBox.innerHTML =
        '✓ <strong>Selfie check successful</strong> — proposer verified' +
        (nullifier ? ` <small>(nullifier ${escapeHtml(nullifier.substring(0, 12))}…)</small>` : '');
    }
    resultBox.classList.remove('hidden');
    setSelfieStatus(
      isBuyer
        ? 'Done. Your signature is recorded and the seller has been notified.'
        : 'Done. This proposal is now marked Selfie Verified.',
      false,
    );
    if (isBuyer) {
      markSignedEverywhere(proposalId);
    } else {
      markSelfieVerifiedEverywhere(proposalId, verifyData.selfieCheck?.nullifier);
    }
    await loadProposals();
    await loadMyProposals({ silent: true });
  } catch (err) {
    setSelfieStatus('⚠️ ' + (err && err.message ? err.message : String(err)), true);
  } finally {
    btn.disabled = false;
    spinner.classList.add('hidden');
  }
}

// ---------- x402 helpers ----------
// The browser never holds private keys: it can *inspect* the 402 invoice and
// delegate the actual payment to the backend payer agent (/api/agent/*).

// Per-context pending invoices waiting for the user to press "Pay".
const pendingPayments = {};

function decodePaymentRequired(res) {
  const b64 = res.headers.get('payment-required');
  if (!b64) return null;
  try {
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

function hbarFromTinybars(tinybars) {
  const hbar = Number(tinybars) / 100000000;
  return String(parseFloat(hbar.toFixed(6)));
}

function settlementText(settlement) {
  if (!settlement) return '';
  const tx = settlement.transaction || settlement.transactionId || '';
  const network = String(settlement.network || 'hedera:testnet').replace('hedera:', '');
  const link = tx
    ? ` — https://hashscan.io/${network}/transaction/${encodeURIComponent(tx)}`
    : '';
  return `Settlement tx: ${tx}${link}`;
}

// ---------- x402 Tab: live protocol inspector ----------

async function sendUnpaidRequest() {
  const outputEl = document.getElementById('x402InspectorOutput');
  outputEl.textContent = '// ① POST /api/proposals without payment → expecting HTTP 402…';

  try {
    const res = await fetch('/api/proposals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposerAddress: '0x1111111111111111111111111111111111111111',
        requiredAmount: 4500,
        debtDocument: {
          debtType: 'INVOICE',
          industry: 'Food distribution',
          debtorCompany: 'Northstar Foods Distribution Ltd.',
          invoiceNumber: 'INV-2026-00421',
          invoiceDate: '2026-09-01',
          dueDate: '2026-10-01',
          faceValue: 5000,
          currency: 'USD'
        }
      })
    });

    const invoice = decodePaymentRequired(res);
    const req = invoice && invoice.accepts && invoice.accepts[0];

    outputEl.textContent = JSON.stringify({
      step: '① unpaid request',
      httpStatus: res.status,
      statusText: res.statusText,
      decodedInvoice: invoice,
      interpretation: req ? {
        scheme: req.scheme,
        network: req.network,
        price: `${hbarFromTinybars(req.amount)} HBAR (${req.amount} tinybars)`,
        payTo: req.payTo,
        facilitatorFeePayer: req.extra && req.extra.feePayer,
        nextStep: 'Retry with X-PAYMENT header containing a partially-signed Hedera TransferTransaction'
      } : null
    }, null, 2);
  } catch (err) {
    outputEl.textContent = '// Request Error:\n' + err.message;
  }
}

async function payFromAgent() {
  const outputEl = document.getElementById('x402InspectorOutput');
  const btn = document.getElementById('agentPayBtn');
  btn.disabled = true;

  outputEl.innerHTML = renderPipelineHtml();

  try {
    const final = await runAgentPaymentStream('/api/proposals', {
      proposerAddress: '0x1111111111111111111111111111111111111111',
      requiredAmount: 4500,
      debtDocument: {
        debtType: 'INVOICE',
        industry: 'Food distribution',
        debtorCompany: 'Northstar Foods Distribution Ltd.',
        invoiceNumber: 'INV-2026-00421',
        invoiceDate: '2026-09-01',
        dueDate: '2026-10-01',
        faceValue: 5000,
        currency: 'USD'
      }
    }, (evt) => updatePipeline(outputEl, evt.step, evt.status, evt.detail));

    const summary = {
      finalHttpStatus: final.httpStatus,
      settlement: final.settlement,
      paidResource: final.ok ? final.data : undefined,
      error: final.ok ? undefined : final.error
    };
    outputEl.innerHTML += '<pre class="code-block" style="border:none;background:transparent;margin:10px 0 0">' +
      escapeHtml(JSON.stringify(summary, null, 2)) + '</pre>';
  } catch (err) {
    outputEl.innerHTML += '<pre class="code-block" style="border:none;background:transparent;margin:10px 0 0">// ' +
      escapeHtml(err.message) + '</pre>';
  } finally {
    btn.disabled = false;
  }
}

// Agent wallet status. Retries briefly and re-checks on focus, so a tsx-watch
// restart or a transient fetch failure can't leave the badge stuck on red.
async function checkAgentStatus(attempt = 0) {
  const badge = document.getElementById('agentStatusBadge');
  const text = document.getElementById('agentStatusText');
  const payBtn = document.getElementById('agentPayBtn');
  if (!badge || !text) return; // stale cached HTML without the badge markup
  try {
    const res = await fetch('/api/agent/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.configured) {
      badge.className = 'status-indicator online';
      text.textContent = `Agent ${data.accountId} · ${data.network}`;
      if (payBtn) payBtn.disabled = false;
      return;
    }
    badge.className = 'status-indicator offline';
    text.textContent = 'Not configured (set HEDERA_AGENT_* in .env)';
    if (payBtn) payBtn.disabled = true;
  } catch {
    badge.className = 'status-indicator offline';
    if (attempt < 2) {
      text.textContent = 'Checking agent wallet…';
      setTimeout(() => checkAgentStatus(attempt + 1), 1200 * (attempt + 1));
    } else {
      text.textContent = 'Agent status unavailable';
      if (payBtn) payBtn.disabled = true;
    }
  }
}

// Agent-backed payment used by the proposal form and the smart report.
async function payViaAgent(path, payload) {
  const res = await fetch('/api/agent/paid-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, payload })
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

// ---------- Agent payment pipeline (live step progress) ----------
const AGENT_PIPELINE_STEPS = [
  { id: 'invoice', label: '① Payment invoice (x402 challenge)' },
  { id: 'sign', label: '② Sign Hedera payment (agent wallet)' },
  { id: 'settle', label: '③ On-chain settlement + request' }
];

function renderPipelineHtml() {
  return '<div class="pipeline"><div class="pipeline-title">Agent payment · live progress</div>' +
    AGENT_PIPELINE_STEPS.map(s =>
      `<div class="pipeline-step" data-step="${s.id}"><span class="p-icon"></span><span class="p-label">${s.label}</span><span class="p-detail"></span></div>`
    ).join('') + '</div>';
}

function updatePipeline(containerEl, step, status, detail) {
  const el = containerEl.querySelector(`.pipeline-step[data-step="${step}"]`);
  if (!el) return;
  el.classList.remove('running', 'done', 'error');
  el.classList.add(status);
  el.querySelector('.p-icon').textContent = status === 'done' ? '✓' : status === 'error' ? '✕' : '';
  if (detail !== undefined && detail !== null) {
    el.querySelector('.p-detail').textContent = detail;
  }
}

// Reads the NDJSON progress stream from /api/agent/paid-request/stream.
// Returns the final event { ok, httpStatus, data, settlement }; transport
// failures throw (application errors arrive as final.ok = false instead).
async function runAgentPaymentStream(path, payload, onStep) {
  const res = await fetch('/api/agent/paid-request/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, payload })
  });
  if (!res.ok || !res.body) {
    let msg = 'Agent request failed (HTTP ' + res.status + ')';
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch { /* non-JSON error */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt.type === 'step') onStep(evt);
      else if (evt.type === 'final') final = evt;
    }
  }
  if (!final) throw new Error('Agent stream ended without a final result');
  return final;
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
      ${renderDebtDocumentSummary(proposal.debtDocument)}
      <div class="proposal-item-actions">
        ${renderBuyAction(proposal)}
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
      ${renderDebtAnalysis(ev.debtAnalysis)}
      <div class="proposal-item-actions">
        ${renderBuyAction(p)}
      </div>
    </div>
  `;
}

function renderDebtAnalysis(analysis) {
  if (!analysis) return '';
  const score = Number(analysis.collectionConfidenceScore);
  const risk = analysis.riskLevel || 'UNKNOWN';
  const quality = analysis.debtQuality || 'UNKNOWN';
  return `
    <div class="debt-analysis-panel">
      <div class="ai-writing-label"><strong>Debt document underwriting</strong><span class="badge ${riskBadgeClass(risk === 'UNKNOWN' ? 'HIGH' : risk)}">${escapeHtml(risk)} collection risk</span></div>
      <div class="debt-analysis-grid">
        <span><small>Collection confidence</small><strong>${Number.isFinite(score) ? score : 0}/100</strong></span>
        <span><small>Debt quality</small><strong>${escapeHtml(quality)}</strong></span>
        <span><small>Review status</small><strong>${escapeHtml(analysis.status || 'PENDING')}</strong></span>
      </div>
      <p>${escapeHtml(analysis.underwriterComment || 'No underwriter comment is available.')}</p>
      ${analysis.missingEvidence?.length ? `<small class="analysis-note">Missing evidence: ${escapeHtml(analysis.missingEvidence.join('; '))}</small>` : ''}
    </div>
  `;
}

/**
 * Live market stats for the report panel, derived from the Messari benchmarks.
 * Returns null when the feed carried no benchmark data (nothing is fabricated).
 */
function marketApyStats(mb) {
  const benchmarks = Object.values(mb?.messari?.benchmarks ?? {});
  if (!benchmarks.length) return null;
  const best = benchmarks.reduce((a, b) => (b.maxSupplyApy > a.maxSupplyApy ? b : a));
  if (!(best.maxSupplyApy > 0)) return null;
  const maxApyPct = (best.maxSupplyApy * 100).toFixed(2);
  const avgVsBestPct = Math.max(1, Math.min(100, Math.round((mb.averageMarketApy / 100 / best.maxSupplyApy) * 100)));
  return {
    maxApyPct,
    topMarket: best.topMarket,
    avgVsBestPct,
    marketsTracked: mb?.messari?.detailedRates?.length ?? 0,
  };
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
  const market = marketApyStats(mb);

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
          <div class="benchmark-item" title="AI-assessed median DeFi hurdle rate (from the live graph data)"><span>Market APY</span> <strong>${mb.averageMarketApy}%</strong></div>
          <div class="benchmark-item" ${market ? `title="Best market: ${escapeHtml(market.topMarket)}"` : ''}><span>Max APY</span> <strong>${market ? market.maxApyPct + '%' : '—'}</strong></div>
          <div class="benchmark-item" ${market ? `title="Live Messari lending markets above the $1M TVL floor"` : ''}><span>Markets tracked</span> <strong>${market ? market.marketsTracked : '—'}</strong></div>
        </div>
        ${market ? `
        <div class="liquidity-meter"><div class="liquidity-fill" data-target="${market.avgVsBestPct}"></div></div>
        <div class="liquidity-meta"><span>Market average vs best yield</span><span>${market.avgVsBestPct}%</span></div>
        ` : ''}
        ${report.marketReview ? `<p class="market-review"><span class="market-review-kicker">✦ AI market review</span>${escapeHtml(report.marketReview)}</p>` : ''}
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
  const marketLine = marketApyStats(mb);
  lines.push(
    `Market: APY ${mb.averageMarketApy}%` +
      (marketLine ? ` | max APY ${marketLine.maxApyPct}% (${marketLine.topMarket}) | ${marketLine.marketsTracked} live markets tracked` : ''),
  );
  if (report.marketReview) lines.push(`AI market review: ${report.marketReview}`);
  lines.push('');
  lines.push(`Verdict: ${report.overallSummary}`);
  report.results.forEach((item, i) => {
    const { proposal: p, evaluation: ev } = item;
    lines.push(`${i + 1}. #${p.id.substring(0, 8)} — fit ${ev.fitScore}/100 — ${ev.riskLevel} risk — APY ${p.apy}% — $${Number(p.amount).toLocaleString()} over ${p.returnDateInDays}d`);
    lines.push(`   ${ev.recommendation}`);
    if (ev.debtAnalysis) {
      lines.push(`   Debt review: ${ev.debtAnalysis.collectionConfidenceScore}/100 collection confidence — quality ${ev.debtAnalysis.debtQuality} — ${ev.debtAnalysis.status}`);
      lines.push(`   Underwriter: ${ev.debtAnalysis.underwriterComment}`);
    }
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

// Paid smart report via the x402 agent — runs after the user accepts the invoice.
async function generateReportViaAgent() {
  const section = document.getElementById('smartReportSection');
  const container = document.getElementById('smartReportContainer');
  const metaEl = document.getElementById('reportMeta');

  if (!latestBuyerCriteria) return;

  section.classList.remove('hidden');
  container.className = 'smart-report-container';
  container.innerHTML = renderPipelineHtml();

  try {
    const final = await runAgentPaymentStream('/api/buyer/smart-report', getSmartReportPayload(), (evt) =>
      updatePipeline(container, evt.step, evt.status, evt.detail)
    );

    if (!final.ok || !final.data || typeof final.data.count === 'undefined') {
      container.className = 'info-placeholder';
      container.innerHTML = `<div class="alert-box error-box">⚠️ ${escapeHtml(final.error || 'Agent payment failed')}</div>`;
      delete pendingPayments.smartReport;
      return;
    }

    latestReportData = { ...final.data, generatedAt: new Date().toISOString() };
    renderSmartReport(container, latestReportData);
    animateReport(container);

    const usage = latestReportData.usage;
    const usageLine = usage && usage.totalTokens
      ? `${usage.totalTokens} LLM tokens · charged ${hbarFromTinybars(usage.chargedTinybars)} HBAR (usage-estimate) · `
      : '';
    const note = getSmartReportPayload().userMessage;
    const noteLine = note ? `Your note: “${note.length > 60 ? note.slice(0, 60) + '…' : note}” · ` : '';
    metaEl.textContent = `Underwriter agent · ${usageLine}${noteLine}${settlementText(final.settlement)}`;
    metaEl.classList.remove('hidden');
    document.getElementById('reportActions').classList.remove('hidden');
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    delete pendingPayments.smartReport;
  } catch (err) {
    container.className = 'info-placeholder';
    container.innerHTML = `<div class="alert-box error-box">⚠️ ${escapeHtml(err.message)}</div>`;
  }
}

// Buyer search criteria + optional free-form note for the AI underwriter.
// The note never affects the hard filter, so the free search and the paid
// report stay consistent; it only steers the LLM evaluation.
function getSmartReportPayload() {
  const note = (document.getElementById('buyerMessage')?.value || '').trim();
  return { ...latestBuyerCriteria, ...(note ? { userMessage: note } : {}) };
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
      body: JSON.stringify(getSmartReportPayload())
    });

    // x402 gate: unpaid request → show per-token price and offer agent payment.
    if (res.status === 402) {
      const invoice = decodePaymentRequired(res);
      pendingPayments.smartReport = {
        invoice,
        onPay: generateReportViaAgent
      };
      button.disabled = false;
      container.className = 'smart-report-container';
      container.innerHTML = renderPaymentPanelHtml('smartReport', 'Pay & Generate Report');
      return;
    }

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

// ---------- Graph Market Insights (standalone paid analytics) ----------

async function handleGraphInsights() {
  const btn = document.getElementById('graphInsightsBtn');
  const btnText = document.getElementById('graphInsightsBtnText');
  const spinner = document.getElementById('graphInsightsSpinner');
  const statusEl = document.getElementById('graphInsightsStatus');
  const paymentEl = document.getElementById('graphInsightsPayment');

  btn.disabled = true;
  btnText.textContent = 'Processing…';
  spinner.classList.remove('hidden');
  statusEl.classList.add('hidden');
  paymentEl.classList.add('hidden');

  const finishUi = () => {
    btn.disabled = false;
    btnText.textContent = '⚡ Buy & Analyze Live Markets';
    spinner.classList.add('hidden');
  };

  try {
    // First attempt: unpaid → expect the x402 402 challenge.
    const res = await fetch('/api/graph/insights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (res.status === 402) {
      const invoice = decodePaymentRequired(res);
      pendingPayments.graph = {
        invoice,
        onPay: async () => {
          try {
            const final = await runAgentPaymentStream('/api/graph/insights', {}, (evt) => {
              statusEl.classList.remove('hidden');
              statusEl.textContent = `⏳ ${evt.detail || evt.step}`;
            });
            paymentEl.classList.add('hidden');
            renderGraphInsights(final.data, final.settlement);
          } catch (err) {
            statusEl.classList.remove('hidden');
            statusEl.textContent = `⚠️ ${escapeHtml(err.message)}`;
          } finally {
            delete pendingPayments.graph;
            finishUi();
          }
        }
      };
      paymentEl.innerHTML = renderPaymentPanelHtml('graph', 'Pay & Run Market Analysis');
      paymentEl.classList.remove('hidden');
      return;
    }

    if (!res.ok) {
      let msg = 'Graph insights failed (HTTP ' + res.status + ')';
      try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* non-JSON */ }
      throw new Error(msg);
    }

    // Unprotected dev mode (no x402 route configured) — render directly.
    renderGraphInsights(await res.json(), null);
  } catch (err) {
    statusEl.classList.remove('hidden');
    statusEl.textContent = `⚠️ ${escapeHtml(err.message)}`;
  } finally {
    finishUi();
  }
}

function renderGraphInsights(data, settlement) {
  const outputEl = document.getElementById('graphInsightsOutput');
  const statusEl = document.getElementById('graphInsightsStatus');
  const m = data.market || {};
  const about = data.about || {};
  const benchmarks = m.benchmarks || [];
  const best = benchmarks.reduce(
    (a, b) => (b.maxSupplyApyPct > a.maxSupplyApyPct ? b : a),
    { maxSupplyApyPct: -1, topMarket: '—', symbol: '—' }
  );
  const avgVsBestPct = best.maxSupplyApyPct > 0
    ? Math.max(1, Math.min(100, Math.round((m.unifiedApyPct / best.maxSupplyApyPct) * 100)))
    : 0;

  const benchmarkRows = benchmarks.map((b) => `
    <tr>
      <td><strong>${escapeHtml(b.symbol)}</strong></td>
      <td>${b.averageSupplyApyPct}%</td>
      <td>${b.minSupplyApyPct}%</td>
      <td>${b.maxSupplyApyPct}% <small class="rates-dim">(${escapeHtml(b.topMarket)})</small></td>
      <td>${b.marketsCount}</td>
    </tr>`).join('');

  const rateRows = (m.detailedRates || []).map((r) => `
    <tr>
      <td>${escapeHtml(r.protocol)}</td>
      <td>${escapeHtml(r.chain)}</td>
      <td>${escapeHtml(r.symbol)}</td>
      <td class="rates-apy">${r.supplyApyPct}%</td>
      <td>${r.borrowApyPct}%</td>
      <td>$${Math.round(r.totalValueLockedUSD).toLocaleString()}</td>
    </tr>`).join('');

  const mcpRows = (m.mcpOpportunities || []).map((o) => `
    <tr>
      <td>${escapeHtml(o.protocol)}</td>
      <td>${escapeHtml(o.chain)}</td>
      <td>${escapeHtml(o.symbol)}</td>
      <td class="rates-apy">${o.supplyApyPct}%</td>
      <td>$${Math.round(o.totalValueLockedUSD).toLocaleString()}</td>
      <td>${escapeHtml(o.category)} / ${escapeHtml(o.tier)}</td>
    </tr>`).join('');

  outputEl.innerHTML = `
    <div class="report-stat-strip">
      <div class="report-stat tone-cyan">
        <span class="stat-label">Market APY (AI median)</span>
        <span class="report-stat-value">${m.unifiedApyPct}%</span>
        <span class="report-stat-sub">AI-assessed DeFi hurdle rate</span>
      </div>
      <div class="report-stat">
        <span class="stat-label">Raw average</span>
        <span class="report-stat-value">${m.averageApyPct ?? '—'}%</span>
        <span class="report-stat-sub">arithmetic mean, all markets</span>
      </div>
      <div class="report-stat tone-emerald">
        <span class="stat-label">Max APY</span>
        <span class="report-stat-value">${best.maxSupplyApyPct > 0 ? best.maxSupplyApyPct + '%' : '—'}</span>
        <span class="report-stat-sub">${best.maxSupplyApyPct > 0 ? escapeHtml(`${best.symbol} · ${best.topMarket}`) : 'no data'}</span>
      </div>
      <div class="report-stat">
        <span class="stat-label">Markets tracked</span>
        <span class="report-stat-value">${m.marketsTracked ?? '—'}</span>
        <span class="report-stat-sub">live subgraph markets</span>
      </div>
      <div class="report-stat">
        <span class="stat-label">MCP opportunities</span>
        <span class="report-stat-value">${(m.mcpOpportunities || []).length}</span>
        <span class="report-stat-sub">discovered beyond tracked set</span>
      </div>
    </div>

    ${data.review ? `<div class="verdict-card"><span class="verdict-quote-mark">”</span>
      <div class="report-kicker"><span>✦</span> AI market review</div>
      <p>${escapeHtml(data.review)}</p></div>` : ''}

    <div class="report-panels">
      <div class="report-panel">
        <div class="report-kicker"><span>◔</span> Stablecoin benchmarks</div>
        <table class="rates-table">
          <thead><tr><th>Asset</th><th>Avg APY</th><th>Min</th><th>Max</th><th>Markets</th></tr></thead>
          <tbody>${benchmarkRows || '<tr><td colspan="5">—</td></tr>'}</tbody>
        </table>
        <div class="liquidity-meter"><div class="liquidity-fill" data-target="${avgVsBestPct}"></div></div>
        <div class="liquidity-meta"><span>Unified average vs best market</span><span>${avgVsBestPct}%</span></div>
      </div>
      <div class="report-panel">
        <div class="report-kicker"><span>◎</span> Tracked markets (The Graph)</div>
        <table class="rates-table">
          <thead><tr><th>Protocol</th><th>Chain</th><th>Asset</th><th>Supply</th><th>Borrow</th><th>TVL</th></tr></thead>
          <tbody>${rateRows || '<tr><td colspan="6">—</td></tr>'}</tbody>
        </table>
      </div>
    </div>

    ${(m.mcpOpportunities || []).length ? `
    <div class="report-panel">
      <div class="report-kicker"><span>✧</span> MCP-discovered opportunities (additive)</div>
      <table class="rates-table">
        <thead><tr><th>Protocol</th><th>Chain</th><th>Asset</th><th>Supply APY</th><th>TVL</th><th>Type</th></tr></thead>
        <tbody>${mcpRows}</tbody>
      </table>
    </div>` : ''}

    <div class="liquidity-meta" style="margin-top: 12px;">
      <span>${escapeHtml(about.product || 'Factora Graph Market Insights')} · ${escapeHtml(m.dataSource || '')} · ${data.latencyMs ?? '?'}ms</span>
      <span>generated ${new Date(data.generatedAt).toLocaleString()}</span>
    </div>
  `;

  const txLine = settlementText(settlement);
  statusEl.classList.remove('hidden');
  statusEl.textContent = `✓ Report generated${txLine ? ' · ' + txLine : ''}`;

  outputEl.querySelectorAll('.liquidity-fill').forEach((bar) => {
    bar.style.width = Math.min(100, Number(bar.dataset.target) || 0) + '%';
  });
  outputEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  checkServerHealth();
  loadProposals();
  checkAgentStatus();
  // Restore the seller's public key and preload "My Proposals" if we have one.
  const savedProposerKey = localStorage.getItem('factoraProposerKey');
  if (savedProposerKey) {
    document.getElementById('myProposalsKeyInput').value = savedProposerKey;
    loadMyProposals();
  }
  setInterval(checkServerHealth, 10000);
  // Self-heal the status badges when the tab regains focus or connectivity.
  window.addEventListener('focus', () => { checkServerHealth(); checkAgentStatus(); });
  window.addEventListener('online', () => { checkServerHealth(); checkAgentStatus(); });
});
