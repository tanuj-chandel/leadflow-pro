import Database from 'better-sqlite3';

const db = new Database('./leads.db');
const res = db.prepare(`
  UPDATE leads 
  SET leadStatus = 'Contacted' 
  WHERE (whatsappStatus = 'Sent' OR emailStatus = 'Sent') 
    AND (leadStatus = 'New' OR leadStatus IS NULL)
`).run();

console.log('✅ Backfilled Contacted status. Rows updated:', res.changes);

const updatedCounts = db.prepare('SELECT leadStatus, count(*) as count FROM leads GROUP BY leadStatus').all();
console.log('Updated leadStatus breakdown:', updatedCounts);
