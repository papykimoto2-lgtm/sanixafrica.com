'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import type { Map as CarteMapLibre } from 'maplibre-gl';
import { api } from '@/lib/api';
import { Erreur } from '@/components/ui';

const COUCHES = [
  ['zones', 'Zones fiscales'],
  ['parcelles', 'Parcelles'],
  ['batiments', 'Bâtiments'],
] as const;

export default function Carte() {
  const conteneur = useRef<HTMLDivElement>(null);
  const carte = useRef<CarteMapLibre | null>(null);
  const donnees = useRef<any>(null);
  const [visibles, setVisibles] = useState<Record<string, boolean>>({ zones: false, parcelles: true, batiments: true });
  const [recherche, setRecherche] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let detruite = false;
    (async () => {
      const maplibregl = (await import('maplibre-gl')).default;
      const [parcelles, batiments, zones, territoires] = await Promise.all([
        api('/cartographie/parcelles'), api('/cartographie/batiments'),
        api('/cartographie/zones-fiscales'), api('/cartographie/territoires'),
      ]).catch((e) => { setErreur(e.message); return []; });
      if (detruite || !conteneur.current || !parcelles) return;
      donnees.current = parcelles;

      const m = new maplibregl.Map({
        container: conteneur.current,
        style: {
          version: 8,
          sources: {
            osm: {
              type: 'raster', tileSize: 256, maxzoom: 19,
              tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
              attribution: '© contributeurs OpenStreetMap',
            },
          },
          layers: [{ id: 'fond', type: 'raster', source: 'osm' }],
        },
        bounds: emprise(parcelles),
        fitBoundsOptions: { padding: 40, maxZoom: 18 },
      });
      carte.current = m;
      m.addControl(new maplibregl.NavigationControl(), 'top-right');
      m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));

      m.on('load', () => {
        m.addSource('territoires', { type: 'geojson', data: territoires });
        m.addSource('zones', { type: 'geojson', data: zones });
        m.addSource('parcelles', { type: 'geojson', data: parcelles });
        m.addSource('batiments', { type: 'geojson', data: batiments });

        m.addLayer({ id: 'territoires', type: 'line', source: 'territoires', paint: { 'line-color': '#5a6762', 'line-width': 2, 'line-dasharray': [3, 2] } });
        m.addLayer({ id: 'zones', type: 'fill', source: 'zones', layout: { visibility: 'none' },
          paint: { 'fill-color': ['interpolate', ['linear'], ['get', 'coefficient'], 1, '#9ec5fe', 1.5, '#3d5afe'], 'fill-opacity': 0.25 } });
        m.addLayer({ id: 'parcelles', type: 'fill', source: 'parcelles', paint: {
          'fill-color': ['case', ['>=', ['get', 'nb_anomalies'], 2], '#d92d20', ['>=', ['get', 'nb_anomalies'], 1], '#f79009', '#12b76a'],
          'fill-opacity': 0.35 } });
        m.addLayer({ id: 'parcelles-contour', type: 'line', source: 'parcelles', paint: { 'line-color': '#0b5d3b', 'line-width': 1 } });
        m.addLayer({ id: 'batiments', type: 'fill', source: 'batiments', paint: { 'fill-color': '#344054', 'fill-opacity': 0.6 } });

        m.on('click', 'parcelles', (e) => {
          const p = e.features?.[0]?.properties as any;
          if (!p) return;
          new maplibregl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(`<strong>${p.snifi_id}</strong><br/>${p.quartier ?? ''}<br/>${p.proprietaires ?? 'Propriétaire non renseigné'}<br/>
              Superficie : ${Number(p.superficie_m2).toLocaleString('fr-FR')} m²<br/>
              Bâtiments : ${p.nb_batiments} · Anomalies : ${p.nb_anomalies}<br/>
              <a href="/parcelles/${p.id}">Ouvrir la fiche →</a>`)
            .addTo(m);
        });
        m.on('mouseenter', 'parcelles', () => { m.getCanvas().style.cursor = 'pointer'; });
        m.on('mouseleave', 'parcelles', () => { m.getCanvas().style.cursor = ''; });
      });
    })();
    return () => { detruite = true; carte.current?.remove(); };
  }, []);

  useEffect(() => {
    const m = carte.current;
    if (!m || !m.isStyleLoaded()) return;
    for (const [id] of COUCHES) {
      for (const couche of id === 'parcelles' ? ['parcelles', 'parcelles-contour'] : [id]) {
        if (m.getLayer(couche)) m.setLayoutProperty(couche, 'visibility', visibles[id] ? 'visible' : 'none');
      }
    }
  }, [visibles]);

  function cadrer(commune?: string) {
    const fc = donnees.current;
    if (!fc) return;
    const features = fc.features.filter((f: any) => !commune || f.properties.commune === commune);
    if (features.length) carte.current?.fitBounds(emprise({ features }), { padding: 40, maxZoom: 18 });
  }

  function chercher() {
    const q = recherche.trim().toLowerCase();
    const f = donnees.current?.features.find((x: any) =>
      x.properties.snifi_id.toLowerCase().includes(q) || String(x.properties.proprietaires ?? '').toLowerCase().includes(q) ||
      String(x.properties.quartier ?? '').toLowerCase().includes(q));
    if (!f) return setErreur(`Aucune parcelle ne correspond à « ${recherche} »`);
    setErreur(null);
    const anneau = f.geometry.coordinates[0][0];
    const lon = anneau.reduce((s: number, c: number[]) => s + c[0], 0) / anneau.length;
    const lat = anneau.reduce((s: number, c: number[]) => s + c[1], 0) / anneau.length;
    carte.current?.flyTo({ center: [lon, lat], zoom: 18.5 });
  }

  return (
    <>
      <h1>Cartographie fiscale</h1>
      <div className="barre-outils">
        <input placeholder="Identifiant SNIFI, propriétaire, quartier…" value={recherche}
               onChange={(e) => setRecherche(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && chercher()} style={{ width: 320 }} />
        <button onClick={chercher}>Rechercher</button>
        <span style={{ flex: 1 }} />
        {COUCHES.map(([id, lib]) => (
          <label key={id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={visibles[id]} onChange={(e) => setVisibles({ ...visibles, [id]: e.target.checked })} /> {lib}
          </label>
        ))}
        <button className="secondaire" onClick={() => cadrer('CI-ABJ-YOP')}>Yopougon</button>
        <button className="secondaire" onClick={() => cadrer('CI-ABJ-COC')}>Cocody</button>
        <button className="secondaire" onClick={() => cadrer()}>Tout</button>
      </div>
      <div className="legende">
        <span style={{ ['--c' as any]: '#12b76a' }}>Sans anomalie</span>
        <span style={{ ['--c' as any]: '#f79009' }}>1 anomalie</span>
        <span style={{ ['--c' as any]: '#d92d20' }}>2 anomalies ou plus</span>
        <span style={{ ['--c' as any]: '#344054' }}>Bâtiment</span>
      </div>
      <Erreur message={erreur} />
      <div ref={conteneur} className="carte-map" />
    </>
  );
}

/** Emprise [[ouest, sud], [est, nord]] d'une collection de polygones. */
function emprise(fc: { features: any[] }): [[number, number], [number, number]] {
  let o = 180, s = 90, e = -180, n = -90;
  for (const f of fc.features) {
    for (const poly of f.geometry.coordinates) for (const anneau of poly) for (const [x, y] of anneau) {
      o = Math.min(o, x); s = Math.min(s, y); e = Math.max(e, x); n = Math.max(n, y);
    }
  }
  return fc.features.length ? [[o, s], [e, n]] : [[-8.6, 4.3], [-2.5, 10.7]];  // Côte d'Ivoire par défaut
}
