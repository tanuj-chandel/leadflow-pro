import Database from 'better-sqlite3';

const db = new Database('./leads.db');

const todayLogs = db.prepare(`
  SELECT count(*) as sentToday 
  FROM whatsapp_logs 
  WHERE timestamp >= '2026-10-05T00:00:00.000Z' AND status = 'Sent'
`).get();

console.log('Total Messages Sent Today (Oct 5):', todayLogs.sentToday);

const latest = db.prepare(`
  SELECT leadName, phone, status, timestamp 
  FROM whatsapp_logs 
  WHERE timestamp >= '2026-10-05T00:00:00.000Z'
  ORDER BY id DESC LIMIT 10
`).all();

console.table(latest);
