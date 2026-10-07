import Database from 'better-sqlite3';

const db = new Database('./leads.db');

const leads = db.prepare(`
  SELECT id, businessName, phone, searchTerm, location, whatsappStatus
  FROM leads
  WHERE (whatsappStatus = 'Pending' OR whatsappStatus IS NULL)
    AND phone IS NOT NULL AND length(phone) > 5
`).all();

const validMobile = leads.filter(l => {
  const d = l.phone.replace(/\D/g, '');
  return (d.length === 10 && /^[6-9]/.test(d)) || (d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d.slice(2)));
});

// Take first batch of 25 leads for safety
const batch = validMobile.slice(0, 25);

console.log(JSON.stringify({
  totalPending: validMobile.length,
  batchCount: batch.length,
  batchIds: batch.map(b => b.id),
  preview: batch.slice(0, 5).map(b => ({ name: b.businessName, phone: b.phone, city: b.location, term: b.searchTerm }))
}));
