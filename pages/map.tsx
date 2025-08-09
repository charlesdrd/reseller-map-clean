import { useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';

type Customer = {
  name: string;
  address: string;                 // adresse finale (custom.address ou adresse par défaut)
  addressSource: 'custom' | 'default';
  lastOrderAt: string | null;      // ISO ou null
  wholesale: string | boolean;     // “défini” = revendeur (peu importe la valeur)
  businessType?: string | null;    // custom.business_type si dispo
  lat?: number;
  lng?: number;
};

// ---------- Constantes & helpers ----------
const DEFAULT_CENTER: [number, number] = [48.8566, 2.3522];
const CACHE_KEY = 'geoCache.v1'; // localStorage

function loadGeoCache(): Record<string, { lat: number; lng: number }> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}
function saveGeoCache(cache: Record<string, { lat: number; lng: number }>) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {}
}
function clearGeoCache() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(CACHE_KEY);
}

function daysSince(d: Date) {
  const ms = Date.now() - d.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

type Activity = 'never' | 'recent' | 'stale' | 'normal';
function classifyActivity(lastOrderAt: string | null): Activity {
  if (!lastOrderAt) return 'never';
  const d = new Date(lastOrderAt);
  if (isNaN(d.getTime())) return 'never';
  const dd = daysSince(d);
  if (dd <= 90) return 'recent';
  if (dd > 730) return 'stale'; // > 2 ans
  return 'normal';
}

// Marqueurs:
// - confirmed (custom) => disque rouge plein
// - default          => anneau rouge (fond blanc)
// Overlays:
// - halo vert  => recent
// - halo gris  => stale
// - dot bleu   => never
function makeIcon(L: any, opts: { confirmed: boolean; activity: Activity }) {
  const size = 18;
  const baseStyle =
    opts.confirmed
      ? `background:#ef4444;`
      : `background:#ffffff;border:2px solid #ef4444;box-sizing:border-box;`;

  // priorités halo: stale (gris) > recent (vert) > none
  let halo = '';
  if (opts.activity === 'stale') halo = '0 0 0 4px #9ca3af';
  else if (opts.activity === 'recent') halo = '0 0 0 4px #22c55e';

  const dot =
    opts.activity === 'never'
      ? `<div style="position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:#3b82f6;"></div>`
      : '';

  const html = `
    <div style="
      position:relative;
      width:${size}px;height:${size}px;border-radius:50%;
      ${baseStyle}
      border:1px solid rgba(0,0,0,.35);
      box-shadow:${halo || 'none'};
    ">
      ${dot}
    </div>`;

  return L.divIcon({
    html,
    className: 'reseller-pin',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// ---------- Composant ----------
export default function MapPage() {
  const [allCustomers, setAllCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);

  // progression géocode
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [okCount, setOkCount] = useState(0);
  const [failCount, setFailCount] = useState(0);
  const [lastError, setLastError] = useState<string>('');

  // filtres UI (ne relancent pas le géocode)
  const [fRecent, setFRecent] = useState(true);     // < 90 j
  const [fStale, setFStale] = useState(true);       // > 2 ans
  const [fNever, setFNever] = useState(true);       // jamais
  const [fNormal, setFNormal] = useState(true);     // entre 90j et 2 ans

  const [fConfirmed, setFConfirmed] = useState(true); // custom.address
  const [fDefault, setFDefault] = useState(true);     // adresse par défaut

  const [search, setSearch] = useState(''); // recadrage

  const mapRef = useRef<any>(null);
  const markersRef = useRef<Array<{ marker: any; customer: Customer; activity: Activity; confirmed: boolean }>>(
    []
  );

  // init carte
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const L = require('leaflet');
    const m = L.map('map').setView(DEFAULT_CENTER, 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(m);
    mapRef.current = m;
    return () => m.remove();
  }, []);

  // Charger revendeurs + garder seulement ceux qui ont wholesale défini + une adresse
  async function fetchCustomers() {
    setLoading(true);
    setLastError('');
    setProgress({ done: 0, total: 0 });
    setOkCount(0);
    setFailCount(0);

    try {
      const key = new URLSearchParams(window.location.search).get('key') || '';
      const r = await fetch(`/api/customers?key=${encodeURIComponent(key)}`);
      const base = await r.json();

      if (!Array.isArray(base)) throw new Error('Réponse /api/customers invalide');

      // wholesale défini + adresse exploitable
      const usable: Customer[] = (base as Customer[]).filter((c) => {
        const wholesaleDefined = c.wholesale !== undefined && c.wholesale !== null && `${c.wholesale}` !== '';
        const hasAddress = c.address && c.address.trim().length > 0;
        return wholesaleDefined && hasAddress;
      });

      setAllCustomers(usable);
    } catch (e: any) {
      setLastError(e?.message || 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }

  // Au premier chargement
  useEffect(() => {
    fetchCustomers();
  }, []);

  // Liste avec classification d’activité
  const enriched = useMemo(() => {
    return allCustomers.map((c) => ({
      ...c,
      activity: classifyActivity(c.lastOrderAt),
      confirmed: c.addressSource === 'custom',
    }));
  }, [allCustomers]);

  // Filtres (en mémoire uniquement)
  const filtered = useMemo(() => {
    return enriched.filter((c) => {
      // activité
      if (!fRecent && c.activity === 'recent') return false;
      if (!fStale && c.activity === 'stale') return false;
      if (!fNever && c.activity === 'never') return false;
      if (!fNormal && c.activity === 'normal') return false;
      // source adresse
      if (!fConfirmed && c.confirmed) return false;
      if (!fDefault && !c.confirmed) return false;
      return true;
    });
  }, [enriched, fRecent, fStale, fNever, fNormal, fConfirmed, fDefault]);

  // Géocodage (cache + dédup + parallélisme) puis création des markers (une seule fois par refresh/reload)
  useEffect(() => {
    if (!mapRef.current) return;

    // clear anciens markers
    markersRef.current.forEach((m) => m.marker.remove());
    markersRef.current = [];

    if (!enriched.length) {
      setProgress({ done: 0, total: 0 });
      return;
    }

    const L = require('leaflet');

    let cancelled = false;
    (async () => {
      const key = new URLSearchParams(window.location.search).get('key') || '';
      const cache = loadGeoCache();

      // adresses uniques à géocoder
      const addrs = Array.from(new Set(enriched.map((c) => c.address.trim())));
      setProgress({ done: 0, total: addrs.length });
      setOkCount(0);
      setFailCount(0);
      setLastError('');

      // fonction unité
      const geocodeOne = async (addr: string) => {
        if (cancelled) return null;
        if (cache[addr]) return cache[addr];

        try {
          const g = await fetch(`/api/geocode?key=${encodeURIComponent(key)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: addr }),
          });
          if (!g.ok) {
            setFailCount((v) => v + 1);
            setLastError(`geocode ${g.status} ${g.statusText}`);
            return null;
          }
          const c: any = await g.json().catch(() => null);
          const ok = c && typeof c.lat === 'number' && typeof c.lng === 'number' && !Number.isNaN(c.lat) && !Number.isNaN(c.lng);
          if (ok) {
            cache[addr] = { lat: c.lat, lng: c.lng };
            setOkCount((v) => v + 1);
            saveGeoCache(cache);
            return cache[addr];
          } else {
            setFailCount((v) => v + 1);
            setLastError('geocode ok mais coords invalides');
            return null;
          }
        } catch (e: any) {
          setFailCount((v) => v + 1);
          setLastError(`exception: ${e?.message || 'unknown'}`);
          return null;
        } finally {
          setProgress((p) => ({ ...p, done: Math.min(p.done + 1, addrs.length) }));
        }
      };

      // parallélisme limité
      const CONCURRENCY = 3;
      const idxRef = { i: 0 };
      const results: Record<string, { lat: number; lng: number } | null> = {};

      async function worker() {
        while (!cancelled && idxRef.i < addrs.length) {
          const addr = addrs[idxRef.i++];
          results[addr] = await geocodeOne(addr);
        }
      }
      const workers = Array.from({ length: Math.min(CONCURRENCY, addrs.length) }, worker);
      await Promise.all(workers);
      if (cancelled) return;

      // Créer tous les markers une fois pour toutes (on filtrera par affichage ensuite)
      for (const c of enriched) {
        const pt = results[c.address.trim()] || loadGeoCache()[c.address.trim()];
        if (!pt) continue;

        const icon = makeIcon(L, { confirmed: !!c.confirmed, activity: c.activity as Activity });
        const marker = L.marker([pt.lat, pt.lng], { icon });

        const lines: string[] = [];
        lines.push(`<b>${c.name}</b>`);
        if (c.businessType) lines.push(`<span style="opacity:.8">Type : ${c.businessType}</span>`);
        lines.push(c.address);
        lines.push(
          c.confirmed
            ? '<i>Adresse de magasin (custom.address)</i>'
            : '<i>Adresse non confirmée (adresse par défaut)</i>'
        );
        if (c.lastOrderAt) {
          const d = new Date(c.lastOrderAt);
          lines.push(`Dernière commande : ${isNaN(d.getTime()) ? '-' : d.toLocaleDateString()}`);
        } else {
          lines.push(`Jamais commandé`);
        }
        lines.push(`Wholesale : <code>${String(c.wholesale)}</code>`);
        // lien Google Maps
        const mapsQ = encodeURIComponent(c.address);
        lines.push(`<a target="_blank" rel="noreferrer" href="https://www.google.com/maps/search/?api=1&query=${mapsQ}">Ouvrir dans Google Maps</a>`);

        marker.bindPopup(lines.join('<br/>'));
        marker.addTo(mapRef.current);
        markersRef.current.push({ marker, customer: c, activity: c.activity as Activity, confirmed: !!c.confirmed });
      }
    })();

    return () => { cancelled = true; };
  }, [enriched]);

  // Appliquer les filtres sans régéocoder (on montre/masque les markers existants)
  useEffect(() => {
    if (!mapRef.current) return;
    for (const item of markersRef.current) {
      const a = item.activity;
      const showActivity =
        (a === 'recent' && fRecent) ||
        (a === 'stale' && fStale) ||
        (a === 'never' && fNever) ||
        (a === 'normal' && fNormal);

      const showSource = (item.confirmed && fConfirmed) || (!item.confirmed && fDefault);

      const visible = showActivity && showSource;
      const el = (item.marker as any)?._icon as HTMLElement | undefined;
      if (el) el.style.display = visible ? 'block' : 'none';
    }
  }, [fRecent, fStale, fNever, fNormal, fConfirmed, fDefault]);

  // Recherche d’adresse (recentrage)
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

  // Rechargement manuel: purge le cache + relance la récup/géocode/markers
  async function manualReload() {
    clearGeoCache();
    markersRef.current.forEach((m) => m.marker.remove());
    markersRef.current = [];
    await fetchCustomers();
  }

  // UI
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
          padding: 12,
          borderRadius: 8,
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          maxWidth: 900,
        }}
      >
        {/* Ligne recherche + reload */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher / centrer une adresse…"
            style={{ padding: 8, width: 360 }}
          />
          <button onClick={searchAddress} style={{ padding: '8px 12px' }}>
            Rechercher
          </button>
          <button onClick={manualReload} style={{ padding: '8px 12px' }}>
            Recharger les données
          </button>
        </div>

        {/* Légende & filtres */}
        <div style={{ marginTop: 10 }}>
          <div style={{ marginBottom: 8, lineHeight: 1.8 }}>
            <div>
              <span style={{
                display:'inline-block', width:14, height:14, borderRadius:999,
                background:'#ef4444', border:'1px solid rgba(0,0,0,.35)', marginRight:6
              }} />
              Adresse confirmée (<code>custom.address</code>)
              <input type="checkbox" checked={fConfirmed} onChange={e=>setFConfirmed(e.target.checked)} style={{marginLeft:8}} />
            </div>
            <div>
              <span style={{
                display:'inline-block', width:14, height:14, borderRadius:999,
                background:'#fff', border:'2px solid #ef4444', boxSizing:'border-box',
                marginRight:6
              }} />
              Adresse non confirmée (adresse par défaut)
              <input type="checkbox" checked={fDefault} onChange={e=>setFDefault(e.target.checked)} style={{marginLeft:8}} />
            </div>
            <div>
              <span style={{
                display:'inline-block', width:14, height:14, borderRadius:999,
                background:'#ef4444', border:'1px solid rgba(0,0,0,.35)', marginRight:6,
                boxShadow:'0 0 0 4px #22c55e'
              }} />
              Commande <b>dans les 90 jours</b> (halo vert)
              <input type="checkbox" checked={fRecent} onChange={e=>setFRecent(e.target.checked)} style={{marginLeft:8}} />
            </div>
            <div>
              <span style={{
                display:'inline-block', width:14, height:14, borderRadius:999,
                background:'#ef4444', border:'1px solid rgba(0,0,0,.35)', marginRight:6,
                boxShadow:'0 0 0 4px #9ca3af'
              }} />
              <b>Inactif &gt; 2 ans</b> (halo gris)
              <input type="checkbox" checked={fStale} onChange={e=>setFStale(e.target.checked)} style={{marginLeft:8}} />
            </div>
            <div>
              <span style={{position:'relative', display:'inline-block', width:14, height:14, borderRadius:999,
                background:'#ef4444', border:'1px solid rgba(0,0,0,.35)', marginRight:6}}>
                <span style={{position:'absolute', left:'50%', top:'50%', width:6, height:6, marginLeft:-3, marginTop:-3, borderRadius:999, background:'#3b82f6'}} />
              </span>
              <b>Jamais commandé</b> (point bleu)
              <input type="checkbox" checked={fNever} onChange={e=>setFNever(e.target.checked)} style={{marginLeft:8}} />
            </div>
            <div>
              <span style={{
                display:'inline-block', width:14, height:14, borderRadius:999,
                background:'#ef4444', border:'1px solid rgba(0,0,0,.35)', marginRight:6
              }} />
              Autres (entre 90 j et 2 ans)
              <input type="checkbox" checked={fNormal} onChange={e=>setFNormal(e.target.checked)} style={{marginLeft:8}} />
            </div>
          </div>

          <div style={{ fontSize: 13, color: '#444' }}>
            {loading
              ? 'Chargement des revendeurs…'
              : `Revendeurs: ${enriched.length} | Affichés (selon filtres): ${filtered.length}`}
            {progress.total > 0 && (
              <>
                <div style={{ marginTop: 6, width: 360, height: 6, background: '#eee', borderRadius: 4 }}>
                  <div
                    style={{
                      width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                      height: '100%', borderRadius: 4, background: '#60a5fa'
                    }}
                  />
                </div>
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  Géocode OK: <b>{okCount}</b> — Échecs: <b>{failCount}</b>
                  {lastError && <span style={{ color: '#b91c1c' }}> • Dernière erreur: {lastError}</span>}
                </div>
                <div style={{ marginTop: 4, fontSize: 12, opacity: .8 }}>
                  Astuce: après le premier chargement, c’est instantané grâce au cache local.
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div id="map" style={{ height: '100vh' }} />
    </>
  );
}