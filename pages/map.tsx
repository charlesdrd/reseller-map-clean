import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';

type Customer = {
  name: string;
  address: string;
  lat?: number;
  lng?: number;
  lastOrderAt?: string | null;
  wholesale?: string | null;
  dist?: number;
};

const DEFAULT_RADIUS_KM = 1;

function haversineKm(a:{lat:number;lng:number}, b:{lat:number;lng:number}){
  const toRad = (d:number)=> d*Math.PI/180;
  const R = 6371;
  const dLat = toRad(b.lat-a.lat), dLng = toRad(b.lng-a.lng);
  const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}

function statusColor(c: Customer): {stroke:string; fill:string; label:string} {
  const grey = { stroke: '#6b7280', fill: '#9ca3af', label: 'Pas de commande depuis + de 2 ans' };
  const yellow = { stroke: '#b45309', fill: '#facc15', label: 'En attente de validation' };
  const red = { stroke: '#991b1b', fill: '#ef4444', label: 'Actif' };

  // Priorité: gris (inactif) > jaune (wholesale vide) > rouge
  const twoYearsAgo = new Date(); twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const last = c.lastOrderAt ? new Date(c.lastOrderAt) : null;
  const inactive = !last || last < twoYearsAgo;

  if (inactive) return grey;
  if (!c.wholesale || String(c.wholesale).trim() === '') return yellow;
  return red;
}

export default function MapPage(){
  const [customers,setCustomers] = useState<Customer[]>([]);
  const [loading,setLoading] = useState(true);
  const [radius,setRadius] = useState(DEFAULT_RADIUS_KM);
  const [candidate,setCandidate] = useState('');
  const [nearby,setNearby] = useState<Customer[]>([]);
  const mapRef = useRef<any>(null);
  const circleRef = useRef<any>(null);

  // init map
  useEffect(()=>{
    if (typeof window === 'undefined') return;
    const L = require('leaflet');
    const m = L.map('map').setView([48.8566, 2.3522], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(m);
    mapRef.current = m;
    return ()=> m.remove();
  },[]);

  // load customers + geocode server
  useEffect(()=>{
    (async ()=>{
      const key = new URLSearchParams(window.location.search).get('key') || '';
      const r = await fetch(`/api/customers?key=${encodeURIComponent(key)}`);
      if (!r.ok) { setLoading(false); return; }
      const base = await r.json() as Customer[];
      const addresses = base.map(b => b.address);
      const g = await fetch(`/api/geocode?key=${encodeURIComponent(key)}`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ addresses })
      });
      const coords = await g.json() as {address:string,lat:number,lng:number}[];
      const merged = base.map(b=>{
        const m = coords.find(c=> c.address === b.address);
        return m ? { ...b, lat:m.lat, lng:m.lng } : b;
      }).filter(b => typeof b.lat === 'number' && typeof b.lng === 'number');
      setCustomers(merged);
      setLoading(false);
    })();
  },[]);

  // draw markers with colors
  useEffect(()=>{
    if (!mapRef.current || !customers.length) return;
    const L = require('leaflet');
    customers.forEach(c => {
      const color = statusColor(c);
      const marker = L.circleMarker([c.lat!, c.lng!], {
        radius: 8, color: color.stroke, weight: 1,
        fillColor: color.fill, fillOpacity: 0.95
      });
      marker.bindPopup(
        `<b>${c.name}</b><br>${c.address}` +
        (c.lastOrderAt ? `<br>Dernière commande : ${new Date(c.lastOrderAt).toLocaleDateString()}` : `<br>Jamais commandé`) +
        (c.wholesale ? '' : `<br><i>En attente de validation</i>`)
      );
      marker.addTo(mapRef.current);
    });
  },[customers]);

  async function checkCandidate(){
    const key = new URLSearchParams(window.location.search).get('key') || '';
    const r = await fetch(`/api/geocode?key=${encodeURIComponent(key)}`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ addresses: [candidate] })
    });
    const j = await r.json();
    const pt = j?.[0];
    if (!pt) { alert('Adresse introuvable'); return; }

    const L = require('leaflet');
    if (circleRef.current) { circleRef.current.remove(); circleRef.current = null; }
    circleRef.current = L.circle([pt.lat, pt.lng], { radius: radius*1000 }).addTo(mapRef.current);
    mapRef.current.setView([pt.lat, pt.lng], 13);

    const hits = customers
      .map(c => ({ ...c, dist: haversineKm({lat:pt.lat,lng:pt.lng}, {lat:c.lat!, lng:c.lng!}) }))
      .filter(c => c.dist! <= radius)
      .sort((a,b)=> a.dist! - b.dist!);

    setNearby(hits);
  }

  // petite légende
  const Legend = () => (
    <div style={{display:'flex', gap:12, marginTop:6, fontSize:12}}>
      <span><i style={{display:'inline-block',width:10,height:10,borderRadius:999,background:'#ef4444',border:'1px solid #991b1b',marginRight:6}}/>Actif</span>
      <span><i style={{display:'inline-block',width:10,height:10,borderRadius:999,background:'#facc15',border:'1px solid #b45309',marginRight:6}}/>En attente de validation</span>
      <span><i style={{display:'inline-block',width:10,height:10,borderRadius:999,background:'#9ca3af',border:'1px solid #6b7280',marginRight:6}}/>Pas de commande depuis + de 2 ans</span>
    </div>
  );

  return (
    <>
      <Head>
        <title>Carte des revendeurs</title>
        <link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css"/>
      </Head>

      <div style={{position:'absolute', zIndex:1000, left:10, top:10, background:'#fff', padding:10, borderRadius:8, boxShadow:'0 2px 8px rgba(0,0,0,0.15)'}}>
        <div style={{display:'flex', gap:8, flexWrap:'wrap', alignItems:'center'}}>
          <input value={candidate} onChange={e=>setCandidate(e.target.value)} placeholder="Nouvelle adresse client" style={{padding:8, width:320}}/>
          <label>Rayon (km): <input type="number" min={0.1} step={0.1} value={radius} onChange={e=>setRadius(parseFloat(e.target.value))} style={{width:80, padding:6}}/></label>
          <button onClick={checkCandidate} style={{padding:'8px 12px'}}>Vérifier proximité</button>
        </div>
        <div style={{marginTop:8, maxWidth:520}}>
          {loading ? 'Chargement...' :
            (nearby.length
              ? (<div><b>{nearby.length} revendeur(s) dans {radius} km :</b><ul>{nearby.map((h,i)=>(<li key={i}>{h.dist!.toFixed(2)} km — <b>{h.name}</b> — {h.address}</li>))}</ul></div>)
              : 'Aucun revendeur proche pour l’instant.'
            )
          }
        </div>
        <Legend />
      </div>

      <div id="map" style={{height:'100vh'}}/>
    </>
  );
}
