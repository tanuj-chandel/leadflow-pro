// ==========================================================================
// APP STATE
// ==========================================================================
const state = {
  activeSection: 'dashboard',
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
// INITIALIZATION & EVENT LISTENERS
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();

  loadSettings();
  loadLocations();
  loadSegments();
  loadLeads();
  loadWhatsappLogs();
  loadWaStatus();
  startWaStatusPolling();

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
  document.getElementById('leads-search-input').addEventListener('input', debounce(loadLeads, 300));
  ['filter-segment', 'filter-quality', 'filter-lead-status', 'filter-has-phone', 'filter-has-all-three'].forEach(id => {
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

  pillsContainer.innerHTML = [
    { name: 'All', value: 'all', icon: '🌐' },
    ...segments.map(s => ({ name: s.name, value: s.name, icon: s.icon || '💼', count: s.totalLeads }))
  ].map(s => {
    const active = (dropdown?.value || 'all') === s.value ? 'active' : '';
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
    const hasPhone = document.getElementById('filter-has-phone')?.checked ? 'true' : '';
    const hasAllThree = document.getElementById('filter-has-all-three')?.checked ? 'true' : '';

    const params = new URLSearchParams({ search: query, segment, qualityScore, leadStatus, hasPhone, hasAllThree });
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
  const phone = leads.filter(l => l.phone && l.phone.trim().length >= 10).length;
  const waSent = leads.filter(l => l.whatsappStatus === 'Sent').length;
  const emailLeads = leads.filter(l => l.email && l.email.trim()).length;

  setText('stat-total-leads', total);
  setText('stat-hot-leads', hot);
  setText('stat-leads-phone', phone);
  setText('stat-wa-sent', waSent);
  setText('stat-email-leads', emailLeads);
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
    const is3of3 = lead.hasAll3 || (lead.phone && lead.website && (lead.facebook || lead.instagram || lead.linkedin || lead.twitter));
    const waLink = lead.phone ? `https://wa.me/${lead.phone.replace(/\D/g, '')}?text=${encodeURIComponent('Hi ' + (lead.businessName || '') + ', I came across your business and wanted to connect briefly.')}` : '';
    const socials = [
      lead.facebook ? `<a href="${lead.facebook}" target="_blank" class="social-chip" title="Facebook">📘</a>` : '',
      lead.instagram ? `<a href="${lead.instagram}" target="_blank" class="social-chip" title="Instagram">📷</a>` : '',
      lead.linkedin ? `<a href="${lead.linkedin}" target="_blank" class="social-chip" title="LinkedIn">💼</a>` : '',
      lead.twitter ? `<a href="${lead.twitter}" target="_blank" class="social-chip" title="Twitter/X">🐦</a>` : ''
    ].filter(Boolean).join('');

    return `
    <div class="lead-card-mobile" id="card-${lead.id}">
      <div class="lead-card-top">
        <div style="flex:1;min-width:0;">
          <div class="lead-name">${escapeHtml(lead.businessName || 'Business Lead')}</div>
          <div class="lead-meta" style="margin-top:4px;gap:6px;">
            ${is3of3 ? '<span class="badge-3of3">🏆 3/3 Complete</span>' : ''}
            ${getQualityBadgeHTML(lead.qualityScore)}
            <span class="segment-tag-pill">${escapeHtml(lead.segment || 'General')}</span>
            ${lead.rating ? `<span style="font-size:11px;">⭐ ${lead.rating}</span>` : ''}
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

      ${socials ? `<div class="socials-row">${socials}</div>` : ''}

      <div class="lead-actions-row">
        ${lead.phone ? `
          <a href="tel:${lead.phone}" class="action-btn-touch btn-secondary">📞 Call</a>
          <a href="${waLink}" target="_blank" class="action-btn-touch btn-accent">💬 WhatsApp</a>
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
    const waLink = lead.phone ? `https://wa.me/${lead.phone.replace(/\D/g, '')}` : '';
    return `
    <tr>
      <td class="checkbox-col">
        <label class="custom-checkbox">
          <input type="checkbox" class="lead-checkbox" data-id="${lead.id}">
          <span class="checkmark"></span>
        </label>
      </td>
      <td>
        <strong style="font-size:13px;">${escapeHtml(lead.businessName)}</strong>
        <div style="font-size:11px;margin-top:2px;">
          <span class="segment-tag-pill">${escapeHtml(lead.segment || 'General')}</span>
        </div>
        ${lead.address ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${escapeHtml(lead.address.substring(0, 60))}</div>` : ''}
      </td>
      <td>
        ${lead.phone ? `<a href="${waLink}" target="_blank" style="color:var(--color-emerald);font-weight:600;text-decoration:none;font-size:12px;font-family:var(--font-mono);">💬 ${escapeHtml(lead.phone)}</a>` : '<span style="color:var(--text-muted);">—</span>'}
      </td>
      <td>
        ${lead.email ? `<a href="mailto:${lead.email}" style="color:var(--color-cyan);text-decoration:none;font-size:12px;">${escapeHtml(lead.email)}</a>` : '<span style="color:var(--text-muted);">—</span>'}
      </td>
      <td>
        ${lead.website ? `<a href="${lead.website}" target="_blank" class="table-url-link" title="${escapeHtml(lead.website)}">🌐 ${escapeHtml(formatShortUrl(lead.website))}</a>` : '<span style="color:var(--text-muted);">—</span>'}
        <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;">
          ${lead.facebook ? `<a href="${lead.facebook}" target="_blank" class="social-chip" title="Facebook">📘</a>` : ''}
          ${lead.instagram ? `<a href="${lead.instagram}" target="_blank" class="social-chip" title="Instagram">📷</a>` : ''}
          ${lead.linkedin ? `<a href="${lead.linkedin}" target="_blank" class="social-chip" title="LinkedIn">💼</a>` : ''}
          ${lead.twitter ? `<a href="${lead.twitter}" target="_blank" class="social-chip" title="Twitter/X">🐦</a>` : ''}
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
      <td class="actions-col">
        <button class="btn btn-danger-outline btn-sm" onclick="deleteSingleLead('${lead.id}')">✕</button>
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
// BULK OUTREACH OPERATIONS
// ==========================================================================
async function triggerBulkEmail() {
  if (!state.selectedLeads.length) { showToast('Select at least one lead.', 'info'); return; }
  showProgressOverlay('Creating Gmail Drafts', `Creating drafts for ${state.selectedLeads.length} leads...`);
  try {
    const res = await fetch('/api/outreach/email-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadIds: state.selectedLeads })
    });
    if (res.ok) showToast('Gmail draft job started!', 'success');
    else { const err = await res.json(); showToast(err.error || 'Failed.', 'error'); }
  } catch (e) { showToast('Error triggering email drafts.', 'error'); }
}

async function triggerBulkWhatsApp() {
  if (!state.selectedLeads.length) { showToast('Select at least one lead.', 'info'); return; }
  showProgressOverlay('WhatsApp Bulk Outreach', `Dispatching to ${state.selectedLeads.length} leads...`);
  try {
    const res = await fetch('/api/outreach/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadIds: state.selectedLeads })
    });
    if (res.ok) showToast('WhatsApp dispatch started!', 'success');
    else { const err = await res.json(); showToast(err.error || 'Failed.', 'error'); }
  } catch (e) { showToast('Error triggering WhatsApp.', 'error'); }
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
    const res = await fetch('/api/settings');
    if (!res.ok) return;
    const settings = await res.json();
    state.settings = settings;

    setVal('setting-places-key', settings.placesApiKey);
    setVal('setting-google-id', settings.googleClientId);
    setVal('setting-google-secret', settings.googleClientSecret);
    setVal('setting-email-subject', settings.emailSubjectTemplate);
    setVal('setting-email-body', settings.emailBodyTemplate);
    setVal('setting-wa-template', settings.waMessageTemplate);

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
  const settings = {
    placesApiKey: document.getElementById('setting-places-key')?.value.trim(),
    googleClientId: document.getElementById('setting-google-id')?.value.trim(),
    googleClientSecret: document.getElementById('setting-google-secret')?.value.trim(),
    emailSubjectTemplate: document.getElementById('setting-email-subject')?.value,
    emailBodyTemplate: document.getElementById('setting-email-body')?.value,
    waMessageTemplate: document.getElementById('setting-wa-template')?.value
  };
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    if (res.ok) { showToast('Settings saved!', 'success'); loadSettings(); }
  } catch (err) { showToast('Save failed.', 'error'); }
}

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
    if (!badge) return;

    const newStatus = data.status;
    const statusChanged = newStatus !== state.waLastStatus;
    state.waLastStatus = newStatus;

    if (newStatus === 'Connected' || newStatus === 'READY') {
      badge.className = 'status-indicator connected';
      text.innerText = '✅ Connected & Active';
      if (qrContainer) qrContainer.style.display = 'none';
      if (loader) loader.style.display = 'none';
      btnDisc?.classList.remove('hidden');
      // Stop polling — reconnect check every 30s only
      scheduleWaPoll(30000);
    } else if ((newStatus === 'QR_Ready' || newStatus === 'QR_READY') && data.qr) {
      badge.className = 'status-indicator disconnected';
      text.innerText = '📱 Scan QR Code to Connect';
      if (qrImg) qrImg.src = data.qr;
      if (qrContainer) qrContainer.style.display = 'flex';
      if (loader) loader.style.display = 'none';
      btnDisc?.classList.add('hidden');
      // Poll every 4s while QR is shown (waiting for scan)
      scheduleWaPoll(4000);
    } else if (newStatus === 'Connecting' || newStatus === 'LOADING') {
      badge.className = 'status-indicator disconnected';
      text.innerText = '⏳ Initializing...';
      if (qrContainer) qrContainer.style.display = 'none';
      if (loader) loader.style.display = 'flex';
      btnDisc?.classList.add('hidden');
      // Poll every 3s while connecting
      scheduleWaPoll(3000);
    } else {
      // Disconnected — back off exponentially to avoid spam
      badge.className = 'status-indicator disconnected';
      text.innerText = '❌ Disconnected';
      if (qrContainer) qrContainer.style.display = 'none';
      if (loader) loader.style.display = 'none';
      btnDisc?.classList.add('hidden');
      if (statusChanged) {
        state.waPollInterval = 8000; // reset on change
      } else {
        state.waPollInterval = Math.min(state.waPollInterval * 1.5, 60000); // back off up to 60s
      }
      scheduleWaPoll(state.waPollInterval);
    }
  } catch (err) {
    // Network error — back off
    state.waPollInterval = Math.min((state.waPollInterval || 8000) * 2, 60000);
    scheduleWaPoll(state.waPollInterval);
  }
}

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
      else if (data.type === 'leads-updated') { loadLeads(); loadSegments(); }
      else if (data.type === 'progress') updateProgressModal(data);
      else if (data.type === 'wa-status') loadWaStatus();
      else if (data.type === 'email-job-progress' || data.type === 'whatsapp-job-progress') updateProgressModal({ current: data.current, total: data.total, message: data.message });
      else if (data.type === 'email-job-end' || data.type === 'whatsapp-job-end') {
        appendConsoleLog(data.message, 'success');
        document.getElementById('btn-close-progress')?.classList.remove('hidden');
        loadLeads();
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

