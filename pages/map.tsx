import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';

type Customer = {
  name: string;
  address: string;                 // adresse finale (custom.address ou adresse principale)
  addressSource: 'custom' | 'default';
  lastOrderAt: string | null;
  wholesale: boolean;              // true si profil wholesale rempli
  tags?: string[];                 // pour filtrer "wls"
  lat?: number;
  lng?: number;
};

const DEFAULT_CENTER: [number, number] = [48.8566, 2.3522]; // Paris

function isInactive(lastOrderAt: string | null): boolean {
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  return !lastOrderAt || new Date(lastOrderAt) < twoYearsAgo;
}

function makeIcon(L: any, kind: 'red' | 'redWhite' | 'orange' | 'grey') {
  const size = 18;
  let style = '';
  if (kind === 'red') {
    style = `background:#ef4444;`;
  } else if (kind === 'redWhite') {
    style = `background:linear-gradient(90deg,#ef4444 50%, #ffffff 50%);`;
  } else if (kind === 'orange') {
    style = `background:#f59e0b;`;
  } else {
    // grey
    style = `background:#d1d5db;`;
  }
  const html = `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      ${style}
      border:1px solid rgba(0,0,0,0.35);
    "></div>`;
  return L.divIcon({
    html,
    className: 'reseller-pin',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export default function MapPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);

  // progression & debug
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [okCount, setOkCount] = useState(0);
  const [failCount, setFailCount] = useState(0);
  const [lastError, setLastError] = useState<string>('');

  // filtres d’affichage
  const [showRed, setShowRed] = useState(true);
  const [showRedWhite, setShowRedWhite] = useState(true);
  const [showOrange, setShowOrange] = useState(true);
  const [showGrey, setShowGrey] = useState(true);

  // recherche
  const [search, setSearch] = useState('');

  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);

  // init carte
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const L = require('leaflet');
    const m = L.map('map').setView(DEFAULT_CENTER, 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(m);
    mapRef.current = m;
    return () => m.remove();
  }, []);

  // charger clients + filtrer tag wls + géocoder 1 par 1
  useEffect(() => {
    (async () => {
      const key = new URLSearchParams(window.location.search).get('key') || '';

      // 1) clients
      const r = await fetch(`/api/customers?key=${encodeURIComponent(key)}`);
      const baseJson = await r.json().catch(() => null);
      if (!Array.isArray(baseJson)) {
        setLastError('Erreur /api/customers (réponse non JSON array)');
        setLoading(false);
        return;
      }

      // Filtre "wls" (insensible à la casse). Si pas de tags, on ignore (au cas où filtré côté serveur).
      const raw: Customer[] = (baseJson as Customer[]).filter((c) => {
        const tags = (c.tags || []).map((t) => t.toLowerCase());
        return tags.includes('wls');
      });

      setProgress({ done: 0, total: raw.length });

      // 2) géocode séquentiel
      for (let i = 0; i < raw.length; i++) {
        const b = raw[i];
        try {
          const g = await fetch(`/api/geocode?key=${encodeURIComponent(key)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: b.address }),
          });

          if (!g.ok) {
            setFailCount((v) => v + 1);
            setLastError(`geocode ${g.status} ${g.statusText}`);
          } else {
            const c: any = await g.json().catch(() => null);
            const ok =
              c &&
              typeof c.lat === 'number' &&
              typeof c.lng === 'number' &&
              !Number.isNaN(c.lat) &&
              !Number.isNaN(c.lng);

            if (ok) {
              setOkCount((v) => v + 1);
              setCustomers((prev) => {
                const byKey = new Map(prev.map((p) => [`${p.name}|${p.address}`, p]));
                byKey.set(`${b.name}|${b.address}`, { ...b, lat: c.lat, lng: c.lng });
                return Array.from(byKey.values());
              });
            } else {
              setFailCount((v) => v + 1);
              setLastError('geocode ok mais coords invalides');
            }
          }
        } catch (e: any) {
          setFailCount((v) => v + 1);
          setLastError(`exception: ${e?.message || 'unknown'}`);
        }

        setProgress({ done: i + 1, total: raw.length });
        if (i === 0) setLoading(false);
        await new Promise((rr) => setTimeout(rr, 1100)); // ~1 req/s
      }
    })();
  }, []);

  // Catégories (priorité ORANGE > ROUGE/ROUGE&BLANC ; GRIS si wholesale non rempli)
  type Cat = 'red' | 'redWhite' | 'orange' | 'grey' | null;
  function getCategory(c: Customer): Cat {
    const validWholesale = !!c.wholesale;
    const hasCustom = c.addressSource === 'custom';
    const inactive = isInactive(c.lastOrderAt);

    // 4) gris : wholesale non rempli
    if (!validWholesale) return 'grey';

    // 3) orange : wholesale rempli + inactif (prioritaire)
    if (inactive) return 'orange';

    // 1) rouge : custom.address + wholesale rempli
    if (hasCustom) return 'red';

    // 2) rouge&blanc : pas de custom.address (adresse par défaut) + wholesale rempli
    return 'redWhite';
  }

  // dessiner selon filtres
  useEffect(() => {
    if (!mapRef.current) return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    if (!customers.length) return;
    const L = require('leaflet');

    for (const c of customers) {
      if (
        typeof c.lat !== 'number' ||
        typeof c.lng !== 'number' ||
        Number.isNaN(c.lat) ||
        Number.isNaN(c.lng)
      )
        continue;

      const cat = getCategory(c);
      if (!cat) continue;

      if (cat === 'red' && !showRed) continue;
      if (cat === 'redWhite' && !showRedWhite) continue;
      if (cat === 'orange' && !showOrange) continue;
      if (cat === 'grey' && !showGrey) continue;

      const icon = makeIcon(L, cat);
      const marker = L.marker([c.lat, c.lng], { icon });

      const lines: string[] = [];
      lines.push(`<b>${c.name}</b>`);
      lines.push(c.address);
      lines.push(c.wholesale ? 'Profil wholesale : <b>rempli</b>' : 'Profil wholesale : <b>non rempli</b>');
      if (c.addressSource === 'custom') {
        lines.push('<i>Adresse de revente (custom.address)</i>');
      } else {
        lines.push('<i>Adresse de revente non vérifiée (adresse principale)</i>');
      }
      if (c.lastOrderAt) lines.push(`Dernière commande : ${new Date(c.lastOrderAt).toLocaleDateString()}`);

      marker.bindPopup(lines.join('<br/>'));
      marker.addTo(mapRef.current);
      markersRef.current.push(marker);
    }
  }, [customers, showRed, showRedWhite, showOrange, showGrey]);

  // recherche d’adresse
  async function searchAddress() {
    const key = new URLSearchParams(window.location.search).get('key') || '';
    const q = search.trim();
    if (!q) return;

    const r = await fetch(`/api/geocode?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: q }),
    });
    if (!r.ok) {
      alert('Adresse introuvable');
      return;
    }
    const pt: any = await r.json().catch(() => null);
    if (!pt || typeof pt.lat !== 'number' || typeof pt.lng !== 'number') {
      alert('Adresse introuvable');
      return;
    }
    mapRef.current.setView([pt.lat, pt.lng], 13);
  }

  const Legend = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
        <span>
          <i
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 999,
              background: '#ef4444',
              border: '1px solid rgba(0,0,0,0.35)',
              marginRight: 6,
            }}
          />
          Revendeurs validés
        </span>
        <span>
          <i
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 999,
              background: 'linear-gradient(90deg,#ef4444 50%, #ffffff 50%)',
              border: '1px solid rgba(0,0,0,0.35)',
              marginRight: 6,
            }}
          />
          Revendeurs validés (adresse de revente non vérifiée)
        </span>
        <span>
          <i
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 999,
              background: '#f59e0b',
              border: '1px solid rgba(0,0,0,0.35)',
              marginRight: 6,
            }}
          />
          Pas de commande depuis + de 2 ans
        </span>
        <span>
          <i
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 999,
              background: '#d1d5db',
              border: '1px solid rgba(0,0,0,0.35)',
              marginRight: 6,
            }}
          />
          Revendeurs non validés
        </span>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label>
          <input type="checkbox" checked={showRed} onChange={(e) => setShowRed(e.target.checked)} /> Afficher
          rouges
        </label>
        <label>
          <input
            type="checkbox"
            checked={showRedWhite}
            onChange={(e) => setShowRedWhite(e.target.checked)}
          />{' '}
          Afficher rouge & blanc
        </label>
        <label>
          <input
            type="checkbox"
            checked={showOrange}
            onChange={(e) => setShowOrange(e.target.checked)}
          />{' '}
          Afficher orange
        </label>
        <label>
          <input type="checkbox" checked={showGrey} onChange={(e) => setShowGrey(e.target.checked)} /> Afficher
          gris clair
        </label>
      </div>
    </div>
  );

  return (
    <>
      <Head>
        <title>Carte des revendeurs</title>
        <link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css" />
      </Head>

      <div
        style={{
          position: 'absolute',
          zIndex: 1000,
          left: 10,
          top: 10,
          background: '#fff',
          padding: 10,
          borderRadius: 8,
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          maxWidth: 720,
        }}
      >
        {/* Recherche */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher une adresse…"
            style={{ padding: 8, width: 320 }}
          />
          <button onClick={searchAddress} style={{ padding: '8px 12px' }}>
            Rechercher
          </button>
        </div>

        {/* Chargement / Debug */}
        <div style={{ marginTop: 8 }}>
          {loading ? `Chargement… (${progress.done}/${progress.total})` : null}
          {progress.total > 0 && (
            <>
              <div style={{ marginTop: 6, width: 280, height: 6, background: '#eee', borderRadius: 4 }}>
                <div
                  style={{
                    width: `${
                      progress.total ? Math.round((progress.done / progress.total) * 100) : 0
                    }%`,
                    height: '100%',
                    borderRadius: 4,
                    background: '#60a5fa',
                  }}
                />
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: '#444' }}>
                OK: <b>{okCount}</b> — Échecs: <b>{failCount}</b>
                {lastError && <div style={{ marginTop: 4, color: '#b91c1c' }}>Dernière erreur: {lastError}</div>}
              </div>
            </>
          )}
        </div>

        <Legend />
      </div>

      <div id="map" style={{ height: '100vh' }} />
    </>
  );
}