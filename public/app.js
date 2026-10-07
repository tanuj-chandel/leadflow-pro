// ==========================================================================
// APP STATE
// ==========================================================================
const state = {
  activeSection: 'dashboard',
  currentUser: null,
  sessionToken: localStorage.getItem('leadflow_session_token') || null,
  locations: [],
  leads: [],
  segments: [],
  selectedLeads: [],
  settings: {},
  eventSource: null,
  activeLocationId: null,
  waStatusPoller: null,
  waPollInterval: 5000,  // starts at 5s, backs off to 60s
  waLastStatus: null
};

// ==========================================================================
// AUTHENTICATION & ACCESS CONTROL
// ==========================================================================
async function checkAuthSession() {
  const token = localStorage.getItem('leadflow_session_token');
  const loginOverlay = document.getElementById('login-modal-overlay');

  if (!token) {
    if (loginOverlay) loginOverlay.style.display = 'flex';
    applyRoleUIAccess(null);
    return false;
  }

  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'x-session-token': token }
    });
    if (res.ok) {
      const data = await res.json();
      state.currentUser = data.user;
      state.sessionToken = token;
      if (loginOverlay) loginOverlay.style.display = 'none';
      applyRoleUIAccess(data.user);
      return true;
    } else {
      localStorage.removeItem('leadflow_session_token');
      state.currentUser = null;
      state.sessionToken = null;
      if (loginOverlay) loginOverlay.style.display = 'flex';
      applyRoleUIAccess(null);
      return false;
    }
  } catch (err) {
    console.warn('Auth check error, proceeding in offline mode:', err);
    return false;
  }
}

function applyRoleUIAccess(user) {
  const navSettingsBtn = document.getElementById('nav-settings-btn');
  const userDisplayName = document.getElementById('user-display-name');
  const userRoleBadge = document.getElementById('user-role-badge');
  const settingsSection = document.getElementById('settings');

  if (!user) {
    if (userDisplayName) userDisplayName.innerText = 'Guest';
    if (userRoleBadge) userRoleBadge.innerText = 'LOCKED';
    if (navSettingsBtn) navSettingsBtn.style.display = 'none';
    return;
  }

  if (userDisplayName) userDisplayName.innerText = user.displayName || user.username;
  if (userRoleBadge) {
    userRoleBadge.innerText = user.role;
    userRoleBadge.style.color = user.role === 'ADMIN' ? '#38bdf8' : '#a855f7';
  }

  // STRICT HIDE FOR NON-ADMIN:
  if (user.role === 'ADMIN') {
    if (navSettingsBtn) navSettingsBtn.style.display = '';
  } else {
    // Completely hide Settings button from sidebar for staff/viewers
    if (navSettingsBtn) navSettingsBtn.style.display = 'none';
    // If they were on settings, force them to dashboard
    if (state.activeSection === 'settings') {
      const dashBtn = document.querySelector('[data-target="dashboard"]');
      if (dashBtn) dashBtn.click();
    }
  }
}

window.handleLoginSubmit = async function(e) {
  e.preventDefault();
  const userEl = document.getElementById('login-username');
  const passEl = document.getElementById('login-password');
  const errEl = document.getElementById('login-error-msg');
  const btn = document.getElementById('btn-login-submit');

  if (errEl) errEl.style.display = 'none';
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: userEl.value.trim(),
        password: passEl.value.trim()
      })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      localStorage.setItem('leadflow_session_token', data.token);
      state.sessionToken = data.token;
      state.currentUser = data.user;

      const loginOverlay = document.getElementById('login-modal-overlay');
      if (loginOverlay) loginOverlay.style.display = 'none';

      applyRoleUIAccess(data.user);
      showToast(`Welcome, ${data.user.displayName}!`, 'success');

      // Load initial dashboard data
      if (data.user.role === 'ADMIN') {
        loadSettings();
      }
      loadLocations();
      loadLeads();
      loadWhatsappLogs();
      loadWaStatus();
    } else {
      if (errEl) {
        errEl.innerText = data.error || 'Invalid credentials. Please try again.';
        errEl.style.display = 'block';
      }
    }
  } catch (err) {
    if (errEl) {
      errEl.innerText = 'Connection error: ' + err.message;
      errEl.style.display = 'block';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.handleLogout = async function() {
  const token = localStorage.getItem('leadflow_session_token');
  if (token) {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'x-session-token': token }
      });
    } catch (_) {}
  }
  localStorage.removeItem('leadflow_session_token');
  state.sessionToken = null;
  state.currentUser = null;
  const loginOverlay = document.getElementById('login-modal-overlay');
  if (loginOverlay) {
    const userEl = document.getElementById('login-username');
    const passEl = document.getElementById('login-password');
    if (userEl) userEl.value = '';
    if (passEl) passEl.value = '';
    loginOverlay.style.display = 'flex';
  }
  applyRoleUIAccess(null);
  showToast('You have been logged out.', 'info');
};

// ==========================================================================
// INITIALIZATION & EVENT LISTENERS
// ==========================================================================
document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();

  // Verify login session first
  const authed = await checkAuthSession();

  if (authed && state.currentUser?.role === 'ADMIN') {
    loadSettings();
  }
  loadLocations();
  loadSegments();
  loadLeads();
  loadWhatsappLogs();
  loadWaStatus();
  startWaStatusPolling();
  loadComplianceStats();

  setupEventSource();
  setupQuickChips();

  document.getElementById('add-location-form').addEventListener('submit', handleAddLocation);
  document.getElementById('btn-save-settings').addEventListener('click', handleSaveSettings);

  // Segment Generator Modal
  const segModal = document.getElementById('segment-modal-overlay');
  document.getElementById('btn-cancel-segment-modal').addEventListener('click', () => segModal.classList.add('hidden'));
  document.getElementById('segment-gen-form').addEventListener('submit', handleInstantSegmentGenerate);

  // OAuth
  document.getElementById('btn-oauth-connect').addEventListener('click', handleOAuthConnect);
  document.getElementById('btn-oauth-disconnect').addEventListener('click', handleOAuthDisconnect);

  // Lead filters
  document.getElementById('leads-search-input')?.addEventListener('input', debounce(loadLeads, 300));
  ['filter-segment', 'filter-quality', 'filter-lead-status', 'filter-rating', 'filter-safety-status', 'filter-has-phone', 'filter-has-all-three', 'filter-no-website', 'filter-mobile-only', 'filter-telegram-ready'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', loadLeads);
  });

  // Media Directory filters
  document.getElementById('media-search-input')?.addEventListener('input', debounce(loadMediaDirectory, 300));
  ['media-filter-segment', 'media-filter-3only'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', loadMediaDirectory);
  });

  // Bulk actions
  document.getElementById('select-all-leads').addEventListener('change', handleSelectAllLeads);
  document.getElementById('btn-bulk-email').addEventListener('click', triggerBulkEmail);
  document.getElementById('btn-bulk-wa').addEventListener('click', triggerBulkWhatsApp);
  document.getElementById('btn-bulk-tg')?.addEventListener('click', triggerBulkTelegram);
  document.getElementById('btn-bulk-delete').addEventListener('click', triggerBulkDelete);

  // Utilities
  document.getElementById('btn-sync-sheets').addEventListener('click', syncToGoogleSheets);
  document.getElementById('btn-clear-leads').addEventListener('click', handleClearLeads);
  document.getElementById('btn-close-progress').addEventListener('click', () => {
    document.getElementById('progress-overlay').classList.add('hidden');
    loadLeads();
    loadSegments();
  });

  document.getElementById('btn-wa-disconnect').addEventListener('click', handleWaDisconnect);

  document.getElementById('btn-cancel-run').addEventListener('click', () => {
    document.getElementById('run-options-overlay').classList.add('hidden');
    state.activeLocationId = null;
  });

  document.getElementById('btn-confirm-run').addEventListener('click', async () => {
    const id = state.activeLocationId;
    const overwrite = document.getElementById('run-overwrite').checked;
    document.getElementById('run-options-overlay').classList.add('hidden');
    state.activeLocationId = null;
    if (!id) return;
    try {
      const res = await fetch(`/api/locations/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overwrite })
      });
      if (res.ok) {
        showToast('⚡ Scraper started in background.', 'success');
        loadLocations();
      } else {
        const err = await res.json();
        showToast(`Scraper error: ${err.error}`, 'error');
      }
    } catch (e) {
      showToast('Failed to start scraper.', 'error');
    }
  });
});

// ==========================================================================
// NAVIGATION (SIDEBAR + BOTTOM NAV)
// ==========================================================================
function setupNavigation() {
  const allNavButtons = document.querySelectorAll('.menu-item, .bottom-nav .nav-item');
  allNavButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      if (!targetId) return;
      allNavButtons.forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-target') === targetId);
      });
      document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
      const section = document.getElementById(targetId);
      if (section) {
        section.classList.add('active');
        state.activeSection = targetId;
      }
      // Always refresh stats on every tab switch so everything stays in sync
      if (targetId === 'dashboard') { loadLocations(); loadLeads(); }
      if (targetId === 'segments') { loadSegments(); loadLeads(); }
      if (targetId === 'leads') loadLeads();
      if (targetId === 'media') loadMediaDirectory();
      if (targetId === 'outreach') { loadCRM(); loadWhatsappLogs(); }
      if (targetId === 'compliance') { loadComplianceData(); }
      if (targetId === 'settings') { loadSettings(); loadWaStatus(); }
    });
  });
}

function setupQuickChips() {
  const chipContainer = document.getElementById('quick-chips-container');
  if (!chipContainer) return;
  chipContainer.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip-btn');
    if (!chip) return;
    const term = chip.getAttribute('data-term');
    const searchInput = document.getElementById('search-term');
    if (searchInput) searchInput.value = term;
    showToast(`✅ Segment filled: ${term}`, 'success');
    document.getElementById('search-location')?.focus();
  });
}

// ==========================================================================
// SEGMENTS HUB
// ==========================================================================
async function loadSegments() {
  try {
    const res = await fetch('/api/segments');
    if (!res.ok) return;
    const segments = await res.json();
    state.segments = segments;
    renderSegmentsGrid(segments);
    populateSegmentFilterDropdown(segments);
  } catch (err) {
    console.error('Segments load error:', err);
  }
}

function renderSegmentsGrid(segments) {
  const container = document.getElementById('segments-grid-container');
  if (!container) return;

  if (!segments || !segments.length) {
    container.innerHTML = '<div class="panel" style="text-align:center;padding:24px;">No segments found.</div>';
    return;
  }

  container.innerHTML = segments.map(seg => `
    <div class="segment-card">
      <div class="segment-header">
        <div class="segment-icon">${seg.icon || '💼'}</div>
        <div>
          <div class="segment-title">${escapeHtml(seg.name)}</div>
          <span class="segment-tag-pill">${seg.totalLeads} Leads</span>
        </div>
      </div>

      <div class="segment-metrics">
        <div class="metric-item">
          <span style="font-size:10px;color:var(--text-secondary);">🔥 Hot</span>
          <span class="metric-value">${seg.hotLeads}</span>
        </div>
        <div class="metric-item">
          <span style="font-size:10px;color:var(--text-secondary);">📞 Phone</span>
          <span class="metric-value">${seg.withPhone}</span>
        </div>
        <div class="metric-item">
          <span style="font-size:10px;color:var(--text-secondary);">✉️ Email</span>
          <span class="metric-value">${seg.withEmail}</span>
        </div>
      </div>

      <button class="btn btn-primary" style="font-size:13px;padding:10px;" data-segment-id="${seg.id}" data-segment-name="${escapeHtml(seg.name)}" onclick="openSegmentModal('${seg.id}', '${escapeHtml(seg.name)}')">
        ⚡ Generate Leads
      </button>
    </div>
  `).join('');
}

window.openSegmentModal = function(segId, segName) {
  document.getElementById('modal-segment-id').value = segId;
  document.getElementById('segment-modal-title').innerText = `Generate Leads: ${segName}`;
  document.getElementById('segment-modal-overlay').classList.remove('hidden');
};

function populateSegmentFilterDropdown(segments) {
  // --- Hidden <select> for API filtering ---
  ['filter-segment', 'media-filter-segment'].forEach(id => {
    const dropdown = document.getElementById(id);
    if (dropdown) {
      const currentVal = dropdown.value;
      dropdown.innerHTML = '<option value="all">All Segments</option>' +
        segments.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('');
      dropdown.value = currentVal || 'all';
    }
  });

  // --- Visual segment tab pills ---
  const pillsContainer = document.getElementById('segment-filter-tabs');
  if (!pillsContainer) return;

  const currentSegmentVal = document.getElementById('filter-segment')?.value || 'all';

  pillsContainer.innerHTML = [
    { name: 'All', value: 'all', icon: '🌐' },
    ...segments.map(s => ({ name: s.name, value: s.name, icon: s.icon || '💼', count: s.totalLeads }))
  ].map(s => {
    const active = currentSegmentVal === s.value ? 'active' : '';
    const countLabel = s.count !== undefined ? ` <span class="seg-pill-count">${s.count}</span>` : '';
    return `<button class="seg-pill ${active}" data-seg="${escapeHtml(s.value)}">${s.icon} ${escapeHtml(s.name)}${countLabel}</button>`;
  }).join('');

  pillsContainer.querySelectorAll('.seg-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      pillsContainer.querySelectorAll('.seg-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const dropdown = document.getElementById('filter-segment');
      if (dropdown) dropdown.value = btn.dataset.seg;
      loadLeads();
    });
  });
}

async function handleInstantSegmentGenerate(e) {
  e.preventDefault();
  const segmentId = document.getElementById('modal-segment-id').value;
  const location = document.getElementById('modal-segment-city').value || 'Mumbai';
  const count = document.getElementById('modal-segment-count').value || '10';
  document.getElementById('segment-modal-overlay').classList.add('hidden');
  showProgressOverlay('⚡ Generating Leads', `Generating leads in ${location}...`);
  try {
    const res = await fetch('/api/leads/generate-instant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segmentId, location, count })
    });
    if (res.ok) {
      const data = await res.json();
      showToast(`✅ Added ${data.added || 0} leads!`, 'success');
      // Sync dashboard stats + segments hub immediately after generation
      await Promise.all([loadLeads(), loadSegments()]);
    }
  } catch (err) {
    showToast('Error starting lead generation.', 'error');
  }
}

// ==========================================================================
// SCRAPER LOCATIONS
// ==========================================================================
async function loadLocations() {
  try {
    const res = await fetch('/api/locations');
    if (!res.ok) return;
    state.locations = await res.json();
    renderLocationsTable(state.locations);
  } catch (err) {
    console.error('Error loading locations:', err);
  }
}

function renderLocationsTable(locations) {
  const tbody = document.getElementById('locations-list');
  if (!tbody) return;
  if (!locations || !locations.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);padding:24px;">No queries added yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = locations.map(loc => `
    <tr>
      <td><strong>${escapeHtml(loc.term)}</strong></td>
      <td>${escapeHtml(loc.location)}</td>
      <td>${loc.maxLeads}</td>
      <td>
        <span class="badge ${getStatusBadgeClass(loc.status)}">${loc.status}</span>
        ${loc.error ? `<div style="font-size:10px;color:var(--color-danger);margin-top:2px;">${escapeHtml(loc.error)}</div>` : ''}
      </td>
      <td class="actions-col">
        <button class="btn btn-secondary btn-sm" onclick="runLocationScraper('${loc.id}')">▶ Run</button>
        <button class="btn btn-danger-outline btn-sm" onclick="deleteLocation('${loc.id}')">✕</button>
      </td>
    </tr>
  `).join('');
}

async function handleAddLocation(e) {
  e.preventDefault();
  const term = document.getElementById('search-term').value.trim();
  const location = document.getElementById('search-location').value.trim();
  const maxLeads = document.getElementById('max-leads').value;
  if (!term || !location) return;
  try {
    const res = await fetch('/api/locations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term, location, maxLeads })
    });
    if (res.ok) {
      showToast('Search query added!', 'success');
      document.getElementById('search-term').value = '';
      loadLocations();
    } else {
      showToast('Failed to add search query.', 'error');
    }
  } catch (err) {
    showToast('Network error.', 'error');
  }
}

window.runLocationScraper = function(id) {
  state.activeLocationId = id;
  document.getElementById('run-options-overlay').classList.remove('hidden');
};

window.deleteLocation = async function(id) {
  try {
    await fetch(`/api/locations/${id}`, { method: 'DELETE' });
    showToast('Query deleted.', 'success');
    loadLocations();
  } catch (err) {
    showToast('Failed to delete.', 'error');
  }
};

// ==========================================================================
// LEADS FEED
// ==========================================================================
async function loadLeads() {
  try {
    const query = document.getElementById('leads-search-input')?.value || '';
    const segment = document.getElementById('filter-segment')?.value || 'all';
    const qualityScore = document.getElementById('filter-quality')?.value || 'all';
    const leadStatus = document.getElementById('filter-lead-status')?.value || 'all';
    const minRating = document.getElementById('filter-rating')?.value || 'all';
    const hasPhone = document.getElementById('filter-has-phone')?.checked ? 'true' : '';
    const hasAllThree = document.getElementById('filter-has-all-three')?.checked ? 'true' : '';
    const noWebsite = document.getElementById('filter-no-website')?.checked ? 'true' : '';
    const mobileOnly = document.getElementById('filter-mobile-only')?.checked ? 'true' : '';
    const telegramReady = document.getElementById('filter-telegram-ready')?.checked ? 'true' : '';
    const safetyStatusFilter = document.getElementById('filter-safety-status')?.value || 'all';

    const params = new URLSearchParams({ search: query, segment, qualityScore, leadStatus, minRating, safetyStatusFilter, hasPhone, hasAllThree, noWebsite, mobileOnly, telegramReady });
    const res = await fetch(`/api/leads?${params}`);
    if (!res.ok) return;
    const leads = await res.json();
    state.leads = leads;

    updateStatCounters(leads);
    renderMobileLeadCards(leads);
    renderDesktopLeadsTable(leads);
    renderCRM();
  } catch (err) {
    console.error('Error loading leads:', err);
  }
}

function updateStatCounters(leads) {
  const total = leads.length;
  const hot = leads.filter(l => l.qualityScore === 'Hot').length;
  const phone = leads.filter(l => l.phone && l.phone.trim().length >= 7).length;
  const waSent = leads.filter(l => l.whatsappStatus === 'Sent').length;
  const emailLeads = leads.filter(l => l.email && l.email.trim()).length;
  const complete3of3 = leads.filter(l => l.phone && l.website && (l.facebook || l.instagram || l.linkedin || l.twitter || l.telegram)).length;

  setText('stat-total-leads', total);
  setText('stat-hot-leads', hot);
  setText('stat-leads-phone', phone);
  setText('stat-wa-sent', waSent);
  setText('stat-email-leads', emailLeads);
  setText('stat-complete-leads', complete3of3);

  // Pipeline funnel stats
  const countNew = leads.filter(l => l.leadStatus === 'New').length;
  const countContacted = leads.filter(l => l.leadStatus === 'Contacted').length;
  const countInterested = leads.filter(l => l.leadStatus === 'Interested').length;
  const countClosed = leads.filter(l => l.leadStatus === 'Closed').length;

  setText('dash-funnel-new', countNew);
  setText('dash-funnel-contacted', countContacted);
  setText('dash-funnel-interested', countInterested);
  setText('dash-funnel-closed', countClosed);

  renderDashRecentLeads(leads);
}

function renderDashRecentLeads(leads) {
  const container = document.getElementById('dash-recent-leads');
  if (!container) return;

  if (!leads || !leads.length) {
    container.innerHTML = `<div style="text-align:center;padding:16px;color:var(--text-sec);font-size:12px;">No leads discovered yet. Add a query below or pick a segment.</div>`;
    return;
  }

  // Display top 5 most recent / highest quality leads
  const topLeads = leads.slice(0, 5);

  container.innerHTML = topLeads.map(lead => {
    const waText = getFilledTemplate(state.settings?.waMessageTemplate, lead);
    const waLink = lead.phone ? `https://wa.me/${lead.phone.replace(/\D/g, '')}?text=${encodeURIComponent(waText)}` : '';
    const tgText = getFilledTemplate(state.settings?.telegramMessageTemplate, lead);
    const tgLink = lead.telegram ? lead.telegram : (lead.phone ? `https://t.me/+${lead.phone.replace(/\D/g, '')}?text=${encodeURIComponent(tgText)}` : '');

    return `
      <div class="dash-lead-item">
        <div class="dash-lead-info">
          <div class="dash-lead-title-row">
            <span class="dash-lead-name">${escapeHtml(lead.businessName)}</span>
            <span class="segment-tag-pill">${escapeHtml(lead.segment || 'General')}</span>
            ${lead.rating ? `<span style="font-size:11px;font-weight:700;color:#fbbf24;">⭐ ${lead.rating}</span>` : ''}
            ${getQualityBadgeHTML(lead.qualityScore)}
          </div>
          <div class="dash-lead-meta">
            ${lead.location ? `<span>📍 ${escapeHtml(lead.location)}</span>` : ''}
            ${lead.phone ? `<span>📞 ${escapeHtml(lead.phone)}</span>` : ''}
            ${lead.email ? `<span>✉️ ${escapeHtml(lead.email)}</span>` : ''}
          </div>
        </div>
        <div class="dash-lead-actions">
          ${lead.phone ? `<a href="${waLink}" target="_blank" class="btn-dash-action btn-dash-wa">💬 WhatsApp</a>` : ''}
          ${tgLink ? `<a href="${tgLink}" target="_blank" class="btn-dash-action btn-dash-tg">✈️ Telegram</a>` : ''}
          ${lead.email ? `<a href="mailto:${lead.email}" class="btn-dash-action btn-dash-email">✉️ Email</a>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.innerText = val;
}

function getQualityBadgeHTML(score) {
  if (score === 'Hot') return '<span class="badge-quality badge-hot">🔥 Hot</span>';
  if (score === 'Warm') return '<span class="badge-quality badge-warm">⚡ Warm</span>';
  return '<span class="badge-quality badge-cold">❄️ Cold</span>';
}

function getSafetyBadgeHTML(status, reasonCode, reason) {
  const code = reasonCode || status || 'ALLOWED';
  const tooltip = reason ? `title="${escapeHtml(reason)}"` : `title="${escapeHtml(code)}"`;
  if (status === 'ALLOWED' || code === 'ALLOWED') {
    return `<span class="badge-safety badge-safety-allowed" ${tooltip}>🟢 Outreach Allowed</span>`;
  }
  if (status === 'RESTRICTED' || code === 'COOLDOWN_ACTIVE' || code === 'DAILY_QUOTA_EXCEEDED') {
    return `<span class="badge-safety badge-safety-restricted" ${tooltip}>🟡 Restricted (${escapeHtml(code)})</span>`;
  }
  return `<span class="badge-safety badge-safety-blocked" ${tooltip}>🔴 Outreach Blocked (${escapeHtml(code)})</span>`;
}

function getProvenanceBadgeHTML(lead) {
  const isMock = lead.dataProvenance === 'MOCK / SIMULATED' || lead.dataMode === 'MOCK' || lead.dataMode === 'SIMULATED' || lead.isMock;
  if (isMock) {
    return `<span class="badge-provenance badge-provenance-mock" title="Demonstration / Simulated Test Data">🟣 MOCK</span>`;
  }
  return `<span class="badge-provenance badge-provenance-real" title="Real Business Lead (Google Places / Web Verified)">🟢 REAL</span>`;
}

function getVerificationChipsHTML(lead) {
  const chips = [];
  if (lead.isPlacesVerified || (lead.placeId && lead.placeId.length > 5)) {
    chips.push(`<span class="verify-chip verified" title="Google Places ID Verified: ${escapeHtml(lead.placeId || '')}">📍 Places</span>`);
  }
  if (lead.isPhoneVerified || (lead.phone && lead.phone.length >= 7)) {
    chips.push(`<span class="verify-chip verified" title="Phone Extracted & Normalized">📞 Phone</span>`);
  }
  if (lead.isWebsiteActive || (lead.website && lead.website.trim())) {
    chips.push(`<span class="verify-chip verified" title="Verified Web Presence">🌐 Web</span>`);
  } else {
    chips.push(`<span class="verify-chip unverified" title="No Website Found">🚫 No Web</span>`);
  }
  return chips.join(' ');
}


function getFilledTemplate(tmpl, lead) {
  if (!tmpl) return '';
  return tmpl
    .replace(/{{BusinessName}}/g, lead.businessName || '')
    .replace(/{{Location}}/g, lead.location || '')
    .replace(/{{Segment}}/g, lead.segment || '')
    .replace(/{{Phone}}/g, lead.phone || '')
    .replace(/{{Website}}/g, lead.website || '')
    .replace(/{{Rating}}/g, lead.rating ? `⭐ ${lead.rating}` : '')
    .replace(/{{PersonalizedPitch}}/g, lead.notes || '');
}

function renderMobileLeadCards(leads) {
  const container = document.getElementById('mobile-cards-container');
  if (!container) return;

  if (!leads || !leads.length) {
    container.innerHTML = `
      <div class="empty-state-card">
        <div style="font-size:40px;margin-bottom:12px;">🎯</div>
        <h3>No Leads Yet</h3>
        <p>Go to <strong>Segments Hub</strong> and tap ⚡ Generate Leads,<br>or add a custom query in the Generator tab.</p>
      </div>`;
    return;
  }

  container.innerHTML = leads.map(lead => {
    const is3of3 = lead.hasAll3 || (lead.phone && lead.website && (lead.facebook || lead.instagram || lead.linkedin || lead.twitter || lead.telegram));
    const waText = getFilledTemplate(state.settings?.waMessageTemplate, lead);
    const waLink = lead.phone ? `https://wa.me/${lead.phone.replace(/\D/g, '')}?text=${encodeURIComponent(waText)}` : '';
    
    const tgText = getFilledTemplate(state.settings?.telegramMessageTemplate, lead);
    const tgLink = lead.telegram ? lead.telegram : (lead.phone ? `https://t.me/+${lead.phone.replace(/\D/g, '')}?text=${encodeURIComponent(tgText)}` : '');

    const socials = [
      lead.facebook ? `<a href="${lead.facebook}" target="_blank" class="social-chip" title="Facebook">📘</a>` : '',
      lead.instagram ? `<a href="${lead.instagram}" target="_blank" class="social-chip" title="Instagram">📷</a>` : '',
      lead.linkedin ? `<a href="${lead.linkedin}" target="_blank" class="social-chip" title="LinkedIn">💼</a>` : '',
      lead.twitter ? `<a href="${lead.twitter}" target="_blank" class="social-chip" title="Twitter/X">🐦</a>` : '',
      lead.telegram ? `<a href="${lead.telegram}" target="_blank" class="social-chip" title="Telegram">✈️</a>` : ''
    ].filter(Boolean).join('');

    return `
    <div class="lead-card-mobile" id="card-${lead.id}">
      <div class="lead-card-top">
        <div style="flex:1;min-width:0;">
          <div class="lead-name lead-title-clickable" onclick="openLeadDrawer('${lead.id}')">${escapeHtml(lead.businessName || 'Business Lead')}</div>
          <div class="lead-meta" style="margin-top:4px;gap:6px;flex-wrap:wrap;align-items:center;">
            ${getProvenanceBadgeHTML(lead)}
            ${getSafetyBadgeHTML(lead.safetyStatus, lead.safetyReasonCode, lead.safetyReason)}
            ${is3of3 ? '<span class="badge-3of3">🏆 3/3 Complete</span>' : ''}
            ${getQualityBadgeHTML(lead.qualityScore)}
            <span class="segment-tag-pill">${escapeHtml(lead.segment || 'General')}</span>
            ${lead.rating ? `<span style="font-size:11px;">⭐ ${lead.rating}</span>` : ''}
            ${lead.notes ? `<span class="ai-pitch-chip" onclick="openLeadDrawer('${lead.id}')">💡 AI Pitch</span>` : ''}
          </div>
        </div>
        <button class="btn btn-danger-outline btn-sm" style="padding:4px 8px;flex-shrink:0;" onclick="deleteSingleLead('${lead.id}')">✕</button>
      </div>

      <div style="font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:6px;">
        📍 ${escapeHtml((lead.address || lead.location || 'Not specified').substring(0, 80))}
      </div>

      ${lead.phone ? `<div style="font-size:13px;color:var(--color-emerald);font-weight:600;">📞 ${escapeHtml(lead.phone)}</div>` : ''}
      ${lead.email ? `<div style="font-size:12px;color:var(--color-cyan);">✉️ ${escapeHtml(lead.email)}</div>` : ''}
      ${lead.website ? `<div style="font-size:11px;"><a href="${lead.website}" target="_blank" style="color:var(--text-secondary);text-decoration:underline;">🌐 ${escapeHtml(lead.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a></div>` : ''}

      <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
        ${getVerificationChipsHTML(lead)}
        ${socials}
      </div>

      <div class="lead-actions-row">
        ${lead.phone ? `
          <a href="tel:${lead.phone}" class="action-btn-touch btn-secondary">📞 Call</a>
          <a href="${waLink}" target="_blank" class="action-btn-touch btn-accent" onclick="return handleSingleWhatsAppClick(event, '${lead.id}', '${waLink}')">💬 WhatsApp</a>
          ${(lead.phone || lead.telegram) ? `<button class="action-btn-touch" style="background:#0284c7;color:white;border:none;" onclick="sendSingleLeadTelegram('${lead.id}')">✈️ Auto TG</button>` : ''}
          ${tgLink ? `<a href="${tgLink}" target="_blank" class="action-btn-touch" style="background:rgba(2,132,199,0.18);color:#38bdf8;">🔗 TG Link</a>` : ''}
        ` : ''}
        ${lead.email ? `<a href="mailto:${lead.email}?subject=${encodeURIComponent('Partnership Opportunity - ' + (lead.businessName || ''))}" class="action-btn-touch btn-primary">✉️ Email</a>` : ''}
        ${!lead.phone && !lead.email ? `<span style="font-size:11px;color:var(--text-muted);padding:8px;">No contact info available</span>` : ''}
      </div>

      <div class="lead-pipeline-row">
        <span class="pipeline-label">Pipeline:</span>
        <select onchange="updateLeadStatus('${lead.id}', this.value)">
          <option value="New" ${lead.leadStatus === 'New' ? 'selected' : ''}>🆕 New</option>
          <option value="Contacted" ${lead.leadStatus === 'Contacted' ? 'selected' : ''}>📩 Contacted</option>
          <option value="Interested" ${lead.leadStatus === 'Interested' ? 'selected' : ''}>🔥 Interested</option>
          <option value="Closed" ${lead.leadStatus === 'Closed' ? 'selected' : ''}>🎉 Closed</option>
          <option value="Unqualified" ${lead.leadStatus === 'Unqualified' ? 'selected' : ''}>❌ Unqualified</option>
        </select>
      </div>
    </div>`;
  }).join('');
}

function renderDesktopLeadsTable(leads) {
  const tbody = document.getElementById('leads-list');
  if (!tbody) return;
  if (!leads || !leads.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-secondary);">No leads found. Use Segments Hub or add a query.</td></tr>`;
    return;
  }

  tbody.innerHTML = leads.map(lead => {
    const isNoWeb = !lead.website || lead.website.trim() === '';
    const templateToUse = (isNoWeb && state.settings?.waNoWebsiteTemplate) 
      ? state.settings.waNoWebsiteTemplate 
      : state.settings?.waMessageTemplate;
    const waText = getFilledTemplate(templateToUse, lead);
    const waLink = lead.phone ? `https://wa.me/${lead.phone.replace(/\D/g, '')}?text=${encodeURIComponent(waText)}` : '';
    const tgText = getFilledTemplate(state.settings?.telegramMessageTemplate, lead);
    const tgLink = lead.telegram ? lead.telegram : (lead.phone ? `https://t.me/+${lead.phone.replace(/\D/g, '')}?text=${encodeURIComponent(tgText)}` : '');

    let phoneHtml = '<span style="color:var(--text-muted);">—</span>';
    if (lead.phone) {
      if (lead.isLandline) {
        phoneHtml = `
          <div style="display:flex;align-items:center;gap:4px;">
            <span style="color:#f87171;font-size:11px;font-family:var(--font-mono);" title="Landline (STD) — Indian landlines cannot receive WhatsApp">☎️ ${escapeHtml(lead.phone)}</span>
            <span style="font-size:9px;background:rgba(239,68,68,0.15);color:#f87171;padding:1px 5px;border-radius:4px;font-weight:700;">Landline</span>
          </div>`;
      } else {
        phoneHtml = `
          <div style="display:flex;align-items:center;gap:6px;">
            <a href="${waLink}" target="_blank" onclick="return handleSingleWhatsAppClick(event, '${lead.id}', '${waLink}')" style="color:var(--color-emerald);font-weight:600;text-decoration:none;font-size:12px;font-family:var(--font-mono);" title="Send WhatsApp (Verified Mobile)">💬 ${escapeHtml(lead.phone)}</a>
            ${lead.isMobile ? '<span style="font-size:9px;background:rgba(16,185,129,0.15);color:#34d399;padding:1px 5px;border-radius:4px;font-weight:700;">Mobile</span>' : ''}
            ${tgLink ? `<a href="${tgLink}" target="_blank" style="background:rgba(14,165,233,0.15);color:#0ea5e9;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;text-decoration:none;" title="Send Telegram">✈️ TG</a>` : ''}
          </div>`;
      }
    }

    return `
    <tr>
      <td class="checkbox-col">
        <label class="custom-checkbox">
          <input type="checkbox" class="lead-checkbox" data-id="${lead.id}">
          <span class="checkmark"></span>
        </label>
      </td>
      <td>
        <strong style="font-size:13px;" class="lead-title-clickable" onclick="openLeadDrawer('${lead.id}')" title="Click to view full dossier">${escapeHtml(lead.businessName)}</strong>
        <div style="font-size:11px;margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          ${getProvenanceBadgeHTML(lead)}
          ${getSafetyBadgeHTML(lead.safetyStatus, lead.safetyReasonCode, lead.safetyReason)}
          <span class="segment-tag-pill">${escapeHtml(lead.segment || 'General')}</span>
          ${lead.isHighOpportunity ? `<span class="ai-pitch-chip" style="background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.35);font-weight:700;" onclick="openLeadDrawer('${lead.id}')" title="High Google Rating + No Website (High-Ticket Candidate for AI Chatbot & 1-Page Storefront)">🎯 No Website</span>` : ''}
          ${lead.notes && !lead.isHighOpportunity ? `<span class="ai-pitch-chip" onclick="openLeadDrawer('${lead.id}')" title="${escapeHtml(lead.notes)}">💡 AI Pitch</span>` : ''}
          <span class="ai-pitch-chip" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3);font-weight:700;" onclick="openLeadDrawer('${lead.id}')" title="Click to view Sales Action Recommendation">⚡ Action Rec</span>
        </div>
        ${lead.address ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${escapeHtml(lead.address.substring(0, 60))}</div>` : ''}
      </td>
      <td>
        ${phoneHtml}
      </td>
      <td>
        ${lead.email ? `
          <div style="display:flex;align-items:center;gap:4px;">
            <a href="mailto:${lead.email}" style="color:var(--color-cyan);text-decoration:none;font-size:12px;">${escapeHtml(lead.email)}</a>
            <button class="btn-copy-mini" style="padding:1px 5px;" onclick="copyText('${escapeHtml(lead.email)}', 'Email')" title="Copy Email">📋</button>
          </div>
        ` : '<span style="color:var(--text-muted);">—</span>'}
      </td>
      <td>
        ${lead.website ? `<a href="${lead.website}" target="_blank" class="table-url-link" title="${escapeHtml(lead.website)}">🌐 ${escapeHtml(formatShortUrl(lead.website))}</a>` : '<span style="color:#fbbf24;font-size:11px;font-weight:600;" title="No official website listed on Google">🚫 No Website</span>'}
        <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
          ${getVerificationChipsHTML(lead)}
          ${lead.facebook ? `<a href="${lead.facebook}" target="_blank" class="social-chip" title="Facebook">📘</a>` : ''}
          ${lead.instagram ? `<a href="${lead.instagram}" target="_blank" class="social-chip" title="Instagram">📷</a>` : ''}
          ${lead.linkedin ? `<a href="${lead.linkedin}" target="_blank" class="social-chip" title="LinkedIn">💼</a>` : ''}
          ${lead.twitter ? `<a href="${lead.twitter}" target="_blank" class="social-chip" title="Twitter/X">🐦</a>` : ''}
          ${lead.telegram ? `<a href="${lead.telegram}" target="_blank" class="social-chip" title="Telegram">✈️</a>` : ''}
        </div>
      </td>
      <td>
        ${getQualityBadgeHTML(lead.qualityScore)}
        ${lead.rating ? `<div style="font-size:10px;margin-top:2px;">⭐ ${lead.rating}</div>` : ''}
      </td>
      <td>
        <select style="padding:4px 6px;font-size:11px;" onchange="updateLeadStatus('${lead.id}', this.value)">
          <option value="New" ${lead.leadStatus === 'New' ? 'selected' : ''}>🆕 New</option>
          <option value="Contacted" ${lead.leadStatus === 'Contacted' ? 'selected' : ''}>📩 Contacted</option>
          <option value="Interested" ${lead.leadStatus === 'Interested' ? 'selected' : ''}>🔥 Interested</option>
          <option value="Closed" ${lead.leadStatus === 'Closed' ? 'selected' : ''}>🎉 Closed</option>
          <option value="Unqualified" ${lead.leadStatus === 'Unqualified' ? 'selected' : ''}>❌ Unqualified</option>
        </select>
      </td>
      <td class="actions-col" style="display:flex;gap:4px;align-items:center;">
        ${(lead.phone || lead.telegram) ? `<button class="btn btn-sm" style="background:#0284c7;color:white;padding:3px 7px;font-size:11px;border:none;" onclick="sendSingleLeadTelegram('${lead.id}')" title="Auto Send Telegram Outreach via Agent">✈️</button>` : ''}
        <button class="btn btn-danger-outline btn-sm" style="padding:3px 6px;" onclick="deleteSingleLead('${lead.id}')">✕</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.lead-checkbox').forEach(cb => cb.addEventListener('change', updateSelectedLeadCount));
}

window.updateLeadStatus = async function(id, leadStatus) {
  try {
    await fetch(`/api/leads/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadStatus })
    });
    showToast('Pipeline status updated!', 'success');
    loadLeads();
  } catch (e) {
    showToast('Failed to update status.', 'error');
  }
};

window.deleteSingleLead = async function(id) {
  try {
    await fetch(`/api/leads/${id}`, { method: 'DELETE' });
    showToast('Lead deleted.', 'success');
    loadLeads();
    loadSegments();
  } catch (e) {
    showToast('Error deleting lead.', 'error');
  }
};

window.handleSingleWhatsAppClick = async function(e, leadId, waLink) {
  const lead = state.leads?.find(l => l.id === leadId);
  const name = lead?.businessName || 'Lead';

  if (lead && lead.safetyStatus === 'BLOCKED') {
    if (e) e.preventDefault();
    showSingleSafetyModal('WhatsApp Outreach Blocked', lead.safetyReasonCode, lead.safetyReason, name);
    return false;
  }

  // Preflight check
  try {
    const preRes = await fetch(`/api/compliance/check-lead/${leadId}/whatsapp`);
    const preData = await preRes.json();
    if (!preData.eligible) {
      if (e) e.preventDefault();
      showSingleSafetyModal('WhatsApp Outreach Blocked', preData.reasonCode, preData.reason, name);
      return false;
    }
  } catch (_) {}

  return true;
};

window.sendSingleLeadTelegram = async function(id) {
  const lead = state.leads?.find(l => l.id === id);
  const name = lead?.businessName || 'lead';

  // Live safety preflight
  try {
    const preRes = await fetch(`/api/compliance/check-lead/${id}/telegram`);
    const preData = await preRes.json();
    if (!preData.eligible) {
      showSingleSafetyModal('Telegram Outreach Blocked', preData.reasonCode, preData.reason, name);
      return;
    }
  } catch (_) {}

  showToast(`✈️ Dispatching Telegram pitch to ${name}...`, 'info');
  try {
    const res = await fetch(`/api/telegram-user/send-lead/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ Delivered to ${name} on Telegram!`, 'success');
      loadLeads();
      loadComplianceStats();
    } else if (data.blocked) {
      showSingleSafetyModal('Outreach Blocked by Safety Gate', data.reasonCode, data.reason, name);
    } else {
      showToast(data.error || 'Failed to deliver on Telegram.', 'error');
    }
  } catch (err) {
    showToast('Network error while sending Telegram message.', 'error');
  }
};

window.showSingleSafetyModal = function(title, reasonCode, message, leadName) {
  const modal = document.getElementById('single-safety-modal');
  if (!modal) return;

  setText('single-safety-title', title || 'Outreach Blocked');
  setText('single-safety-message', message || `Contact ${leadName || ''} is blocked by Compliance Engine.`);
  const badgeContainer = document.getElementById('single-safety-badge-container');
  if (badgeContainer) {
    badgeContainer.innerHTML = `<span class="badge-safety badge-safety-blocked" style="font-size:12px;padding:4px 10px;">Reason: ${escapeHtml(reasonCode || 'BLOCKED')}</span>`;
  }
  modal.classList.remove('hidden');
};

window.closeSingleSafetyModal = function() {
  document.getElementById('single-safety-modal')?.classList.add('hidden');
};

let currentDrawerLead = null;

window.openLeadDrawer = function(id) {
  const lead = state.leads?.find(l => l.id === id);
  if (!lead) return;
  currentDrawerLead = lead;

  const titleEl = document.getElementById('drawer-title');
  if (titleEl) titleEl.innerText = lead.businessName || 'Business Dossier';

  const locEl = document.getElementById('drawer-location');
  if (locEl) locEl.innerText = '📍 ' + (lead.address || lead.location || 'Location Not Specified');

  const segEl = document.getElementById('drawer-segment');
  if (segEl) segEl.innerText = lead.segment || 'General';

  const qualEl = document.getElementById('drawer-quality');
  if (qualEl) {
    qualEl.className = lead.qualityScore === 'Hot' ? 'badge-quality badge-hot' : (lead.qualityScore === 'Warm' ? 'badge-quality badge-warm' : 'badge-quality badge-cold');
    qualEl.innerText = lead.qualityScore === 'Hot' ? '🔥 Hot' : (lead.qualityScore === 'Warm' ? '⚡ Warm' : '❄️ Cold');
  }

  const rateEl = document.getElementById('drawer-rating');
  if (rateEl) rateEl.innerText = lead.rating ? `⭐ ${lead.rating}` : '⭐ 4.8';

  const pitchEl = document.getElementById('drawer-pitch');
  if (pitchEl) pitchEl.innerText = lead.notes || 'Custom growth and business process automation pitch tailored for this enterprise.';

  // Client Reply Card & AI Suggested Response
  const replyCard = document.getElementById('drawer-reply-card');
  const replyTextEl = document.getElementById('drawer-reply-text');
  const replyTimeEl = document.getElementById('drawer-reply-time');
  const aiDraftEl = document.getElementById('drawer-ai-draft');
  const sendDraftBtn = document.getElementById('drawer-btn-send-wa-draft');

  if (lead.lastReplyText) {
    if (replyCard) replyCard.classList.remove('hidden');
    if (replyTextEl) replyTextEl.innerText = lead.lastReplyText;
    if (replyTimeEl) {
      replyTimeEl.innerText = lead.lastReplyAt ? `Received: ${new Date(lead.lastReplyAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    }
    const draft = lead.aiSuggestedReply || '';
    if (aiDraftEl) aiDraftEl.innerText = draft || 'Drafting suggested reply...';
    if (sendDraftBtn) {
      const cleanP = (lead.phone || '').replace(/\D/g, '');
      sendDraftBtn.href = cleanP ? `https://wa.me/${cleanP}?text=${encodeURIComponent(draft)}` : '#';
    }
  } else {
    if (replyCard) replyCard.classList.add('hidden');
  }

  const phoneEl = document.getElementById('drawer-phone');
  if (phoneEl) phoneEl.innerText = lead.phone || 'No phone listed';

  const emailEl = document.getElementById('drawer-email');
  if (emailEl) emailEl.innerText = lead.email || 'No email listed';

  const webEl = document.getElementById('drawer-website');
  if (webEl) {
    if (lead.website) {
      webEl.href = lead.website;
      webEl.innerText = lead.website.replace(/^https?:\/\//, '').replace(/\/$/, '');
    } else {
      webEl.removeAttribute('href');
      webEl.innerText = 'No website listed';
    }
  }

  // Quick Action Buttons
  const isNoWeb = !lead.website || lead.website.trim() === '';
  const waTmpl = (isNoWeb && state.settings?.waNoWebsiteTemplate) ? state.settings.waNoWebsiteTemplate : state.settings?.waMessageTemplate;
  const waText = getFilledTemplate(waTmpl, lead);
  const waLink = lead.phone ? `https://wa.me/${lead.phone.replace(/\D/g, '')}?text=${encodeURIComponent(waText)}` : '#';
  const tgText = getFilledTemplate(state.settings?.telegramMessageTemplate, lead);
  const tgLink = lead.telegram ? lead.telegram : (lead.phone ? `https://t.me/+${lead.phone.replace(/\D/g, '')}?text=${encodeURIComponent(tgText)}` : '#');

  const waBtn = document.getElementById('drawer-btn-wa');
  if (waBtn) {
    if (lead.isLandline) {
      waBtn.href = '#';
      waBtn.title = 'Landline (STD) number cannot receive WhatsApp. Please call instead.';
      waBtn.style.opacity = '0.5';
      waBtn.style.pointerEvents = 'none';
    } else {
      waBtn.href = waLink;
      waBtn.title = 'Send WhatsApp Message';
      waBtn.style.opacity = '1';
      waBtn.style.pointerEvents = 'auto';
    }
  }

  const tgBtn = document.getElementById('drawer-btn-tg');
  if (tgBtn) tgBtn.href = tgLink;

  const emailBtn = document.getElementById('drawer-btn-email');
  if (emailBtn) emailBtn.href = lead.email ? `mailto:${lead.email}?subject=${encodeURIComponent('AI & Workflow Automation for ' + lead.businessName)}` : '#';

  const callBtn = document.getElementById('drawer-btn-call');
  if (callBtn) callBtn.href = lead.phone ? `tel:${lead.phone}` : '#';

  // Socials list
  const socialsContainer = document.getElementById('drawer-socials');
  if (socialsContainer) {
    const sList = [
      lead.facebook ? `<a href="${lead.facebook}" target="_blank" class="social-chip" title="Facebook">📘 Facebook</a>` : '',
      lead.instagram ? `<a href="${lead.instagram}" target="_blank" class="social-chip" title="Instagram">📷 Instagram</a>` : '',
      lead.linkedin ? `<a href="${lead.linkedin}" target="_blank" class="social-chip" title="LinkedIn">💼 LinkedIn</a>` : '',
      lead.twitter ? `<a href="${lead.twitter}" target="_blank" class="social-chip" title="Twitter/X">🐦 Twitter/X</a>` : '',
      lead.telegram ? `<a href="${lead.telegram}" target="_blank" class="social-chip" title="Telegram">✈️ Telegram</a>` : ''
    ].filter(Boolean);
    socialsContainer.innerHTML = sList.length > 0 ? sList.join('') : '<span style="font-size:12px;color:var(--text-muted);">No social profiles detected</span>';
  }

  // Pipeline select
  const pipeSelect = document.getElementById('drawer-pipeline-select');
  if (pipeSelect) pipeSelect.value = lead.leadStatus || 'New';

  // Fetch and display Lead Scoring, ICP Fit & Sales Priority Breakdown
  window.currentDrawerLeadId = lead.id;
  loadDrawerScoreData(lead.id);
  loadDrawerRecommendationData(lead.id);

  // Show drawer
  document.getElementById('lead-drawer-overlay')?.classList.remove('hidden');
};

async function loadDrawerScoreData(leadId) {
  const salesValEl = document.getElementById('drawer-score-sales-val');
  const icpValEl = document.getElementById('drawer-score-icp-val');
  const confValEl = document.getElementById('drawer-score-conf-val');
  const priorityBadge = document.getElementById('drawer-score-priority-badge');
  const posList = document.getElementById('drawer-score-positive-list');
  const negList = document.getElementById('drawer-score-negative-list');
  const unkList = document.getElementById('drawer-score-unknown-list');

  if (salesValEl) salesValEl.innerText = '...';
  if (icpValEl) icpValEl.innerText = '...';
  if (confValEl) confValEl.innerText = '...';
  if (posList) posList.innerHTML = '<li>Evaluating evidence...</li>';
  if (negList) negList.innerHTML = '<li>Evaluating evidence...</li>';
  if (unkList) unkList.innerHTML = '<li>Evaluating evidence...</li>';

  try {
    const res = await fetch(`/api/intelligence/score/${leadId}/explanation`);
    if (!res.ok) return;
    const data = await res.json();

    if (salesValEl) salesValEl.innerText = data.salesPriorityScore ?? '—';
    if (icpValEl) icpValEl.innerText = data.icpFitScore ?? '—';
    if (confValEl) confValEl.innerText = data.dataConfidenceScore ? `${data.dataConfidenceScore}%` : '—';

    if (priorityBadge) {
      const pLevel = data.priorityLevel || 'P5 — INSUFFICIENT DATA';
      const versionTag = data.scoringVersion ? ` • Scoring v${data.scoringVersion}` : ' • Scoring v2';
      priorityBadge.innerText = `${pLevel}${versionTag}`;
      if (pLevel.startsWith('P1')) {
        priorityBadge.style.background = 'rgba(16,185,129,0.2)';
        priorityBadge.style.color = '#34d399';
      } else if (pLevel.startsWith('P2')) {
        priorityBadge.style.background = 'rgba(56,189,248,0.2)';
        priorityBadge.style.color = '#38bdf8';
      } else if (pLevel.startsWith('P3')) {
        priorityBadge.style.background = 'rgba(245,158,11,0.2)';
        priorityBadge.style.color = '#fbbf24';
      } else {
        priorityBadge.style.background = 'rgba(99,102,241,0.2)';
        priorityBadge.style.color = '#a5b4fc';
      }
    }

    if (posList) {
      const pos = data.positiveFactors || [];
      posList.innerHTML = pos.length > 0 
        ? pos.map(f => `<li>${escapeHtml(f)}</li>`).join('') 
        : '<li style="color:var(--text-muted);">No strong positive factors detected yet.</li>';
    }

    if (negList) {
      const neg = data.negativeFactors || [];
      negList.innerHTML = neg.length > 0 
        ? neg.map(f => `<li>${escapeHtml(f)}</li>`).join('') 
        : '<li style="color:var(--text-muted);">No negative factors recorded.</li>';
    }

    if (unkList) {
      const unk = data.unknownFactors || [];
      unkList.innerHTML = unk.length > 0 
        ? unk.map(f => `<li>${escapeHtml(f)}</li>`).join('') 
        : '<li style="color:var(--text-muted);">All primary dimensions observed.</li>';
    }
  } catch (err) {
    console.error('Error loading score details:', err);
  }
}

async function loadDrawerRecommendationData(leadId) {
  const urgencyBadge = document.getElementById('drawer-rec-urgency-badge');
  const actionBadge = document.getElementById('drawer-rec-action-badge');
  const channelBadge = document.getElementById('drawer-rec-channel-badge');
  const headlineEl = document.getElementById('drawer-rec-headline');
  const reasoningEl = document.getElementById('drawer-rec-reasoning');
  const targetEl = document.getElementById('drawer-rec-contact-target');
  const multiLocBox = document.getElementById('drawer-rec-multilocation-box');
  const multiLocText = document.getElementById('drawer-rec-multilocation-text');
  const verifiedList = document.getElementById('drawer-rec-verified-facts');
  const inferredList = document.getElementById('drawer-rec-inferred-facts');
  const unknownList = document.getElementById('drawer-rec-unknown-facts');
  const reviewStatusEl = document.getElementById('drawer-rec-review-status');

  if (headlineEl) headlineEl.innerText = 'Evaluating recommendation...';
  if (reasoningEl) reasoningEl.innerText = 'Analyzing lead signals and scoring inputs...';
  if (verifiedList) verifiedList.innerHTML = '<li>Loading verified evidence...</li>';
  if (inferredList) inferredList.innerHTML = '<li>Loading inferred signals...</li>';
  if (unknownList) unknownList.innerHTML = '<li>Loading unconfirmed attributes...</li>';

  try {
    const res = await fetch(`/api/intelligence/recommendations/${leadId}`);
    if (!res.ok) return;
    const data = await res.json();
    const rec = data.recommendation;
    if (!rec) return;

    if (actionBadge) {
      actionBadge.innerText = rec.action_type || 'RESEARCH_GAPS';
      if (rec.action_type === 'DIRECT_OUTREACH') {
        actionBadge.style.background = 'rgba(16,185,129,0.2)';
        actionBadge.style.color = '#34d399';
      } else if (rec.action_type === 'CONTACT_DECISION_MAKER') {
        actionBadge.style.background = 'rgba(56,189,248,0.2)';
        actionBadge.style.color = '#38bdf8';
      } else if (rec.action_type === 'RESEARCH_GAPS') {
        actionBadge.style.background = 'rgba(245,158,11,0.2)';
        actionBadge.style.color = '#fbbf24';
      } else {
        actionBadge.style.background = 'rgba(148,163,184,0.2)';
        actionBadge.style.color = '#cbd5e1';
      }
    }

    if (urgencyBadge) {
      urgencyBadge.innerText = rec.urgency || 'STANDARD';
      if (rec.urgency === 'IMMEDIATE' || rec.urgency === 'HIGH') {
        urgencyBadge.style.background = 'rgba(239,68,68,0.2)';
        urgencyBadge.style.color = '#f87171';
      } else if (rec.urgency === 'STANDARD') {
        urgencyBadge.style.background = 'rgba(245,158,11,0.2)';
        urgencyBadge.style.color = '#fbbf24';
      } else {
        urgencyBadge.style.background = 'rgba(100,116,139,0.2)';
        urgencyBadge.style.color = '#94a3b8';
      }
    }

    if (channelBadge) {
      channelBadge.innerText = rec.recommended_channel || 'WHATSAPP';
      if (rec.recommended_channel === 'WHATSAPP') {
        channelBadge.style.background = 'rgba(16,185,129,0.2)';
        channelBadge.style.color = '#34d399';
      } else if (rec.recommended_channel === 'EMAIL') {
        channelBadge.style.background = 'rgba(6,182,212,0.2)';
        channelBadge.style.color = '#22d3ee';
      } else if (rec.recommended_channel === 'PHONE') {
        channelBadge.style.background = 'rgba(245,158,11,0.2)';
        channelBadge.style.color = '#fbbf24';
      } else {
        channelBadge.style.background = 'rgba(148,163,184,0.2)';
        channelBadge.style.color = '#94a3b8';
      }
    }

    if (headlineEl) headlineEl.innerText = rec.headline || 'Sales Action Recommendation';
    if (reasoningEl) reasoningEl.innerText = rec.reasoning_summary || 'Evidence-based sales next-step proposal.';
    
    if (targetEl) {
      const handle = rec.target_contact_handle || 'Direct Channel Unavailable';
      const name = rec.target_contact_name ? ` (${rec.target_contact_name})` : '';
      targetEl.innerText = `🎯 Target Handle: ${handle}${name}`;
    }

    if (multiLocBox && multiLocText) {
      if (rec.multiLocationContext) {
        multiLocBox.style.display = 'block';
        multiLocText.innerText = `${rec.multiLocationContext.guidance} (Entity: ${rec.multiLocationContext.entityName || 'Multi-Location Group'})`;
      } else {
        multiLocBox.style.display = 'none';
      }
    }

    // Facts
    const facts = rec.facts || {};
    if (verifiedList) {
      const v = facts.verified || [];
      verifiedList.innerHTML = v.length > 0
        ? v.map(f => `<li>${escapeHtml(f)}</li>`).join('')
        : '<li style="color:var(--text-muted);">No verified DOM evidence crawled yet.</li>';
    }
    if (inferredList) {
      const inf = facts.inferred || [];
      inferredList.innerHTML = inf.length > 0
        ? inf.map(f => `<li>${escapeHtml(f)}</li>`).join('')
        : '<li style="color:var(--text-muted);">No operational signals inferred.</li>';
    }
    if (unknownList) {
      const u = facts.unknown || [];
      unknownList.innerHTML = u.length > 0
        ? u.map(f => `<li>${escapeHtml(f)}</li>`).join('')
        : '<li style="color:var(--text-muted);">All core attributes verified.</li>';
    }

    if (reviewStatusEl) {
      const status = rec.review_status || 'PENDING';
      reviewStatusEl.innerText = status;
      if (status === 'ACCEPTED') {
        reviewStatusEl.style.background = 'rgba(16,185,129,0.2)';
        reviewStatusEl.style.color = '#34d399';
      } else if (status === 'DISMISSED' || status === 'REJECTED') {
        reviewStatusEl.style.background = 'rgba(239,68,68,0.2)';
        reviewStatusEl.style.color = '#f87171';
      } else {
        reviewStatusEl.style.background = 'rgba(245,158,11,0.2)';
        reviewStatusEl.style.color = '#fbbf24';
      }
    }
  } catch (err) {
    console.error('Error loading recommendation:', err);
  }
}

window.handleReviewRecommendation = async function(status) {
  if (!window.currentDrawerLeadId) return;
  try {
    const res = await fetch(`/api/intelligence/recommendations/${window.currentDrawerLeadId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, notes: `Marked ${status} by representative in UI` })
    });
    if (res.ok) {
      showToast(`Recommendation ${status.toLowerCase()} successfully!`, 'success');
      loadDrawerRecommendationData(window.currentDrawerLeadId);
    } else {
      showToast('Failed to update recommendation review status.', 'error');
    }
  } catch (err) {
    showToast('Network error updating review status.', 'error');
  }
};

window.handleRefreshRecommendation = async function() {
  if (!window.currentDrawerLeadId) return;
  try {
    showToast('Recalculating recommendation...', 'info');
    const res = await fetch(`/api/intelligence/recommendations/${window.currentDrawerLeadId}/refresh`, {
      method: 'POST'
    });
    if (res.ok) {
      showToast('Recommendation refreshed!', 'success');
      loadDrawerRecommendationData(window.currentDrawerLeadId);
    } else {
      showToast('Failed to recalculate recommendation.', 'error');
    }
  } catch (err) {
    showToast('Network error recalculating recommendation.', 'error');
  }
};

window.closeLeadDrawer = function() {
  document.getElementById('lead-drawer-overlay')?.classList.add('hidden');
};

window.openVisitingCardModal = function() {
  document.getElementById('visiting-card-modal')?.classList.remove('hidden');
};

window.closeVisitingCardModal = function() {
  document.getElementById('visiting-card-modal')?.classList.add('hidden');
};

window.copyDrawerPitch = function() {
  if (!currentDrawerLead) return;
  const pitch = currentDrawerLead.notes || '';
  if (!pitch) {
    showToast('No pitch to copy.', 'warning');
    return;
  }
  copyText(pitch, 'Personalized Pitch');
};

window.copyAiSuggestedReply = function() {
  if (!currentDrawerLead) return;
  const draft = currentDrawerLead.aiSuggestedReply || '';
  if (!draft) {
    showToast('No AI suggested reply to copy.', 'warning');
    return;
  }
  copyText(draft, 'OpenAI Suggested Reply');
};

window.copyText = function(text, label) {
  if (!text || text.includes('No phone') || text.includes('No email') || text.includes('No website')) {
    showToast(`No ${label || 'text'} to copy.`, 'warning');
    return;
  }
  navigator.clipboard.writeText(text).then(() => {
    showToast(`📋 ${label || 'Text'} copied to clipboard!`, 'success');
  }).catch(() => {
    showToast('Copy failed.', 'error');
  });
};

window.handleDrawerStatusChange = function(newStatus) {
  if (!currentDrawerLead) return;
  updateLeadStatus(currentDrawerLead.id, newStatus);
};


function handleSelectAllLeads(e) {
  document.querySelectorAll('.lead-checkbox').forEach(cb => cb.checked = e.target.checked);
  updateSelectedLeadCount();
}

function updateSelectedLeadCount() {
  const selected = Array.from(document.querySelectorAll('.lead-checkbox:checked')).map(cb => cb.getAttribute('data-id'));
  state.selectedLeads = selected;
  const badge = document.getElementById('selected-count');
  if (badge) badge.innerText = `${selected.length} lead${selected.length === 1 ? '' : 's'} selected`;
  const bar = document.querySelector('.bulk-operations-bar');
  if (bar) bar.classList.toggle('visible', selected.length > 0);
}

async function handleClearLeads() {
  if (!confirm('Clear ALL leads? This cannot be undone.')) return;
  try {
    await fetch('/api/leads/clear', { method: 'POST' });
    showToast('All leads cleared.', 'success');
    loadLeads();
    loadSegments();
  } catch (err) {
    showToast('Error clearing leads.', 'error');
  }
}

// CRM always shows ALL leads regardless of the leads-feed filter
async function loadCRM() {
  try {
    const res = await fetch('/api/leads?search=&segment=all&qualityScore=all&leadStatus=all&hasPhone=');
    if (!res.ok) return;
    const allLeads = await res.json();
    renderCRM(allLeads);
    updateStatCounters(allLeads);
  } catch (err) {
    console.error('CRM load error:', err);
  }
}

function renderCRM(leads) {
  leads = leads || state.leads || [];
  const stages = {
    new:        leads.filter(l => !l.leadStatus || l.leadStatus === 'New'),
    contacted:  leads.filter(l => l.leadStatus === 'Contacted'),
    interested: leads.filter(l => l.leadStatus === 'Interested'),
    closed:     leads.filter(l => l.leadStatus === 'Closed')
  };

  setText('count-pipeline-new',        stages.new.length);
  setText('count-pipeline-contacted',  stages.contacted.length);
  setText('count-pipeline-interested', stages.interested.length);
  setText('count-pipeline-closed',     stages.closed.length);

  renderKanbanCol('kanban-list-new',        stages.new,        'Contacted');
  renderKanbanCol('kanban-list-contacted',  stages.contacted,  'Interested');
  renderKanbanCol('kanban-list-interested', stages.interested, 'Closed');
  renderKanbanCol('kanban-list-closed',     stages.closed,     null);
}

function renderKanbanCol(elementId, leadList, nextStage) {
  const container = document.getElementById(elementId);
  if (!container) return;
  if (!leadList.length) {
    container.innerHTML = '<div style="font-size:11px;color:var(--text-muted);text-align:center;padding:16px;">Empty stage</div>';
    return;
  }
  container.innerHTML = leadList.slice(0, 20).map(l => `
    <div class="kanban-card">
      <strong>${escapeHtml(l.businessName)}</strong>
      <div style="font-size:10px;color:var(--text-secondary);margin-top:2px;">${escapeHtml(l.segment || 'General')}</div>
      ${l.phone ? `<div style="font-size:11px;color:var(--color-emerald);margin-top:2px;">📞 ${escapeHtml(l.phone)}</div>` : ''}
      ${l.email ? `<div style="font-size:10px;color:var(--color-cyan);">✉️ ${escapeHtml(l.email)}</div>` : ''}
      ${nextStage ? `<button class="btn btn-secondary btn-sm" style="margin-top:6px;font-size:10px;padding:3px 8px;" onclick="updateLeadStatus('${l.id}','${nextStage}')">→ ${nextStage}</button>` : '<span style="font-size:10px;color:var(--color-emerald);">✅ Won!</span>'}
    </div>
  `).join('');
}

// ==========================================================================
// BULK OUTREACH OPERATIONS WITH PREFLIGHT SAFETY GATE
// ==========================================================================
let currentBulkChannel = null;
let currentPreflightResult = null;

async function triggerBulkWhatsApp() {
  if (!state.selectedLeads.length) { showToast('Select at least one lead.', 'info'); return; }
  if (state.waLastStatus && state.waLastStatus !== 'Connected' && state.waLastStatus !== 'READY') {
    showToast('📱 Please scan QR code to link WhatsApp before bulk dispatch.', 'warning');
    openWaQuickModal();
    return;
  }
  await openBulkPreflight('whatsapp', state.selectedLeads);
}

async function triggerBulkTelegram() {
  if (!state.selectedLeads.length) { showToast('Select at least one lead.', 'info'); return; }
  await openBulkPreflight('telegram', state.selectedLeads);
}

async function triggerBulkEmail() {
  if (!state.selectedLeads.length) { showToast('Select at least one lead.', 'info'); return; }
  await openBulkPreflight('email', state.selectedLeads);
}

async function openBulkPreflight(channel, leadIds) {
  currentBulkChannel = channel;
  const channelBadge = document.getElementById('preflight-channel-badge');
  if (channelBadge) channelBadge.innerText = channel.toUpperCase();

  showToast(`🛡️ Preflight safety check for ${leadIds.length} leads...`, 'info');

  try {
    const res = await fetch('/api/outreach/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadIds, channel })
    });
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || 'Preflight verification failed.', 'error');
      return;
    }
    const data = await res.json();
    currentPreflightResult = data;

    // Populate modal counters
    setText('preflight-total-count', data.totalChecked || leadIds.length);
    setText('preflight-eligible-count', data.eligibleCount || (data.eligibleLeadIds ? data.eligibleLeadIds.length : 0));
    setText('preflight-blocked-count', data.blockedCount || (data.blockedLeadIds ? data.blockedLeadIds.length : 0));

    // Get channel quota left from compliance stats
    let quotaLeft = '—';
    try {
      const statsRes = await fetch('/api/compliance/stats');
      const statsData = await statsRes.json();
      quotaLeft = statsData?.channels?.[channel]?.remainingToday ?? '—';
    } catch (_) {}
    setText('preflight-quota-left', quotaLeft);

    // Populate blocked list breakdown
    const blockedListEl = document.getElementById('preflight-blocked-list');
    if (blockedListEl) {
      if (data.blockedLeads && data.blockedLeads.length) {
        blockedListEl.innerHTML = data.blockedLeads.map(b => {
          const leadObj = state.leads?.find(l => l.id === b.leadId);
          const name = leadObj?.businessName || b.leadId;
          return `
            <div class="preflight-blocked-item">
              <div>
                <strong>${escapeHtml(name)}</strong>
                <span style="color:var(--text-sec);font-size:11px;margin-left:6px;">${escapeHtml(b.contactIdentifier || '')}</span>
              </div>
              <div>
                <span class="badge-safety badge-safety-blocked">${escapeHtml(b.reasonCode || 'BLOCKED')}</span>
              </div>
            </div>
          `;
        }).join('');
      } else {
        blockedListEl.innerHTML = `<div style="font-size:12px;color:var(--color-emerald);padding:6px 0;">✅ All selected leads are safe & eligible for outreach. Zero safety blocks.</div>`;
      }
    }

    const proceedBtn = document.getElementById('btn-preflight-proceed');
    if (proceedBtn) {
      const eligibleCount = data.eligibleCount || 0;
      proceedBtn.innerText = `Proceed with ${eligibleCount} Eligible Leads Only`;
      proceedBtn.disabled = eligibleCount === 0;
      proceedBtn.style.opacity = eligibleCount === 0 ? '0.5' : '1';
    }

    document.getElementById('bulk-preflight-modal')?.classList.remove('hidden');

  } catch (err) {
    showToast('Failed to run preflight check: ' + err.message, 'error');
  }
}

window.closeBulkPreflightModal = function() {
  document.getElementById('bulk-preflight-modal')?.classList.add('hidden');
  currentPreflightResult = null;
  currentBulkChannel = null;
};

window.executeVerifiedBulkSend = async function() {
  if (!currentPreflightResult || !currentBulkChannel) return;
  const eligibleIds = currentPreflightResult.eligibleLeadIds || [];
  const channel = currentBulkChannel;
  closeBulkPreflightModal();

  if (!eligibleIds.length) {
    showToast('No eligible leads to dispatch.', 'info');
    return;
  }

  let endpoint = '';
  let title = '';
  if (channel === 'whatsapp') {
    endpoint = '/api/outreach/whatsapp';
    title = 'WhatsApp Bulk Outreach';
  } else if (channel === 'telegram') {
    endpoint = '/api/outreach/telegram';
    title = 'Telegram Direct Outreach';
  } else if (channel === 'email') {
    endpoint = '/api/outreach/email-draft';
    title = 'Creating Gmail Drafts';
  }

  showProgressOverlay(title, `Dispatching to ${eligibleIds.length} verified safe leads...`);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadIds: eligibleIds })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`⚡ ${title} launched for ${eligibleIds.length} eligible leads!`, 'success');
      loadLeads();
      loadComplianceStats();
    } else {
      showToast(data.error || 'Failed to dispatch.', 'error');
    }
  } catch (err) {
    showToast('Error executing bulk send: ' + err.message, 'error');
  }
};

// ==============================================================================
// COMPLIANCE & SAFETY CONTROL CENTER
// ==============================================================================
window.switchComplianceSubtab = function(tab) {
  document.getElementById('tab-btn-suppressions')?.classList.toggle('active', tab === 'suppressions');
  document.getElementById('tab-btn-audit')?.classList.toggle('active', tab === 'audit');
  document.getElementById('c-view-suppressions')?.classList.toggle('hidden', tab !== 'suppressions');
  document.getElementById('c-view-audit')?.classList.toggle('hidden', tab !== 'audit');

  if (tab === 'suppressions') loadSuppressions();
  if (tab === 'audit') loadAuditLogs();
};

window.loadComplianceData = async function() {
  await Promise.all([
    loadComplianceStats(),
    loadSuppressions(),
    loadAuditLogs()
  ]);
};

async function loadComplianceStats() {
  try {
    const res = await fetch('/api/compliance/stats');
    if (!res.ok) return;
    const data = await res.json();

    // Last audit timestamp
    const lastTimeEl = document.getElementById('compliance-last-time');
    if (lastTimeEl) {
      if (data.lastCheckTimestamp) {
        lastTimeEl.innerText = new Date(data.lastCheckTimestamp).toLocaleTimeString();
      } else {
        lastTimeEl.innerText = 'Active (Ready)';
      }
    }
    const lastDecEl = document.getElementById('compliance-last-decision');
    if (lastDecEl) {
      lastDecEl.innerText = `Verdict: ${data.lastCheckDecision || 'STANDBY'}`;
    }

    // WhatsApp channel
    const wa = data.channels?.whatsapp;
    if (wa) {
      setText('wa-quota-text', `${wa.usedToday} / ${wa.dailyLimit}`);
      setText('wa-remaining-badge', `${wa.remainingToday} Remaining`);
      const pct = Math.min(100, Math.round((wa.usedToday / (wa.dailyLimit || 1)) * 100));
      setText('wa-percent-text', `${pct}%`);
      const bar = document.getElementById('wa-quota-bar');
      if (bar) bar.style.width = `${pct}%`;

      const badge = document.getElementById('wa-channel-badge');
      if (badge) {
        badge.className = `c-channel-badge ${wa.allowed ? 'badge-allowed' : 'badge-blocked'}`;
        badge.innerText = wa.allowed ? '🟢 ALLOWED' : '🔴 QUOTA REACHED';
      }

      setText('wa-suppressed-count', wa.suppressedCount);
      setText('wa-attempts-today', wa.attemptsToday);
      setText('wa-success-today', wa.successToday);
      setText('wa-blocked-today', wa.blockedToday);
      setText('wa-cooldown-hours', `${wa.cooldownHours}h`);
      setText('wa-max-attempts', wa.maxAttempts);
    }

    // Telegram channel
    const tg = data.channels?.telegram;
    if (tg) {
      setText('tg-quota-text', `${tg.usedToday} / ${tg.dailyLimit}`);
      setText('tg-remaining-badge', `${tg.remainingToday} Remaining`);
      const pct = Math.min(100, Math.round((tg.usedToday / (tg.dailyLimit || 1)) * 100));
      setText('tg-percent-text', `${pct}%`);
      const bar = document.getElementById('tg-quota-bar');
      if (bar) bar.style.width = `${pct}%`;

      const badge = document.getElementById('tg-channel-badge');
      if (badge) {
        badge.className = `c-channel-badge ${tg.allowed ? 'badge-allowed' : 'badge-blocked'}`;
        badge.innerText = tg.allowed ? '🟢 ALLOWED' : '🔴 QUOTA REACHED';
      }

      setText('tg-suppressed-count', tg.suppressedCount);
      setText('tg-attempts-today', tg.attemptsToday);
      setText('tg-success-today', tg.successToday);
      setText('tg-blocked-today', tg.blockedToday);
      setText('tg-cooldown-hours', `${tg.cooldownHours}h`);
      setText('tg-max-attempts', tg.maxAttempts);
    }

    // Email channel
    const email = data.channels?.email;
    if (email) {
      setText('email-quota-text', `${email.usedToday} / ${email.dailyLimit}`);
      setText('email-remaining-badge', `${email.remainingToday} Remaining`);
      const pct = Math.min(100, Math.round((email.usedToday / (email.dailyLimit || 1)) * 100));
      setText('email-percent-text', `${pct}%`);
      const bar = document.getElementById('email-quota-bar');
      if (bar) bar.style.width = `${pct}%`;

      const badge = document.getElementById('email-channel-badge');
      if (badge) {
        badge.className = `c-channel-badge ${email.allowed ? 'badge-allowed' : 'badge-blocked'}`;
        badge.innerText = email.allowed ? '🟢 ALLOWED' : '🔴 QUOTA REACHED';
      }

      setText('email-suppressed-count', email.suppressedCount);
      setText('email-attempts-today', email.attemptsToday);
      setText('email-success-today', email.successToday);
      setText('email-blocked-today', email.blockedToday);
      setText('email-cooldown-hours', `${email.cooldownHours}h`);
      setText('email-max-attempts', email.maxAttempts);
    }

  } catch (err) {
    console.error('Error loading compliance stats:', err);
  }
}

async function loadSuppressions() {
  try {
    const search = document.getElementById('suppression-search')?.value || '';
    const channel = document.getElementById('suppression-channel-filter')?.value || 'ALL';
    const contactType = document.getElementById('suppression-type-filter')?.value || 'ALL';

    const params = new URLSearchParams({ search, channel, contactType });
    const res = await fetch(`/api/compliance/suppressions?${params}`);
    if (!res.ok) return;
    const data = await res.json();

    setText('count-suppressions-badge', data.total || 0);

    const tbody = document.getElementById('suppressions-tbody');
    if (!tbody) return;

    if (!data.suppressions || !data.suppressions.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-sec);">No suppression records found. Clean safety state.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.suppressions.map(s => {
      const scopeBadge = s.channel === 'ALL'
        ? '<span class="badge-safety badge-safety-blocked">GLOBAL</span>'
        : `<span class="c-pill-tag">${escapeHtml(s.channel.toUpperCase())}</span>`;

      const isExpired = s.expires_at && new Date(s.expires_at) < new Date();
      const statusBadge = isExpired
        ? '<span style="color:var(--text-mut);">EXPIRED</span>'
        : '<span style="color:#34d399;font-weight:700;">ACTIVE</span>';

      return `
        <tr>
          <td><strong style="font-family:var(--font-mono);font-size:12.5px;">${escapeHtml(s.normalized_contact)}</strong></td>
          <td>${escapeHtml(s.lead_business_name || '—')}</td>
          <td>${scopeBadge}</td>
          <td><span style="font-weight:600;color:#f87171;">${escapeHtml(s.reason)}</span></td>
          <td><span style="font-size:11px;color:var(--text-sec);">${escapeHtml(s.source || 'MANUAL')}</span></td>
          <td style="font-size:11px;color:var(--text-sec);">${new Date(s.created_at).toLocaleDateString()}</td>
          <td style="font-size:11px;">${statusBadge}</td>
          <td class="actions-col">
            <button class="btn btn-danger-outline btn-sm" style="padding:2px 8px;font-size:11px;" onclick="handleRemoveSuppression('${escapeHtml(s.normalized_contact)}', '${escapeHtml(s.channel)}', '${escapeHtml(s.id)}')">
              Remove
            </button>
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error('Error loading suppressions:', err);
  }
}

window.handleRemoveSuppression = async function(contact, channel, id) {
  if (!confirm(`Are you sure you want to remove suppression for ${contact} (${channel})? Automated outreach will be re-allowed.`)) return;

  try {
    const res = await fetch('/api/compliance/suppressions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact, channel, id })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ Removed suppression for ${contact}`, 'success');
      loadSuppressions();
      loadComplianceStats();
      loadLeads();
    } else {
      showToast(data.error || 'Failed to remove suppression.', 'error');
    }
  } catch (err) {
    showToast('Network error removing suppression: ' + err.message, 'error');
  }
};

window.openAddSuppressionModal = function() {
  document.getElementById('add-suppression-modal')?.classList.remove('hidden');
};

window.closeAddSuppressionModal = function() {
  document.getElementById('add-suppression-modal')?.classList.add('hidden');
};

window.handleAddSuppression = async function(e) {
  if (e) e.preventDefault();
  const contact = document.getElementById('suppress-contact')?.value?.trim();
  const contactType = document.getElementById('suppress-type')?.value;
  const channel = document.getElementById('suppress-channel')?.value;
  const reason = document.getElementById('suppress-reason')?.value;
  const notes = document.getElementById('suppress-notes')?.value?.trim();

  if (!contact) {
    showToast('Please enter a phone number or email.', 'info');
    return;
  }

  try {
    const res = await fetch('/api/compliance/suppressions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact, contactType, channel, reason, notes })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`🚫 Suppressed ${contact} successfully.`, 'success');
      closeAddSuppressionModal();
      loadSuppressions();
      loadComplianceStats();
      loadLeads();
    } else {
      showToast(data.error || 'Failed to add suppression.', 'error');
    }
  } catch (err) {
    showToast('Network error adding suppression: ' + err.message, 'error');
  }
};

async function loadAuditLogs() {
  try {
    const channel = document.getElementById('audit-channel-filter')?.value || 'ALL';
    const decision = document.getElementById('audit-decision-filter')?.value || 'ALL';
    const eventType = document.getElementById('audit-event-filter')?.value || 'ALL';

    const params = new URLSearchParams({ channel, decision, eventType });
    const res = await fetch(`/api/compliance/audit-logs?${params}`);
    if (!res.ok) return;
    const data = await res.json();

    setText('count-audit-badge', data.total || 0);

    const tbody = document.getElementById('audit-logs-tbody');
    if (!tbody) return;

    if (!data.logs || !data.logs.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-sec);">No compliance audit records found.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.logs.map(log => {
      let decClass = 'decision-allowed';
      if (log.decision === 'BLOCKED') decClass = 'decision-blocked';
      if (log.decision === 'REMOVED') decClass = 'decision-removed';

      const decBadge = `<span class="badge-audit-decision ${decClass}">${escapeHtml(log.decision)}</span>`;
      const timeStr = new Date(log.created_at).toLocaleString();

      return `
        <tr>
          <td style="font-size:11px;font-family:var(--font-mono);color:var(--text-sec);white-space:nowrap;">${timeStr}</td>
          <td>
            <strong>${escapeHtml(log.lead_business_name || log.contact_identifier || 'System')}</strong>
            ${log.contact_identifier && log.lead_business_name ? `<div style="font-size:10.5px;color:var(--text-sec);">${escapeHtml(log.contact_identifier)}</div>` : ''}
          </td>
          <td><span class="c-pill-tag">${escapeHtml((log.channel || 'ALL').toUpperCase())}</span></td>
          <td style="font-size:11.5px;font-weight:600;">${escapeHtml(log.event_type)}</td>
          <td>${decBadge}</td>
          <td style="font-size:11.5px;">
            <div style="font-weight:600;color:var(--text);">${escapeHtml(log.reason || '—')}</div>
          </td>
          <td style="font-size:11px;color:var(--text-sec);">${escapeHtml(log.metadata?.addedBy || log.metadata?.removedBy || 'Safety Gate')}</td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error('Error loading compliance audit logs:', err);
  }
}

async function triggerBulkDelete() {
  if (!state.selectedLeads.length) { showToast('Select leads first.', 'info'); return; }
  if (!confirm(`Delete ${state.selectedLeads.length} selected leads?`)) return;
  for (const id of state.selectedLeads) await fetch(`/api/leads/${id}`, { method: 'DELETE' });
  showToast('Selected leads deleted.', 'success');
  loadLeads();
  loadSegments();
}

async function syncToGoogleSheets() {
  showToast('Syncing to Google Sheets...', 'info');
  try {
    const res = await fetch('/api/leads/sync-sheets', { method: 'POST' });
    const data = await res.json();
    if (data.success && data.url) {
      showToast('Synced to Google Sheets!', 'success');
      window.open(data.url, '_blank');
    } else {
      showToast(`Sync failed: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast('Sheets sync error.', 'error');
  }
}

// ==========================================================================
// SETTINGS & OAUTH
// ==========================================================================
async function loadSettings() {
  try {
    const token = state.sessionToken || localStorage.getItem('leadflow_session_token');
    const res = await fetch('/api/settings', {
      headers: {
        'x-session-token': token || ''
      }
    });
    if (!res.ok) {
      if (res.status === 403) {
        console.warn('Settings access restricted to Administrator.');
      }
      return;
    }
    const settings = await res.json();
    state.settings = settings;

    setVal('setting-openai-key', settings.openaiApiKey);
    setVal('setting-lead-provider', settings.leadSourceProvider || 'auto');
    setVal('setting-places-key', settings.placesApiKey);
    setVal('setting-google-id', settings.googleClientId);
    setVal('setting-google-secret', settings.googleClientSecret);
    setVal('setting-email-subject', settings.emailSubjectTemplate);
    setVal('setting-email-body', settings.emailBodyTemplate);
    setVal('setting-wa-template', settings.waMessageTemplate);
    setVal('setting-wa-no-website-template', settings.waNoWebsiteTemplate);
    setVal('setting-sms-template', settings.smsMessageTemplate);
    setVal('setting-telegram-template', settings.telegramMessageTemplate);
    setVal('setting-telegram-bot-token', settings.telegramBotToken);
    setVal('setting-telegram-chat-ids', settings.telegramChatIds);

    updateGoogleStatusUI(settings.isGoogleConnected);
  } catch (err) {
    console.error('Error loading settings:', err);
  }
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val || '';
}

async function handleSaveSettings() {
  const token = state.sessionToken || localStorage.getItem('leadflow_session_token');
  const settings = {
    openaiApiKey: document.getElementById('setting-openai-key')?.value.trim(),
    leadSourceProvider: document.getElementById('setting-lead-provider')?.value || 'auto',
    placesApiKey: document.getElementById('setting-places-key')?.value.trim(),
    googleClientId: document.getElementById('setting-google-id')?.value.trim(),
    googleClientSecret: document.getElementById('setting-google-secret')?.value.trim(),
    emailSubjectTemplate: document.getElementById('setting-email-subject')?.value,
    emailBodyTemplate: document.getElementById('setting-email-body')?.value,
    waMessageTemplate: document.getElementById('setting-wa-template')?.value,
    waNoWebsiteTemplate: document.getElementById('setting-wa-no-website-template')?.value,
    smsMessageTemplate: document.getElementById('setting-sms-template')?.value,
    telegramMessageTemplate: document.getElementById('setting-telegram-template')?.value,
    telegramBotToken: document.getElementById('setting-telegram-bot-token')?.value.trim(),
    telegramChatIds: document.getElementById('setting-telegram-chat-ids')?.value.trim(),
  };
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-session-token': token || ''
      },
      body: JSON.stringify(settings)
    });
    if (res.ok) { 
      showToast('Settings saved!', 'success'); 
      loadSettings(); 
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(data.message || 'Save failed: Admin access required.', 'error');
    }
  } catch (err) { 
    showToast('Save failed: ' + err.message, 'error'); 
  }
}

window.handleTestTelegramBot = async function() {
  const token = document.getElementById('setting-telegram-bot-token')?.value.trim();
  const chatIds = document.getElementById('setting-telegram-chat-ids')?.value.trim();
  const statusEl = document.getElementById('telegram-test-status');
  const btn = document.getElementById('btn-test-telegram');

  if (!token) {
    showToast('Please enter your Telegram Bot Token from @BotFather.', 'warning');
    return;
  }
  if (!chatIds) {
    showToast('Please enter at least one numeric Chat ID.', 'warning');
    return;
  }

  // Auto-save settings first
  handleSaveSettings();

  if (statusEl) {
    statusEl.innerHTML = '<span style="color:#38bdf8;">⏳ Verifying bot and dispatching test message...</span>';
  }
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/telegram/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken: token, chatIds: chatIds })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ Verified! Test message sent to ${data.results?.length || 1} chat(s)!`, 'success');
      if (statusEl) {
        statusEl.innerHTML = `<span style="color:#34d399;font-weight:700;">✅ Connected to @${data.bot?.username || 'Bot'}! Messages delivered.</span>`;
      }
    } else {
      showToast(data.error || 'Failed to send test message.', 'error');
      if (statusEl) {
        statusEl.innerHTML = `<span style="color:#f87171;">❌ ${data.error || 'Connection failed'}</span>`;
      }
    }
  } catch (err) {
    showToast('Error testing Telegram bot.', 'error');
    if (statusEl) statusEl.innerHTML = `<span style="color:#f87171;">❌ Network error</span>`;
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.handlePushLeadToTelegram = async function() {
  if (!currentDrawerLead) return;
  showToast(`Pushing ${currentDrawerLead.businessName} to Telegram...`, 'info');
  try {
    const res = await fetch(`/api/telegram/push-lead/${currentDrawerLead.id}`, {
      method: 'POST'
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('📲 Lead dossier sent to Telegram successfully!', 'success');
    } else {
      showToast(data.error || 'Failed to push to Telegram. Check your Bot Token in Settings.', 'error');
    }
  } catch (err) {
    showToast('Error pushing lead to Telegram.', 'error');
  }
};

function updateGoogleStatusUI(connected) {
  const el = document.getElementById('google-status');
  const btnConnect = document.getElementById('btn-oauth-connect');
  const btnDisconnect = document.getElementById('btn-oauth-disconnect');
  if (connected) {
    if (el) { el.className = 'status-indicator connected'; el.querySelector('.indicator-text').innerText = 'Google Connected'; }
    btnConnect?.classList.add('hidden');
    btnDisconnect?.classList.remove('hidden');
  } else {
    if (el) { el.className = 'status-indicator disconnected'; el.querySelector('.indicator-text').innerText = 'Google Disconnected'; }
    btnConnect?.classList.remove('hidden');
    btnDisconnect?.classList.add('hidden');
  }
}

async function handleOAuthConnect() {
  try {
    const res = await fetch('/api/oauth/connect');
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else showToast(data.error || 'Failed to get OAuth URL.', 'error');
  } catch (err) { showToast('Error initializing Google auth.', 'error'); }
}

async function handleOAuthDisconnect() {
  try {
    const res = await fetch('/api/oauth/disconnect', { method: 'POST' });
    if (res.ok) { showToast('Google account disconnected.', 'success'); loadSettings(); }
  } catch (err) { showToast('Error disconnecting.', 'error'); }
}

// ==========================================================================
// WHATSAPP STATUS + AUTO POLL
// ==========================================================================
async function loadWaStatus() {
  try {
    const res = await fetch('/api/whatsapp/status');
    if (!res.ok) return;
    const data = await res.json();

    const badge = document.getElementById('wa-status-badge');
    const text  = document.getElementById('wa-status-text');
    const qrContainer = document.getElementById('wa-qr-container');
    const qrImg  = document.getElementById('wa-qr-img');
    const loader = document.getElementById('wa-loader');
    const btnDisc = document.getElementById('btn-wa-disconnect');
    const btnRefresh = document.getElementById('btn-wa-refresh-qr');
    const testBox = document.getElementById('wa-test-box');

    // Dashboard Header Pill & Modal elements
    const dashWaPill = document.getElementById('dash-wa-pill');
    const quickModal = document.getElementById('wa-quick-modal');
    const modalImg = document.getElementById('wa-modal-qr-img');
    const modalLoader = document.getElementById('wa-modal-loader');
    const modalStatus = document.getElementById('wa-modal-status-text');

    const newStatus = data.status;
    const statusChanged = newStatus !== state.waLastStatus;
    state.waLastStatus = newStatus;

    if (newStatus === 'Connected' || newStatus === 'READY') {
      if (badge) badge.className = 'status-indicator connected';
      const userPhone = data.info?.phone || '';
      const userName = data.info?.pushname || '';
      const accountLabel = userPhone ? ` (+${userPhone}${userName ? ' · ' + userName : ''})` : '';
      if (text) text.innerText = `✅ Connected & Active${accountLabel}`;
      if (qrContainer) qrContainer.style.display = 'none';
      if (loader) loader.style.display = 'none';
      btnDisc?.classList.remove('hidden');
      btnRefresh?.classList.add('hidden');
      testBox?.classList.remove('hidden');

      // Update Dashboard Pill
      if (dashWaPill) {
        dashWaPill.className = 'status-pill whatsapp-pill active-pill';
        dashWaPill.innerHTML = `💬 WhatsApp: Connected${userPhone ? ' (+' + userPhone + ')' : ''}`;
        dashWaPill.title = 'WhatsApp session is active and linked.';
        dashWaPill.onclick = null;
        dashWaPill.style.cursor = 'default';
      }

      // Auto close modal if it was open during scanning
      if (quickModal && !quickModal.classList.contains('hidden')) {
        closeWaQuickModal();
        showToast('✅ WhatsApp linked and active!', 'success');
      }

      // Recheck every 15s to maintain active state
      scheduleWaPoll(15000);
    } else if ((newStatus === 'QR_Ready' || newStatus === 'QR_READY') && data.qr) {
      if (badge) badge.className = 'status-indicator disconnected';
      if (text) text.innerText = '📱 Scan QR Code to Connect';
      if (qrImg) qrImg.src = data.qr;
      if (qrContainer) qrContainer.style.display = 'flex';
      if (loader) loader.style.display = 'none';
      btnDisc?.classList.add('hidden');
      btnRefresh?.classList.remove('hidden');
      testBox?.classList.add('hidden');

      // Update Dashboard Pill with alert and click-to-scan
      if (dashWaPill) {
        dashWaPill.className = 'status-pill whatsapp-pill warning-pill';
        dashWaPill.innerHTML = '📱 WhatsApp: Scan QR (Click to Scan)';
        dashWaPill.title = 'WhatsApp needs QR scan. Click to view QR code.';
        dashWaPill.onclick = openWaQuickModal;
        dashWaPill.style.cursor = 'pointer';
      }

      // Update Quick Modal if active
      if (modalImg) {
        modalImg.src = data.qr;
        modalImg.style.display = 'block';
      }
      if (modalLoader) modalLoader.style.display = 'none';
      if (modalStatus) {
        modalStatus.innerHTML = '📱 <b>QR Ready!</b> Scan with WhatsApp to connect.';
        modalStatus.style.color = '#fbbf24';
      }

      // Fast 2s poll while scanning so badge turns green immediately on scan!
      scheduleWaPoll(2000);
    } else if (newStatus === 'Connecting' || newStatus === 'LOADING') {
      if (badge) badge.className = 'status-indicator disconnected';
      if (text) text.innerText = '⏳ Initializing...';
      if (qrContainer) qrContainer.style.display = 'none';
      if (loader) loader.style.display = 'flex';
      btnDisc?.classList.add('hidden');
      btnRefresh?.classList.remove('hidden');
      testBox?.classList.add('hidden');

      if (dashWaPill) {
        dashWaPill.className = 'status-pill whatsapp-pill';
        dashWaPill.innerHTML = '⏳ WhatsApp: Connecting...';
        dashWaPill.title = 'Starting Chrome & WhatsApp engine...';
        dashWaPill.onclick = openWaQuickModal;
        dashWaPill.style.cursor = 'pointer';
      }

      if (modalImg) modalImg.style.display = 'none';
      if (modalLoader) modalLoader.style.display = 'flex';
      if (modalStatus) {
        modalStatus.innerHTML = '⏳ Starting WhatsApp engine...';
        modalStatus.style.color = '#38bdf8';
      }

      scheduleWaPoll(3000);
    } else {
      if (badge) badge.className = 'status-indicator disconnected';
      if (text) text.innerText = '❌ Disconnected';
      if (qrContainer) qrContainer.style.display = 'none';
      if (loader) loader.style.display = 'none';
      btnDisc?.classList.add('hidden');
      btnRefresh?.classList.remove('hidden');
      testBox?.classList.add('hidden');

      if (dashWaPill) {
        dashWaPill.className = 'status-pill whatsapp-pill danger-pill';
        dashWaPill.innerHTML = '❌ WhatsApp: Disconnected (Click to Link)';
        dashWaPill.title = 'WhatsApp is disconnected. Click to open QR code.';
        dashWaPill.onclick = openWaQuickModal;
        dashWaPill.style.cursor = 'pointer';
      }

      if (modalImg) modalImg.style.display = 'none';
      if (modalLoader) modalLoader.style.display = 'flex';
      if (modalStatus) {
        modalStatus.innerHTML = '❌ Disconnected. Initializing session...';
        modalStatus.style.color = '#f87171';
      }

      if (statusChanged) {
        state.waPollInterval = 5000;
      } else {
        state.waPollInterval = Math.min(state.waPollInterval * 1.4, 30000);
      }
      scheduleWaPoll(state.waPollInterval);
    }
  } catch (err) {
    state.waPollInterval = Math.min((state.waPollInterval || 8000) * 2, 60000);
    scheduleWaPoll(state.waPollInterval);
  }
}

// ── WhatsApp Quick Modal Functions ──
window.openWaQuickModal = function() {
  const modal = document.getElementById('wa-quick-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  loadWaStatus(); // immediately load current status/QR
};

window.closeWaQuickModal = function() {
  const modal = document.getElementById('wa-quick-modal');
  if (modal) modal.classList.add('hidden');
};

window.refreshWaQuickModal = async function() {
  const modalLoader = document.getElementById('wa-modal-loader');
  const modalImg = document.getElementById('wa-modal-qr-img');
  const modalStatus = document.getElementById('wa-modal-status-text');
  if (modalImg) modalImg.style.display = 'none';
  if (modalLoader) modalLoader.style.display = 'flex';
  if (modalStatus) modalStatus.innerText = '🔄 Generating fresh QR code...';
  try {
    await fetch('/api/whatsapp/disconnect', { method: 'POST' });
    showToast('Refreshing WhatsApp session...', 'info');
    scheduleWaPoll(1500);
  } catch (err) {
    showToast('Failed to refresh session', 'error');
  }
};

/** Schedule the next WA poll, replacing any existing timer */
function scheduleWaPoll(delayMs) {
  stopWaStatusPolling();
  state.waStatusPoller = setTimeout(() => {
    state.waStatusPoller = null;
    loadWaStatus();
  }, delayMs);
}

function startWaStatusPolling() {
  state.waPollInterval = 5000;
  scheduleWaPoll(5000);
}

function stopWaStatusPolling() {
  if (state.waStatusPoller) {
    clearTimeout(state.waStatusPoller);
    clearInterval(state.waStatusPoller);
    state.waStatusPoller = null;
  }
}

async function handleWaDisconnect() {
  try {
    await fetch('/api/whatsapp/disconnect', { method: 'POST' });
    showToast('WhatsApp disconnected.', 'success');
    startWaStatusPolling();
    loadWaStatus();
  } catch (err) { showToast('Error disconnecting WhatsApp.', 'error'); }
}

async function handleRefreshWaQR() {
  const btn = document.getElementById('btn-wa-refresh-qr');
  const qrContainer = document.getElementById('wa-qr-container');
  const loader = document.getElementById('wa-loader');
  const loaderText = document.getElementById('wa-loader-text');

  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ Resetting Session...';
  }
  if (qrContainer) qrContainer.style.display = 'none';
  if (loader) {
    loader.style.display = 'flex';
    if (loaderText) loaderText.innerText = 'Generating fresh QR code...';
  }

  try {
    await fetch('/api/whatsapp/disconnect', { method: 'POST' });
    showToast('Refreshing WhatsApp session...', 'info');
    startWaStatusPolling();
    setTimeout(() => {
      loadWaStatus();
      if (btn) {
        btn.disabled = false;
        btn.innerText = '🔄 Refresh QR Code';
      }
    }, 2000);
  } catch (err) {
    showToast('Failed to refresh QR code: ' + err.message, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerText = '🔄 Refresh QR Code';
    }
  }
}

async function handleSendTestWaMessage() {
  const phoneInput = document.getElementById('wa-test-phone');
  const btn = document.getElementById('btn-wa-test');
  const phone = phoneInput ? phoneInput.value.trim() : '';

  if (!phone) {
    showToast('Please enter a test phone number with country code (e.g. +918791338600)', 'warning');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ Sending...';
  }

  try {
    const res = await fetch('/api/whatsapp/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to dispatch test WhatsApp');

    showToast(`✅ Live test WhatsApp sent to ${data.phone}! Check your phone.`, 'success');
    loadWhatsappLogs();
  } catch (err) {
    showToast(`Test failed: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '📲 Send Test';
    }
  }
}

async function loadWhatsappLogs() {
  try {
    const res = await fetch('/api/whatsapp/logs');
    if (!res.ok) return;
    const logs = await res.json();
    const tbody = document.getElementById('wa-logs-list');
    if (!tbody) return;
    if (!logs || !logs.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);padding:20px;">No dispatch history yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = logs.map(l => `
      <tr>
        <td><strong>${escapeHtml(l.businessName || l.leadName || 'N/A')}</strong></td>
        <td>${escapeHtml(l.phone || 'N/A')}</td>
        <td><span class="badge ${l.status === 'Sent' ? 'badge-success' : 'badge-danger'}">${l.status}</span></td>
        <td style="font-size:11px;">${new Date(l.timestamp).toLocaleString()}</td>
        <td style="font-size:11px;color:var(--text-secondary);">${escapeHtml(l.error || l.errorMessage || '—')}</td>
      </tr>
    `).join('');
  } catch (err) { console.error('WA logs error:', err); }
}

// ==========================================================================
// REAL-TIME EVENT STREAM
// ==========================================================================
function setupEventSource() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = new EventSource('/api/logs/stream');
  state.eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'log') appendConsoleLog(data.message, data.level);
      else if (data.type === 'location-update') loadLocations();
      else if (data.type === 'leads-updated') { loadLeads(); loadSegments(); loadCRM(); }
      else if (data.type === 'whatsapp-updated') { loadWaLogs(); loadLeads(); }
      else if (data.type === 'settings-updated') loadSettings();
      else if (data.type === 'progress') updateProgressModal(data);
      else if (data.type === 'wa-status') loadWaStatus();
      else if (data.type === 'email-job-progress' || data.type === 'whatsapp-job-progress' || data.type === 'tg-job-progress') updateProgressModal({ current: data.current, total: data.total, message: data.message });
      else if (data.type === 'email-job-end' || data.type === 'whatsapp-job-end' || data.type === 'tg-job-end') {
        appendConsoleLog(data.message, 'success');
        document.getElementById('btn-close-progress')?.classList.remove('hidden');
        loadLeads();
        loadWaLogs();
      } else if (data.type === 'lead-replied') {
        showToast(`💬 Reply from ${data.businessName || 'Lead'}! AI draft ready.`, 'success');
        loadLeads();
        if (state.activeTab === 'crm') loadCRM();
        if (currentDrawerLead && currentDrawerLead.id === data.leadId) {
          const updated = {
            ...currentDrawerLead,
            lastReplyText: data.replyText,
            lastReplyAt: new Date().toISOString(),
            aiSuggestedReply: data.aiDraft,
            leadStatus: 'Interested'
          };
          openLeadDrawer(updated);
        }
      }
    } catch (e) { console.error('SSE parse error:', e); }
  };
  state.eventSource.onerror = () => {
    setTimeout(setupEventSource, 5000); // reconnect after 5 sec
  };
}

function appendConsoleLog(message, level = 'info') {
  const el = document.getElementById('log-console');
  if (!el) return;
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.innerText = `[${new Date().toLocaleTimeString()}] ${message}`;
  el.appendChild(entry);
  el.scrollTop = el.scrollHeight;
}

function showProgressOverlay(title, subtitle) {
  setText('progress-title', title);
  setText('progress-subtitle', subtitle);
  document.getElementById('progress-bar').style.width = '0%';
  setText('progress-text', 'Starting...');
  setText('progress-percentage', '0%');
  document.getElementById('progress-console').innerHTML = '';
  document.getElementById('btn-close-progress')?.classList.add('hidden');
  document.getElementById('progress-overlay')?.classList.remove('hidden');
}

function updateProgressModal(data) {
  if (data.current !== undefined && data.total !== undefined) {
    const pct = Math.round((data.current / data.total) * 100);
    document.getElementById('progress-bar').style.width = `${pct}%`;
    setText('progress-text', `${data.current} / ${data.total} processed`);
    setText('progress-percentage', `${pct}%`);
    if (data.current >= data.total) document.getElementById('btn-close-progress')?.classList.remove('hidden');
  }
  if (data.message) {
    const consoleEl = document.getElementById('progress-console');
    if (consoleEl) {
      const item = document.createElement('div');
      item.innerText = data.message;
      item.style.fontSize = '11px';
      item.style.color = 'var(--text-secondary)';
      consoleEl.appendChild(item);
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }
  }
}

// ==========================================================================
// TOAST NOTIFICATIONS
// ==========================================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  toast.innerHTML = `<span>${icons[type] || ''}</span> ${message}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(12px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 350);
  }, 3500);
}

// ==========================================================================
// UTILITIES
// ==========================================================================
function getStatusBadgeClass(status) {
  if (status === 'Done') return 'badge-success';
  if (status === 'Scraping') return 'badge-warning';
  if (status === 'Error') return 'badge-danger';
  return 'badge-secondary';
}

function debounce(func, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => func(...args), wait); };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatShortUrl(url) {
  if (!url) return '';
  let clean = String(url).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  if (clean.length > 30) {
    clean = clean.substring(0, 27) + '...';
  }
  return clean;
}

// ==========================================================================
// MEDIA & SOCIAL DIRECTORY
// ==========================================================================
async function loadMediaDirectory() {
  try {
    const query = document.getElementById('media-search-input')?.value || '';
    const segment = document.getElementById('media-filter-segment')?.value || 'all';
    const hasAllThree = document.getElementById('media-filter-3only')?.checked ? 'true' : '';

    const params = new URLSearchParams({ search: query, segment, hasAllThree });
    const res = await fetch(`/api/leads?${params}`);
    if (!res.ok) return;
    const leads = await res.json();

    renderMediaGrid(leads);
  } catch (err) {
    console.error('Error loading media directory:', err);
  }
}

function renderMediaGrid(leads) {
  const container = document.getElementById('media-directory-grid');
  if (!container) return;

  if (!leads || !leads.length) {
    container.innerHTML = `
      <div class="empty-state-card" style="grid-column: 1 / -1;">
        <div style="font-size:40px;margin-bottom:12px;">📱</div>
        <h3>No Media Profiles Found</h3>
        <p>Try unchecking <strong>3/3 Complete Contact Profiles Only</strong> or generate leads in the Segments Hub.</p>
      </div>`;
    return;
  }

  container.innerHTML = leads.map(lead => {
    const is3of3 = lead.hasAll3 || (lead.phone && lead.website && (lead.facebook || lead.instagram || lead.linkedin || lead.twitter));
    const waLink = lead.phone ? `https://wa.me/${lead.phone.replace(/\D/g, '')}?text=${encodeURIComponent('Hi ' + (lead.businessName || '') + ', I found your profile in ' + (lead.location || 'Mumbai') + ' and wanted to connect.')}` : '';

    return `
    <div class="media-card ${is3of3 ? 'complete-3of3' : ''}">
      <div class="media-card-top">
        <div style="flex:1;min-width:0;">
          <div class="media-card-title">${escapeHtml(lead.businessName)}</div>
          <div style="display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap;">
            ${is3of3 ? '<span class="badge-3of3">🏆 3/3 Complete Profile</span>' : ''}
            <span class="segment-tag-pill">${escapeHtml(lead.segment || 'General')}</span>
            ${getQualityBadgeHTML(lead.qualityScore)}
          </div>
        </div>
      </div>

      <div class="media-links-container">
        <div class="media-link-item">
          <label>📞 Mobile Phone / WA</label>
          <span style="font-weight:700;color:var(--color-emerald);font-size:12px;">${escapeHtml(lead.phone || 'Not available')}</span>
        </div>
        <div class="media-link-item">
          <label>🌐 Website Domain</label>
          ${lead.website ? `<a href="${lead.website}" target="_blank" style="color:var(--color-cyan);font-weight:600;font-size:12px;">${escapeHtml(lead.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>` : '<span style="color:var(--text-muted);">—</span>'}
        </div>
        <div class="media-link-item">
          <label>📍 Location / City</label>
          <span style="color:var(--text-secondary);">${escapeHtml(lead.location || lead.address || '—')}</span>
        </div>
      </div>

      <!-- Social & Action Button Grid -->
      <div class="social-btn-grid">
        ${lead.phone ? `<a href="tel:${lead.phone}" class="social-btn phone">📞 Call</a>` : '<span class="social-btn disabled">📞 No Phone</span>'}
        ${lead.phone ? `<a href="${waLink}" target="_blank" class="social-btn phone" style="color:#34d399;border-color:rgba(52,211,153,0.3);">💬 WhatsApp</a>` : '<span class="social-btn disabled">💬 No WA</span>'}
        ${lead.website ? `<a href="${lead.website}" target="_blank" class="social-btn website">🌐 Website</a>` : '<span class="social-btn disabled">🌐 No Web</span>'}
        ${lead.facebook ? `<a href="${lead.facebook}" target="_blank" class="social-btn facebook">📘 Facebook</a>` : '<span class="social-btn disabled">📘 No FB</span>'}
        ${lead.instagram ? `<a href="${lead.instagram}" target="_blank" class="social-btn instagram">📷 Instagram</a>` : '<span class="social-btn disabled">📷 No IG</span>'}
        ${lead.linkedin ? `<a href="${lead.linkedin}" target="_blank" class="social-btn linkedin">💼 LinkedIn</a>` : '<span class="social-btn disabled">💼 No LI</span>'}
        ${lead.twitter ? `<a href="${lead.twitter}" target="_blank" class="social-btn twitter">🐦 Twitter</a>` : '<span class="social-btn disabled">🐦 No X</span>'}
        ${lead.email ? `<a href="mailto:${lead.email}" class="social-btn" style="color:#818cf8;">✉️ Email</a>` : '<span class="social-btn disabled">✉️ No Email</span>'}
      </div>
    </div>`;
  }).join('');
}

