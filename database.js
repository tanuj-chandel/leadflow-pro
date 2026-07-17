import fs from 'fs';
import path from 'path';

const DB_FILE = path.join(process.cwd(), 'data.json');

const DEFAULT_DB = {
  settings: {
    placesApiKey: '',
    googleClientId: '',
    googleClientSecret: '',
    googleRedirectUri: 'http://localhost:3000/oauth2callback',
    googleTokens: null, // access_token, refresh_token, expiry_date
    emailSubjectTemplate: 'Partnership Opportunity - {{BusinessName}}',
    emailBodyTemplate: 'Hi {{BusinessName}} team,\n\nI came across your business in {{Location}} and wanted to reach out. We provide solutions that could support your operations.\n\nWould you be open to a quick call this week?\n\nBest regards,\n[Your Name]\n[Your Company]',
    waMessageTemplate: 'Hi {{BusinessName}} team,\n\nI found your business in {{Location}} and wanted to connect. Do you have a few minutes for a quick call this week?\n\nBest regards,\n[Your Name]'
  },
  locations: [],
  leads: [],
  whatsappLogs: []
};

class Database {
  constructor() {
    this.data = DEFAULT_DB;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const fileContent = fs.readFileSync(DB_FILE, 'utf8');
        this.data = JSON.parse(fileContent);
        // Ensure all keys exist and deep-merge settings
        Object.keys(DEFAULT_DB).forEach(key => {
          if (this.data[key] === undefined) {
            this.data[key] = DEFAULT_DB[key];
          } else if (key === 'settings') {
            this.data.settings = {
              ...DEFAULT_DB.settings,
              ...this.data.settings
            };
          }
        });
      } else {
        this.save();
      }
    } catch (error) {
      console.error('Error loading database, resetting to default:', error);
      this.data = DEFAULT_DB;
      this.save();
    }
  }

  save() {
    try {
      const tempFile = `${DB_FILE}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempFile, DB_FILE);
    } catch (error) {
      console.error('Failed to write to database file:', error);
    }
  }

  // --- Settings ---
  getSettings() {
    return this.data.settings;
  }

  updateSettings(newSettings) {
    this.data.settings = { ...this.data.settings, ...newSettings };
    this.save();
    return this.data.settings;
  }

  // --- Locations ---
  getLocations() {
    return this.data.locations;
  }

  addLocation(term, location, maxLeads = 20) {
    const newLoc = {
      id: 'loc_' + Date.now() + Math.random().toString(36).substr(2, 5),
      term,
      location,
      maxLeads: parseInt(maxLeads, 10) || 20,
      status: 'Pending', // Pending, Scraping, Done, Error
      error: '',
      createdAt: new Date().toISOString()
    };
    this.data.locations.push(newLoc);
    this.save();
    return newLoc;
  }

  updateLocation(id, updates) {
    const idx = this.data.locations.findIndex(l => l.id === id);
    if (idx !== -1) {
      this.data.locations[idx] = { ...this.data.locations[idx], ...updates };
      this.save();
      return this.data.locations[idx];
    }
    return null;
  }

  deleteLocation(id) {
    this.data.locations = this.data.locations.filter(l => l.id !== id);
    // Also optional: keep leads, but remove location link or delete leads.
    // We will keep leads so the user doesn't lose scraped data.
    this.save();
  }

  // --- Leads ---
  getLeads() {
    return this.data.leads;
  }

  addLead(lead) {
    // Check for duplicate website or placeId
    const exists = this.data.leads.some(l => 
      (lead.placeId && l.placeId === lead.placeId) || 
      (lead.website && lead.website !== '' && l.website === lead.website)
    );
    if (exists) return null;

    const newLead = {
      id: 'lead_' + Date.now() + Math.random().toString(36).substr(2, 5),
      createdAt: new Date().toISOString(),
      emailStatus: 'Pending', // Pending, Draft Created, Error
      whatsappStatus: 'Pending', // Pending, Sent, Error
      ...lead
    };
    this.data.leads.push(newLead);
    this.save();
    return newLead;
  }

  updateLead(id, updates) {
    const idx = this.data.leads.findIndex(l => l.id === id);
    if (idx !== -1) {
      this.data.leads[idx] = { ...this.data.leads[idx], ...updates };
      this.save();
      return this.data.leads[idx];
    }
    return null;
  }

  deleteLead(id) {
    this.data.leads = this.data.leads.filter(l => l.id !== id);
    this.save();
  }

  clearLeads() {
    this.data.leads = [];
    this.save();
  }

  clearLeadsForQuery(term, location) {
    this.data.leads = this.data.leads.filter(l => 
      !(l.searchTerm && l.searchTerm.toLowerCase() === term.toLowerCase() && 
        l.location && l.location.toLowerCase() === location.toLowerCase())
    );
    this.save();
  }

  // --- WhatsApp Logs ---
  getWhatsappLogs() {
    return this.data.whatsappLogs;
  }

  addWhatsappLog(log) {
    const newLog = {
      id: 'log_' + Date.now() + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      ...log
    };
    this.data.whatsappLogs.push(newLog);
    // Keep only last 1000 logs to prevent size explosion
    if (this.data.whatsappLogs.length > 1000) {
      this.data.whatsappLogs.shift();
    }
    this.save();
    return newLog;
  }
}

export const db = new Database();
