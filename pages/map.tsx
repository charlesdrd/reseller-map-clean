import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';

type Customer = {
  name: string;
  address: string;
  addressSource: 'custom' | 'default'; // 'default' = on utilise l'adresse principale (non confirmée)
  lastOrderAt: string | null;
  wholesale: boolean; // validé si true
  lat?: number;
  lng?: number;
  dist?: number;
};

const DEFAULT_RADIUS_KM = 1;

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function isInactive(lastOrderAt: string | null): boolean {
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  return !lastOrderAt || new Date(lastOrderAt) < twoYearsAgo;
}

/** Icône Leaflet :
 * - validé + adresse par défaut -> ORANGE plein
 * - non validé + adresse par défaut -> BICOLORE ORANGE+GRIS
 * - adresse confirmée (custom) -> ROUGE
 * - inactif (>2 ans) -> halo gris
 */
function makeIcon(
  L: any,
  opts: {
    usingDefault: boolean;
    validated: boolean;
    inactive: boolean;
  }
) {
  const size = 18;
  let bg = '#ef4444'; // rouge
  let gradient = '';

  if (opts.usingDefault) {
    if (opts.validated) {
      bg = '#f59e0b'; // orange
    } else {
      gradient = 'linear-gradient(90deg, #f59e0b 50%, #9ca3af 50%)'; // orange+gris
      bg = 'transparent';
    }
  }

  const halo = opts.inactive ? '0 0 0 3px #9ca3af' : '0 0 0 0 transparent';

  const html = `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${bg};
      ${gradient ? `background:${gradient};` : ''}
      border:1px solid rgba(0,0,0,0.35);
      box-shadow:${halo};
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

  // debug & progression
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [okCount, setOkCount] = useState(0);
  const [failCount, setFailCount] = useState(0);
  const [lastError, setLastError] = useState<string>('');

  const [radius, setRadius] = useState(DEFAULT_RADIUS_KM);
  const [candidate, setCandidate] = useState('');
  const [nearby, setNearby] = useState<Customer[]>([]);
  const mapRef = useRef<any>(null);
  const circleRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);

  // init map
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const L = require('leaflet');
    const m = L.map('map').setView([48.8566, 2.3522], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(m);
    mapRef.current = m;
    return () => m.remove();
  }, []);

  // charge clients + géocode 1 par 1 (évite timeouts vercel)
  useEffect(() => {
    (async () => {
      const key = new URLSearchParams(window.location.search).get('key') || '';

      // 1) charge les clients
      const r = await fetch(`/api/customers?key=${encodeURIComponent(key)}`);
      const baseJson = await r.json().catch(() => null);
      if (!Array.isArray(baseJson)) {
        setLastError('Erreur /api/customers (réponse non JSON array)');
        setLoading(false);
        return;
      }
      const base = baseJson as Customer[];
      setProgress({ done: 0, total: base.length });

      // 2) géocode 1 par 1 (pause ~1.1s pour OpenCage)
      for (let i = 0; i < base.length; i++) {
        const b = base[i];

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

        setProgress({ done: i + 1, total: base.length });

        // montrer dès le 1er point
        if (i === 0) setLoading(false);

        // respecte OpenCage (~1 req/s)
        await new Promise((rr) => setTimeout(rr, 1100));
      }
    })();
  }, []);

  // dessine les marqueurs
  useEffect(() => {
    if (!mapRef.current) return;

    // clear old
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
      ) {
        continue;
      }

      const icon = makeIcon(L, {
        usingDefault: c.addressSource === 'default',
        validated: !!c.wholesale,
        inactive: isInactive(c.lastOrderAt),
      });

      const marker = L.marker([c.lat, c.lng], { icon });
      marker.bindPopup(
        `<b>${c.name}</b><br>${c.address}` +
          (c.lastOrderAt
            ? `<br>Dernière commande : ${new Date(c.lastOrderAt).toLocaleDateString()}`
            : `<br>Jamais commandé`) +
          (c.addressSource === 'default'
            ? `<br><i>Adresse non confirmée (adresse principale Shopify)</i>`
            : '') +
          (!c.wholesale ? `<br><i>Profil wholesale non validé</i>` : '')
      );
      marker.addTo(mapRef.current);
      markersRef.current.push(marker);
    }
  }, [customers]);

  async function checkCandidate() {
    const key = new URLSearchParams(window.location.search).get('key') || '';
    const r = await fetch(`/api/geocode?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: candidate }),
    });
    if (!r.ok) {
      alert('Adresse introuvable');
      return;
    }
    const pt: any = await r.json().catch(() => null);
    if (
      !pt ||
      typeof pt.lat !== 'number' ||
      typeof pt.lng !== 'number' ||
      Number.isNaN(pt.lat) ||
      Number.isNaN(pt.lng)
    ) {
      alert('Adresse introuvable');
      return;
    }

    const L = require('leaflet');
    if (circleRef.current) {
      circleRef.current.remove();
      circleRef.current = null;
    }
    circleRef.current = L.circle([pt.lat, pt.lng], { radius: radius * 1000 }).addTo(mapRef.current);
    mapRef.current.setView([pt.lat, pt.lng], 13);

    const hits = customers
      .filter(
        (c) =>
          typeof c.lat === 'number' &&
          typeof c.lng === 'number' &&
          !Number.isNaN(c.lat) &&
          !Number.isNaN(c.lng)
      )
      .map((c) => ({
        ...c,
        dist: haversineKm({ lat: pt.lat, lng: pt.lng }, { lat: c.lat!, lng: c.lng! }),
      }))
      .filter((c) => (c.dist as number) <= radius)
      .sort((a, b) => (a.dist as number) - (b.dist as number));

    setNearby(hits);
  }

  const Legend = () => (
    <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 12, flexWrap: 'wrap' }}>
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
        Adresse confirmée (custom.address)
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
        Validé — <b>Adresse non confirmée</b> (adresse principale)
      </span>
      <span>
        <i
          style={{
            display: 'inline-block',
            width: 12,
            height: 12,
            borderRadius: 999,
            background: 'linear-gradient(90deg, #f59e0b 50%, #9ca3af 50%)',
            border: '1px solid rgba(0,0,0,0.35)',
            marginRight: 6,
          }}
        />
        Non validé — <b>Adresse non confirmée</b> (adresse principale)
      </span>
      <span>
        <i
          style={{
            display: 'inline-block',
            width: 12,
            height: 12,
            borderRadius: 999,
            background: '#fff',
            border: '1px solid rgba(0,0,0,0.35)',
            boxShadow: '0 0 0 3px #9ca3af',
            marginRight: 6,
          }}
        />
        Halo gris : pas de commande depuis + de 2 ans
      </span>
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
        }}
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={candidate}
            onChange={(e) => setCandidate(e.target.value)}
            placeholder="Nouvelle adresse client"
            style={{ padding: 8, width: 320 }}
          />
          <label>
            Rayon (km):{' '}
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={radius}
              onChange={(e) => setRadius(parseFloat(e.target.value))}
              style={{ width: 80, padding: 6 }}
            />
          </label>
          <button onClick={checkCandidate} style={{ padding: '8px 12px' }}>
            Vérifier proximité
          </button>
        </div>

        <div style={{ marginTop: 8, maxWidth: 560 }}>
          {loading
            ? `Chargement… (${progress.done}/${progress.total})`
            : nearby.length
            ? (
              <div>
                <b>{nearby.length} revendeur(s) dans {radius} km :</b>
                <ul>
                  {nearby.map((h, i) => (
                    <li key={i}>
                      {h.dist!.toFixed(2)} km — <b>{h.name}</b> — {h.address}
                    </li>
                  ))}
                </ul>
              </div>
            )
            : 'Aucun revendeur proche pour l’instant.'}

          {progress.total > 0 && (
            <>
              <div style={{ marginTop: 6, width: 280, height: 6, background: '#eee', borderRadius: 4 }}>
                <div
                  style={{
                    width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                    height: '100%',
                    borderRadius: 4,
                    background: '#60a5fa',
                  }}
                />
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: '#444' }}>
                OK: <b>{okCount}</b> — Échecs: <b>{failCount}</b>
                {lastError && (
                  <div style={{ marginTop: 4, color: '#b91c1c' }}>
                    Dernière erreur: {lastError}
                  </div>
                )}
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