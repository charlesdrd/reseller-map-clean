import { useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';

type Customer = {
  name: string;
  address: string;                 // adresse finale (custom.address OU adresse principale)
  addressSource: 'custom' | 'default';
  lastOrderAt: string | null;
  wholesale: boolean;              // profil wholesale rempli ?
  tags?: string[];                 // tags du client (optionnel)
  lat?: number;
  lng?: number;
};

// --------- utils ----------
const DEFAULT_CENTER: [number, number] = [48.8566, 2.3522]; // Paris
const CACHE_KEY = 'geoCache.v1'; // cache localStorage { [address]: {lat,lng} }

function isInactive(lastOrderAt: string | null): boolean {
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  return !lastOrderAt || new Date(lastOrderAt) < twoYearsAgo;
}

function hasEverOrdered(lastOrderAt: string | null): boolean {
  return !!lastOrderAt;
}

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

// Leaflet icon (rouge pour tous les points)
function makeRedIcon(L: any) {
  const size = 18;
  const html = `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:#ef4444;border:1px solid rgba(0,0,0,0.35);
    "></div>`;
  return L.divIcon({
    html,
    className: 'reseller-pin',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// --------- composant ----------
export default function MapPage() {
  const [allCustomers, setAllCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);

  // progression géocodage
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [okCount, setOkCount] = useState(0);
  const [failCount, setFailCount] = useState(0);
  const [lastError, setLastError] = useState<string>('');

  // filtres combinables
  const [fHasOrdered, setFHasOrdered] = useState(false);
  const [fInactive2y, setFInactive2y] = useState(false);
  const [fTagWls, setFTagWls] = useState(false);
  const [fWholesale, setFWholesale] = useState(false);

  // recherche adresse
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

  // 1) Charger tous les clients
  useEffect(() => {
    (async () => {
      const key = new URLSearchParams(window.location.search).get('key') || '';
      const r = await fetch(`/api/customers?key=${encodeURIComponent(key)}`);
      const base = await r.json().catch(() => null);

      if (!Array.isArray(base)) {
        setLastError('Erreur /api/customers (réponse non JSON array)');
        setLoading(false);
        return;
      }

      // on garde UNIQUEMENT ceux qui ont une adresse (CAS 3 exclus)
      const usable: Customer[] = (base as Customer[]).filter(
        (c) => typeof c.address === 'string' && c.address.trim().length > 0
      );

      setAllCustomers(usable);
      setLoading(false);
    })();
  }, []);

  // Liste filtrée selon les cases cochées — memo pour éviter recalculs inutiles
  const filtered = useMemo(() => {
    return allCustomers.filter((c) => {
      if (fHasOrdered && !hasEverOrdered(c.lastOrderAt)) return false;
      if (fInactive2y && !isInactive(c.lastOrderAt)) return false;
      if (fWholesale && !c.wholesale) return false;
      if (fTagWls) {
        const tags = (c.tags || []).map((t) => String(t).toLowerCase());
        if (!tags.includes('wls')) return false;
      }
      return true;
    });
  }, [allCustomers, fHasOrdered, fInactive2y, fWholesale, fTagWls]);

  // 2) Géocodage (plus rapide) : cache localStorage + dédup + parallélisme limité (3)
  useEffect(() => {
    if (!mapRef.current) return;

    // clear markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    if (!filtered.length) {
      setProgress({ done: 0, total: 0 });
      return;
    }

    const L = require('leaflet');
    const icon = makeRedIcon(L);

    let cancelled = false;

    (async () => {
      const key = new URLSearchParams(window.location.search).get('key') || '';
      const cache = loadGeoCache();

      // adresses uniques
      const uniqueAddrs = Array.from(new Set(filtered.map((c) => c.address.trim())));
      setProgress({ done: 0, total: uniqueAddrs.length });
      setOkCount(0);
      setFailCount(0);
      setLastError('');

      // Petit helper pour une tâche de géocode
      const geocodeOne = async (addr: string) => {
        if (cancelled) return null;

        // cache local
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
          const ok =
            c && typeof c.lat === 'number' && typeof c.lng === 'number' && !Number.isNaN(c.lat) && !Number.isNaN(c.lng);
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
          // incrémente la barre de progression
          setProgress((p) => ({ ...p, done: Math.min(p.done + 1, uniqueAddrs.length) }));
        }
      };

      // Exécuter avec parallélisme limité
      const CONCURRENCY = 3;
      const results: Record<string, { lat: number; lng: number } | null> = {};
      let idx = 0;

      async function worker() {
        while (!cancelled && idx < uniqueAddrs.length) {
          const my = uniqueAddrs[idx++];
          const res = await geocodeOne(my);
          results[my] = res;
        }
      }
      const workers = Array.from({ length: Math.min(CONCURRENCY, uniqueAddrs.length) }, worker);
      await Promise.all(workers);

      if (cancelled) return;

      // dessiner tous les markers
      for (const c of filtered) {
        const addr = c.address.trim();
        const pt = results[addr] || loadGeoCache()[addr]; // si job fini il est en cache
        if (!pt) continue;

        const marker = L.marker([pt.lat, pt.lng], { icon });

        const lines: string[] = [];
        lines.push(`<b>${c.name}</b>`);
        lines.push(c.address);
        lines.push(c.wholesale ? 'Profil wholesale : <b>rempli</b>' : 'Profil wholesale : <b>non rempli</b>');
        lines.push(
          c.addressSource === 'custom'
            ? '<i>Adresse de revente (custom.address)</i>'
            : '<i>Adresse par défaut (Shopify)</i>'
        );
        if (c.lastOrderAt) lines.push(`Dernière commande : ${new Date(c.lastOrderAt).toLocaleDateString()}`);

        marker.bindPopup(lines.join('<br/>'));
        marker.addTo(mapRef.current);
        markersRef.current.push(marker);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filtered]);

  // recherche d’adresse (recentrage)
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
          maxWidth: 860,
        }}
      >
        {/* Recherche */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher une adresse…"
            style={{ padding: 8, width: 360 }}
          />
          <button onClick={searchAddress} style={{ padding: '8px 12px' }}>
            Rechercher
          </button>
        </div>

        {/* Filtres combinables */}
        <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label>
            <input
              type="checkbox"
              checked={fHasOrdered}
              onChange={(e) => setFHasOrdered(e.target.checked)}
            />{' '}
            A déjà commandé
          </label>
          <label>
            <input
              type="checkbox"
              checked={fInactive2y}
              onChange={(e) => setFInactive2y(e.target.checked)}
            />{' '}
            N'a pas passé commande depuis + de 2 ans
          </label>
          <label>
            <input type="checkbox" checked={fTagWls} onChange={(e) => setFTagWls(e.target.checked)} /> A
            le tag <code>wls</code>
          </label>
          <label>
            <input
              type="checkbox"
              checked={fWholesale}
              onChange={(e) => setFWholesale(e.target.checked)}
            />{' '}
            Wholesale profile rempli
          </label>
        </div>

        {/* Statut / progression */}
        <div style={{ marginTop: 10, fontSize: 14 }}>
          {loading
            ? `Chargement des clients…`
            : `Clients filtrés: ${filtered.length} / ${allCustomers.length}`}
          {progress.total > 0 && (
            <>
              <div style={{ marginTop: 6, width: 340, height: 6, background: '#eee', borderRadius: 4 }}>
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
                Géocode OK: <b>{okCount}</b> — Échecs: <b>{failCount}</b>{' '}
                {lastError && <span style={{ color: '#b91c1c' }}>• Dernière erreur : {lastError}</span>}
              </div>
            </>
          )}
          {progress.total === 0 && !loading && filtered.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: '#444' }}>
              <i>Tout est déjà en cache — affichage direct.</i>
            </div>
          )}
        </div>

        {/* Légende simple : tous les points sont rouges */}
        <div style={{ marginTop: 8, fontSize: 13 }}>
          <span
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
          <b>Points</b> : adresse de revente <i>(custom.address)</i> si présente, sinon adresse principale.
        </div>
      </div>

      <div id="map" style={{ height: '100vh' }} />
    </>
  );
}