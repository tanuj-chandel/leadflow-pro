// ==========================================================================
// APP STATE
// ==========================================================================
const state = {
  activeSection: 'dashboard',
  locations: [],
  leads: [],
  selectedLeads: [],
  settings: {},
  eventSource: null,
  activeLocationId: null
};

// ==========================================================================
// INITIALIZATION & EVENT LISTENERS
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  // Navigation setup
  setupNavigation();

  // Load initial data
  loadSettings();
  loadLocations();
  loadLeads();
  loadWhatsappLogs();
  loadWaStatus();

  // Setup EventSource for real-time logs and progress updates
  setupEventSource();

  // Form handlers
  document.getElementById('add-location-form').addEventListener('submit', handleAddLocation);
  document.getElementById('btn-save-settings').addEventListener('click', handleSaveSettings);

  // Connection handlers
  document.getElementById('btn-oauth-connect').addEventListener('click', handleOAuthConnect);
  document.getElementById('btn-oauth-disconnect').addEventListener('click', handleOAuthDisconnect);

  // Search and filter handlers
  document.getElementById('leads-search-input').addEventListener('input', debounce(loadLeads, 300));
  document.getElementById('filter-has-phone').addEventListener('change', loadLeads);
  document.getElementById('filter-email-status').addEventListener('change', loadLeads);
  document.getElementById('filter-wa-status').addEventListener('change', loadLeads);

  // Bulk Operations
  document.getElementById('select-all-leads').addEventListener('change', handleSelectAllLeads);
  document.getElementById('btn-bulk-email').addEventListener('click', triggerBulkEmail);
  document.getElementById('btn-bulk-wa').addEventListener('click', triggerBulkWhatsApp);
  document.getElementById('btn-bulk-delete').addEventListener('click', triggerBulkDelete);

  // Other utility actions
  document.getElementById('btn-sync-sheets').addEventListener('click', syncToGoogleSheets);
  document.getElementById('btn-clear-leads').addEventListener('click', handleClearLeads);
  document.getElementById('btn-close-progress').addEventListener('click', () => {
    document.getElementById('progress-overlay').classList.add('hidden');
    loadLeads(); // reload table as status might have changed
  });

  // WhatsApp QR disconnect
  document.getElementById('btn-wa-disconnect').addEventListener('click', handleWaDisconnect);

  // Scraper run modal options
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
        showToast('Scraper started in background.', 'success');
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
// NAVIGATION HANDLERS
// ==========================================================================
function setupNavigation() {
  const menuButtons = document.querySelectorAll('.menu-item');
  const sections = document.querySelectorAll('.content-section');

  menuButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      
      // Update sidebar state
      menuButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Update main panels
      sections.forEach(sec => {
        if (sec.id === target) {
          sec.classList.add('active');
        } else {
          sec.classList.remove('active');
        }
      });

      state.activeSection = target;
      
      // Reload relevant data when switching views
      if (target === 'dashboard') {
        loadLocations();
      } else if (target === 'leads') {
        loadLeads();
      } else if (target === 'logs') {
        loadWhatsappLogs();
      }
    });
  });
}

// ==========================================================================
// REAL-TIME EVENT STREAM (SSE)
// ==========================================================================
function setupEventSource() {
  if (state.eventSource) {
    state.eventSource.close();
  }

  state.eventSource = new EventSource('/api/logs/stream');

  state.eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleSSEMessage(data);
    } catch (e) {
      console.error('Error parsing SSE data:', e);
    }
  };

  state.eventSource.onerror = (err) => {
    console.error('SSE connection lost. Reconnecting...');
    setTimeout(setupEventSource, 5000);
  };
}

function handleSSEMessage(data) {
  const logConsole = document.getElementById('log-console');
  const progressConsole = document.getElementById('progress-console');

  // Helper to add timestamp
  const timeStr = new Date().toLocaleTimeString();

  switch (data.type) {
    case 'log':
      appendLog(logConsole, `[${timeStr}] ${data.message}`, 'log-info');
      break;

    case 'progress':
      // General scraper progress updates
      appendLog(logConsole, `[${timeStr}] ${data.message}`, 'log-progress');
      break;

    case 'location-update':
      loadLocations(); // refresh locations list
      if (data.status === 'Done') {
        showToast('Scraping completed successfully!', 'success');
        loadLeads(); // refresh leads stats
      } else if (data.status === 'Error') {
        showToast(`Scraping error: ${data.error}`, 'error');
        appendLog(logConsole, `[${timeStr}] ERROR: ${data.error}`, 'log-error');
      }
      break;

    // Email job triggers
    case 'email-job-start':
      showProgressOverlay('Creating Gmail Drafts', 'Creating drafts in Gmail inbox...');
      updateProgressBar(0, data.total, '0 / ' + data.total + ' processed');
      appendLog(progressConsole, `Starting draft creation for ${data.total} leads...`, 'log-info');
      break;

    case 'email-job-progress':
      updateProgressBar(data.current, data.total, `${data.current} / ${data.total} drafts processed`);
      appendLog(progressConsole, data.message, 'log-progress');
      break;

    case 'email-job-end':
      updateProgressBar(1, 1, `Process completed`);
      appendLog(progressConsole, `Finished! Created: ${data.successCount}, Failed: ${data.failCount}`, 'log-success');
      document.getElementById('btn-close-progress').classList.remove('hidden');
      showToast(data.message, 'success');
      loadLeads();
      break;

    // WhatsApp job triggers
    case 'whatsapp-job-start':
      showProgressOverlay('Sending WhatsApp Messages', 'Sending API requests to Meta Cloud...');
      updateProgressBar(0, data.total, '0 / ' + data.total + ' processed');
      appendLog(progressConsole, `Initiating outreach send for ${data.total} leads...`, 'log-info');
      break;

    case 'whatsapp-job-progress':
      updateProgressBar(data.current, data.total, `${data.current} / ${data.total} sent`);
      appendLog(progressConsole, data.message, 'log-progress');
      break;

    case 'whatsapp-job-end':
      updateProgressBar(1, 1, `Outreach completed`);
      appendLog(progressConsole, `Finished! Sent: ${data.successCount}, Failed: ${data.failCount}`, 'log-success');
      document.getElementById('btn-close-progress').classList.remove('hidden');
      showToast(data.message, 'success');
      loadLeads();
      break;

    case 'wa-status':
      updateWaUI(data);
      break;
  }
}

function appendLog(element, text, className) {
  if (!element) return;
  const entry = document.createElement('div');
  entry.className = `log-entry ${className}`;
  entry.innerText = text;
  element.appendChild(entry);
  element.scrollTop = element.scrollHeight;
}

// ==========================================================================
// DATA RETRIEVAL (GET)
// ==========================================================================
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    state.settings = settings;

    // Populate inputs
    document.getElementById('setting-places-key').value = settings.placesApiKey || '';
    document.getElementById('setting-google-id').value = settings.googleClientId || '';
    document.getElementById('setting-google-secret').value = settings.googleClientSecret || '';
    document.getElementById('setting-email-subject').value = settings.emailSubjectTemplate || '';
    document.getElementById('setting-email-body').value = settings.emailBodyTemplate || '';
    document.getElementById('setting-wa-template').value = settings.waMessageTemplate || '';

    // Update connection status
    updateGoogleStatus(settings.isGoogleConnected);
  } catch (err) {
    showToast('Failed to load settings.', 'error');
  }
}

async function loadLocations() {
  try {
    const res = await fetch('/api/locations');
    const data = await res.json();
    state.locations = data;

    const list = document.getElementById('locations-list');
    list.innerHTML = '';

    if (data.length === 0) {
      list.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No target searches added yet.</td></tr>`;
      return;
    }

    data.forEach(loc => {
      let badgeClass = 'badge-pending';
      if (loc.status === 'Scraping') badgeClass = 'badge-running';
      else if (loc.status === 'Done') badgeClass = 'badge-success';
      else if (loc.status === 'Error') badgeClass = 'badge-error';

      const row = document.createElement('tr');
      row.innerHTML = `
        <td style="font-weight: 600; color: #fff;">${escapeHTML(loc.term)}</td>
        <td>${escapeHTML(loc.location)}</td>
        <td>${loc.maxLeads || 20}</td>
        <td>
          <span class="badge ${badgeClass}" title="${loc.error ? escapeHTML(loc.error) : ''}">
            ${loc.status}
          </span>
        </td>
        <td class="actions-col">
          <button class="btn btn-sm btn-primary btn-run-scraper" data-id="${loc.id}" ${loc.status === 'Scraping' ? 'disabled' : ''}>
            Run Scraper
          </button>
          <button class="btn btn-sm btn-danger-outline btn-delete-loc" data-id="${loc.id}">
            Delete
          </button>
        </td>
      `;

      row.querySelector('.btn-run-scraper').addEventListener('click', () => {
        state.activeLocationId = loc.id;
        document.getElementById('run-options-overlay').classList.remove('hidden');
      });
      row.querySelector('.btn-delete-loc').addEventListener('click', () => deleteLocation(loc.id));
      list.appendChild(row);
    });
  } catch (err) {
    showToast('Failed to load search queries.', 'error');
  }
}

async function loadLeads() {
  try {
    const search = document.getElementById('leads-search-input').value;
    const hasPhone = document.getElementById('filter-has-phone').checked;
    const emailStatus = document.getElementById('filter-email-status').value;
    const waStatus = document.getElementById('filter-wa-status').value;

    let queryUrl = `/api/leads?`;
    if (search) queryUrl += `search=${encodeURIComponent(search)}&`;
    if (hasPhone) queryUrl += `hasPhone=true&`;
    if (emailStatus) queryUrl += `emailStatus=${encodeURIComponent(emailStatus)}&`;
    if (waStatus) queryUrl += `whatsappStatus=${encodeURIComponent(waStatus)}&`;

    const res = await fetch(queryUrl);
    const leads = await res.json();
    state.leads = leads;

    // Reset selection state
    state.selectedLeads = [];
    document.getElementById('select-all-leads').checked = false;
    updateBulkBar();

    // Update Counter Stats
    updateCounters(leads);

    const list = document.getElementById('leads-list');
    list.innerHTML = '';

    if (leads.length === 0) {
      list.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 30px;">No leads matching filters.</td></tr>`;
      return;
    }

    leads.forEach(lead => {
      const isSelected = state.selectedLeads.includes(lead.id);
      
      let emailBadgeClass = 'badge-pending';
      if (lead.emailStatus === 'Draft Created') emailBadgeClass = 'badge-success';
      else if (lead.emailStatus && lead.emailStatus.startsWith('Error')) emailBadgeClass = 'badge-error';

      let waBadgeClass = 'badge-pending';
      if (lead.whatsappStatus === 'Sent') waBadgeClass = 'badge-success';
      else if (lead.whatsappStatus && lead.whatsappStatus.startsWith('Error')) waBadgeClass = 'badge-error';

      // Social Links Badges
      let socialHTML = '';
      if (lead.facebook) socialHTML += `<a href="${lead.facebook}" target="_blank" class="social-badge" title="Facebook">FB</a>`;
      if (lead.instagram) socialHTML += `<a href="${lead.instagram}" target="_blank" class="social-badge" title="Instagram">IG</a>`;
      if (lead.linkedin) socialHTML += `<a href="${lead.linkedin}" target="_blank" class="social-badge" title="LinkedIn">LN</a>`;
      if (lead.twitter) socialHTML += `<a href="${lead.twitter}" target="_blank" class="social-badge" title="Twitter/X">X</a>`;
      if (!socialHTML) socialHTML = '<span style="color: var(--text-muted); font-size:12px;">None</span>';

      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="checkbox-col">
          <label class="custom-checkbox">
            <input type="checkbox" class="lead-checkbox" data-id="${lead.id}" ${isSelected ? 'checked' : ''}>
            <span class="checkmark"></span>
          </label>
        </td>
        <td>
          <div style="font-weight: 600; color: #fff;">${escapeHTML(lead.businessName)}</div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top:2px;">${escapeHTML(lead.searchTerm)} (${escapeHTML(lead.location)})</div>
        </td>
        <td>
          ${lead.phone ? `<a href="tel:${lead.phone}" class="social-badge" style="width:auto; padding: 0 8px;">${escapeHTML(lead.phone)}</a>` : '<span style="color: var(--color-danger); font-size: 12px; font-weight:600;">Missing</span>'}
        </td>
        <td>
          ${lead.email ? `<a href="mailto:${lead.email}" style="color: var(--color-indigo); text-decoration:none;">${escapeHTML(lead.email)}</a>` : '<span style="color: var(--text-muted); font-size:12px;">None</span>'}
        </td>
        <td>
          <div class="social-icon-links">${socialHTML}</div>
        </td>
        <td>
          ${lead.website ? `<a href="${lead.website}" target="_blank" style="color: var(--color-cyan); text-decoration:none; font-size:13px;">Visit site</a>` : '<span style="color: var(--text-muted); font-size:12px;">None</span>'}
        </td>
        <td>
          ${lead.rating ? `<span class="rating-star"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"><path d="M12 .587l3.668 7.431 8.2 1.192-5.933 5.788 1.4 8.168L12 18.896l-7.335 3.854 1.4-8.168L.135 9.21l8.2-1.192L12 .587z"/></svg> ${lead.rating}</span>` : '<span style="color: var(--text-muted); font-size:12px;">-</span>'}
        </td>
        <td>
          <span class="badge ${emailBadgeClass}" title="${lead.emailStatus ? escapeHTML(lead.emailStatus) : ''}">
            ${lead.emailStatus || 'Pending'}
          </span>
        </td>
        <td>
          <span class="badge ${waBadgeClass}" title="${lead.whatsappStatus ? escapeHTML(lead.whatsappStatus) : ''}">
            ${lead.whatsappStatus || 'Pending'}
          </span>
        </td>
        <td class="actions-col">
          <button class="btn btn-sm btn-danger-outline btn-delete-lead" data-id="${lead.id}">
            Delete
          </button>
        </td>
      `;

      row.querySelector('.lead-checkbox').addEventListener('change', handleLeadSelect);
      row.querySelector('.btn-delete-lead').addEventListener('click', () => deleteLead(lead.id));
      list.appendChild(row);
    });

  } catch (err) {
    showToast('Failed to load leads list.', 'error');
  }
}

async function loadWhatsappLogs() {
  try {
    const res = await fetch('/api/whatsapp/logs');
    const logs = await res.json();

    const list = document.getElementById('wa-logs-list');
    list.innerHTML = '';

    if (logs.length === 0) {
      list.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">No WhatsApp messages sent yet.</td></tr>`;
      return;
    }

    logs.forEach(log => {
      const isSuccess = log.status === 'Sent';
      const dateStr = new Date(log.timestamp).toLocaleString();

      const row = document.createElement('tr');
      row.innerHTML = `
        <td style="font-weight:600; color:#fff;">${escapeHTML(log.leadName)}</td>
        <td>${escapeHTML(log.phone || '-')}</td>
        <td>
          <span class="badge ${isSuccess ? 'badge-success' : 'badge-error'}">
            ${log.status}
          </span>
        </td>
        <td>${dateStr}</td>
        <td style="font-size:12px; color: ${isSuccess ? 'var(--text-muted)' : 'var(--color-danger)'}">
          ${log.errorMessage ? escapeHTML(log.errorMessage) : '-'}
        </td>
      `;
      list.appendChild(row);
    });
  } catch (err) {
    showToast('Failed to load WhatsApp outreach logs.', 'error');
  }
}

// ==========================================================
// FORM SUBMISSIONS & ACTIONS (POST/DELETE)
// ==========================================================
async function handleAddLocation(e) {
  e.preventDefault();
  const term = document.getElementById('search-term').value;
  const location = document.getElementById('search-location').value;
  const maxLeads = document.getElementById('max-leads').value;

  try {
    const response = await fetch('/api/locations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term, location, maxLeads })
    });

    if (response.ok) {
      showToast('Search query added!', 'success');
      document.getElementById('add-location-form').reset();
      loadLocations();
    } else {
      const err = await response.json();
      showToast(`Error: ${err.error}`, 'error');
    }
  } catch (err) {
    showToast('Failed to add target query.', 'error');
  }
}

// runScraperJob replaced by run-options-overlay event listener

async function deleteLocation(id) {
  try {
    const res = await fetch(`/api/locations/${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Search query deleted.', 'success');
      loadLocations();
    }
  } catch (e) {
    showToast('Failed to delete query.', 'error');
  }
}

async function deleteLead(id) {
  try {
    const res = await fetch(`/api/leads/${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Lead deleted.', 'success');
      loadLeads();
    }
  } catch (e) {
    showToast('Failed to delete lead.', 'error');
  }
}

async function handleClearLeads() {
  if (!confirm('Are you sure you want to delete ALL leads? This action is irreversible.')) return;
  try {
    const res = await fetch('/api/leads/clear', { method: 'POST' });
    if (res.ok) {
      showToast('All leads cleared.', 'success');
      loadLeads();
    }
  } catch (e) {
    showToast('Failed to clear leads.', 'error');
  }
}

async function handleSaveSettings() {
  const settings = {
    placesApiKey: document.getElementById('setting-places-key').value,
    googleClientId: document.getElementById('setting-google-id').value,
    googleClientSecret: document.getElementById('setting-google-secret').value,
    emailSubjectTemplate: document.getElementById('setting-email-subject').value,
    emailBodyTemplate: document.getElementById('setting-email-body').value,
    waMessageTemplate: document.getElementById('setting-wa-template').value
  };

  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });

    if (response.ok) {
      showToast('Settings saved successfully.', 'success');
      loadSettings();
    } else {
      showToast('Failed to save settings.', 'error');
    }
  } catch (err) {
    showToast('Failed to save settings.', 'error');
  }
}

// ==========================================================
// GOOGLE OAUTH FLOW
// ==========================================================
async function handleOAuthConnect() {
  // First save settings to make sure Client ID / Secret are updated
  await handleSaveSettings();

  try {
    const response = await fetch('/api/oauth/connect');
    const data = await response.json();
    if (data.url) {
      // Redirect to Google authorization flow
      window.location.href = data.url;
    } else if (data.error) {
      showToast(`OAuth Error: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast('Could not initiate Google connection.', 'error');
  }
}

async function handleOAuthDisconnect() {
  try {
    const response = await fetch('/api/oauth/disconnect', { method: 'POST' });
    if (response.ok) {
      showToast('Disconnected from Google account.', 'success');
      loadSettings();
    }
  } catch (err) {
    showToast('Disconnect action failed.', 'error');
  }
}

async function syncToGoogleSheets() {
  showToast('Syncing leads with Google Sheets...', 'info');
  try {
    const response = await fetch('/api/leads/sync-sheets', { method: 'POST' });
    const data = await response.json();
    
    if (response.ok && data.url) {
      showToast('Sync complete!', 'success');
      // Create a persistent floating alert with the Sheet link
      const entry = document.createElement('div');
      entry.className = 'toast toast-success';
      entry.innerHTML = `
        <div>
          <strong>Google Sheet Sync Complete</strong><br>
          <a href="${data.url}" target="_blank" style="color: #fff; text-decoration: underline; font-weight: 600;">Open Google Sheet</a>
        </div>
        <button class="toast-close-btn">&times;</button>
      `;
      entry.querySelector('.toast-close-btn').addEventListener('click', () => entry.remove());
      document.getElementById('toast-container').appendChild(entry);
    } else {
      showToast(`Sync failed: ${data.error || 'Google connection required.'}`, 'error');
    }
  } catch (e) {
    showToast('Sync failed: Network or connection error.', 'error');
  }
}

// ==========================================================
// BULK OPERATIONS & OUTREACH
// ==========================================================
function handleLeadSelect(e) {
  const id = e.target.getAttribute('data-id');
  if (e.target.checked) {
    if (!state.selectedLeads.includes(id)) {
      state.selectedLeads.push(id);
    }
  } else {
    state.selectedLeads = state.selectedLeads.filter(leadId => leadId !== id);
  }
  updateBulkBar();
}

function handleSelectAllLeads(e) {
  const checkboxes = document.querySelectorAll('.lead-checkbox');
  state.selectedLeads = [];
  checkboxes.forEach(cb => {
    cb.checked = e.target.checked;
    const id = cb.getAttribute('data-id');
    if (e.target.checked && id) {
      state.selectedLeads.push(id);
    }
  });
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  const countBadge = document.getElementById('selected-count');
  
  if (state.selectedLeads.length > 0) {
    countBadge.innerText = `${state.selectedLeads.length} leads selected`;
    bar.classList.add('show');
  } else {
    bar.classList.remove('show');
  }
}

async function triggerBulkEmail() {
  if (state.selectedLeads.length === 0) return;
  
  // Verify leads have email
  const leadsToEmail = state.leads.filter(l => state.selectedLeads.includes(l.id));
  const hasEmails = leadsToEmail.some(l => l.email);
  
  if (!hasEmails) {
    showToast('None of the selected leads have an email address.', 'warning');
    return;
  }

  try {
    const response = await fetch('/api/outreach/email-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadIds: state.selectedLeads })
    });

    if (!response.ok) {
      const err = await response.json();
      showToast(`Draft error: ${err.error}`, 'error');
    }
  } catch (e) {
    showToast('Draft action failed.', 'error');
  }
}

async function triggerBulkWhatsApp() {
  if (state.selectedLeads.length === 0) return;

  // Verify leads have mobile numbers
  const leadsToWa = state.leads.filter(l => state.selectedLeads.includes(l.id));
  const hasPhones = leadsToWa.some(l => l.phone);

  if (!hasPhones) {
    showToast('None of the selected leads have mobile numbers.', 'warning');
    return;
  }

  if (!confirm(`Are you sure you want to send WhatsApp Cloud messages to ${leadsToWa.filter(l => l.phone).length} leads?`)) {
    return;
  }

  try {
    const response = await fetch('/api/outreach/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadIds: state.selectedLeads })
    });

    if (!response.ok) {
      const err = await response.json();
      showToast(`WhatsApp error: ${err.error}`, 'error');
    }
  } catch (e) {
    showToast('WhatsApp outreach failed.', 'error');
  }
}

async function triggerBulkDelete() {
  if (state.selectedLeads.length === 0) return;
  if (!confirm(`Are you sure you want to delete the ${state.selectedLeads.length} selected leads?`)) return;

  let successCount = 0;
  for (const id of state.selectedLeads) {
    try {
      const res = await fetch(`/api/leads/${id}`, { method: 'DELETE' });
      if (res.ok) successCount++;
    } catch (e) {
      console.error(e);
    }
  }

  showToast(`Deleted ${successCount} leads.`, 'success');
  loadLeads();
}

// ==========================================================
// PROGRESS MODAL CONTROL
// ==========================================================
function showProgressOverlay(title, subtitle) {
  document.getElementById('progress-title').innerText = title;
  document.getElementById('progress-subtitle').innerText = subtitle;
  document.getElementById('progress-bar').style.width = '0%';
  document.getElementById('progress-text').innerText = 'Starting...';
  document.getElementById('progress-percentage').innerText = '0%';
  document.getElementById('progress-console').innerHTML = '';
  document.getElementById('btn-close-progress').classList.add('hidden');
  document.getElementById('progress-overlay').classList.remove('hidden');
}

function updateProgressBar(current, total, text) {
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  document.getElementById('progress-bar').style.width = `${percent}%`;
  document.getElementById('progress-text').innerText = text;
  document.getElementById('progress-percentage').innerText = `${percent}%`;
}

// ==========================================================
// INTERACTIVE UI UTILITIES
// ==========================================================
function updateGoogleStatus(isConnected) {
  const indicator = document.getElementById('google-status');
  const btnConnect = document.getElementById('btn-oauth-connect');
  const btnDisconnect = document.getElementById('btn-oauth-disconnect');

  if (isConnected) {
    indicator.className = 'status-indicator connected';
    indicator.querySelector('.indicator-text').innerText = 'Google Account Connected';
    btnConnect.classList.add('hidden');
    btnDisconnect.classList.remove('hidden');
  } else {
    indicator.className = 'status-indicator disconnected';
    indicator.querySelector('.indicator-text').innerText = 'Google Disconnected';
    btnConnect.classList.remove('hidden');
    btnDisconnect.classList.add('hidden');
  }
}

function updateCounters(leads) {
  const total = leads.length;
  const phones = leads.filter(l => l.phone && l.phone.trim().length >= 10).length;
  const drafts = leads.filter(l => l.emailStatus === 'Draft Created').length;
  const waSent = leads.filter(l => l.whatsappStatus === 'Sent').length;

  document.getElementById('stat-total-leads').innerText = total;
  document.getElementById('stat-leads-phone').innerText = phones;
  document.getElementById('stat-email-drafts').innerText = drafts;
  document.getElementById('stat-wa-sent').innerText = waSent;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span>${escapeHTML(message)}</span>
    <button class="toast-close-btn">&times;</button>
  `;
  
  toast.querySelector('.toast-close-btn').addEventListener('click', () => {
    toast.remove();
  });

  container.appendChild(toast);
  
  // Auto remove after 5 seconds
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.2s reverse forwards';
    setTimeout(() => toast.remove(), 200);
  }, 5000);
}

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// --- WhatsApp QR Helper Functions ---
async function loadWaStatus() {
  try {
    const res = await fetch('/api/whatsapp/status');
    const data = await res.json();
    updateWaUI(data);
  } catch (err) {
    console.error('Failed to load WhatsApp status:', err);
  }
}

function updateWaUI(data) {
  const badge = document.getElementById('wa-status-badge');
  const text = document.getElementById('wa-status-text');
  const qrContainer = document.getElementById('wa-qr-container');
  const qrImg = document.getElementById('wa-qr-img');
  const loader = document.getElementById('wa-loader');
  const btnDisconnect = document.getElementById('btn-wa-disconnect');

  if (!badge) return; // Not on settings tab loaded yet

  // Reset defaults
  badge.className = 'status-indicator';
  qrContainer.style.display = 'none';
  loader.style.display = 'none';
  btnDisconnect.classList.add('hidden');

  if (data.status === 'Connected') {
    badge.classList.add('connected');
    text.innerText = 'Connected';
    btnDisconnect.classList.remove('hidden');
  } else if (data.status === 'Connecting') {
    badge.classList.add('disconnected');
    text.innerText = 'Connecting...';
    loader.style.display = 'block';
  } else if (data.status === 'QR_Ready') {
    badge.classList.add('disconnected');
    text.innerText = 'Scan QR Code';
    if (data.qr) {
      qrImg.src = data.qr;
      qrContainer.style.display = 'flex';
    }
  } else {
    badge.classList.add('disconnected');
    text.innerText = 'Disconnected';
  }
}

async function handleWaDisconnect() {
  if (!confirm('Are you sure you want to log out of WhatsApp?')) return;
  try {
    const res = await fetch('/api/whatsapp/disconnect', { method: 'POST' });
    if (res.ok) {
      showToast('WhatsApp logged out. Generating new QR code...', 'success');
      loadWaStatus();
    } else {
      showToast('Failed to disconnect WhatsApp.', 'error');
    }
  } catch (e) {
    showToast('Error disconnecting WhatsApp.', 'error');
  }
}
