import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dataDir = process.env.VERCEL ? '/tmp' : require('path').join(process.cwd(), '.data');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'geo-cache.db');
const db = new Database(dbPath);

db.exec(`CREATE TABLE IF NOT EXISTS geo_cache (
  address TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  updated_at INTEGER NOT NULL
);`);

export function getCoords(address: string): {lat:number, lng:number} | null {
  const row = db.prepare('SELECT lat, lng FROM geo_cache WHERE address = ?').get(address);
  return row ? { lat: row.lat, lng: row.lng } : null;
}

export function setCoords(address: string, lat: number, lng: number) {
  db.prepare('REPLACE INTO geo_cache(address, lat, lng, updated_at) VALUES(?, ?, ?, ?)').run(address, lat, lng, Date.now());
}
