import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

// --- Helper Functions ---
const wgs84ToLv95 = (lat, lng) => {
    const phi = (lat * 3600 - 169028.66) / 10000;
    const lam = (lng * 3600 - 26782.5) / 10000;
    const E = 2600072.37 + 211455.93 * lam - 10938.51 * lam * phi - 0.36 * lam * Math.pow(phi, 2) - 44.54 * Math.pow(lam, 3);
    const N = 1200147.07 + 308807.95 * phi + 3745.25 * Math.pow(lam, 2) + 76.63 * Math.pow(phi, 2) - 194.56 * Math.pow(lam, 2) * phi + 119.79 * Math.pow(phi, 3);
    return [E, N];
};

const lv95ToWgs84 = (e, n) => {
    const y = (e - 2600000) / 1000000;
    const x = (n - 1200000) / 1000000;
    const lam = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
    const phi = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x + 0.0447 * y * y * x - 0.0140 * x * x * x;
    return { lat: phi * 100 / 36, lng: lam * 100 / 36 };
};

const calculateFresnelRadius = (d1, dTotal, freqGHz) => {
  if (freqGHz <= 0 || d1 === 0 || d1 >= dTotal) return 0;
  const d2 = dTotal - d1;
  return 17.32 * Math.sqrt((d1 * d2) / (dTotal * freqGHz));
};

const calculateFSPL = (distanceKm, freqGHz) => {
    if (distanceKm <= 0) return 0;
    return 92.45 + 20 * Math.log10(distanceKm) + 20 * Math.log10(freqGHz);
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Global Shared State for Throttling & Tracking ---
const tileQueue = [];
let isTileQueueRunning = false;
let globalTileCount = 0;

function App() {
  // --- State ---
  const [txHeight, setTxHeight] = useState(30);
  const [rxHeight, setRxHeight] = useState(10);
  const [freq, setFreq] = useState(5.8);
  const [isPanelExpanded, setIsPanelExpanded] = useState(false);
  const [mapLayer, setMapLayer] = useState('topo');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isDebugOpen, setIsDebugOpen] = useState(false);
  const [debugLog, setDebugLog] = useState([]);
  const [apiReqCount, setApiReqCount] = useState({ profile: 0, height: 0, search: 0, wmts: 0 });
  const [tileMemoryEst, setTileMemoryEst] = useState(0);
  const reqTimestamps = useRef([]);

  const mapRef = useRef(null);
  const leafletMap = useRef(null);
  const tileLayersRef = useRef({});
  const markersRef = useRef({ tx: null, rx: null });
  const polylineRef = useRef(null);
  const heatmapLayerRef = useRef(null);

  const [elevationData, setElevationData] = useState(null);
  const [linkStats, setLinkStats] = useState({ distance: 0, fspl: 0, obstruction: null, margin: 0, rxLosCeiling: 0 });
  const [loading, setLoading] = useState(false);
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [needsAnalysis, setNeedsAnalysis] = useState(false);

  const defaultTx = [46.818, 8.227];
  const defaultRx = [46.858, 8.267];

  // --- Debug & API Tracking ---
  const logDebug = (msg, isError = false) => {
      setDebugLog(prev => [...prev.slice(-4), { msg, isError, time: new Date().toLocaleTimeString() }]);
      if (isError) setIsDebugOpen(true);
  };

  const trackApiRequest = useCallback((type) => {
      const now = Date.now();
      reqTimestamps.current.push({ type, time: now });
      reqTimestamps.current = reqTimestamps.current.filter(t => now - t.time < 60000);
      const counts = reqTimestamps.current.reduce((acc, curr) => {
          acc[curr.type] = (acc[curr.type] || 0) + 1;
          return acc;
      }, { profile: 0, height: 0, search: 0, wmts: 0 });
      setApiReqCount(counts);
  }, []);

  useEffect(() => {
      let interval;
      if (isDebugOpen) {
          interval = setInterval(() => {
               setTileMemoryEst((Math.max(0, globalTileCount) * 0.25).toFixed(1));
          }, 1000);
      }
      return () => clearInterval(interval);
  }, [isDebugOpen]);

  // --- Tile Queue Processor ---
  const processTileQueue = async () => {
      if (isTileQueueRunning) return;
      isTileQueueRunning = true;
      while (tileQueue.length > 0) {
          const task = tileQueue.shift();
          if (task && task.img) {
               task.img.src = task.url;
               trackApiRequest('wmts');
               // Throttled to 75ms between tile requests (~13 tiles/sec max)
               await sleep(75);
          }
      }
      isTileQueueRunning = false;
  };

  // --- Load Leaflet ---
  useEffect(() => {
      if (window.L && typeof window.L.map === 'function') { setMapReady(true); return; }
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(link);
      const script = document.createElement('script'); script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; script.async = true;
      script.onload = () => { if (window.L && typeof window.L.map === 'function') setMapReady(true); };
      document.head.appendChild(script);
  }, []);

  // --- Initialize Map ---
  useEffect(() => {
    if (mapReady && mapRef.current && !leafletMap.current && window.L) {
        const L = window.L;
        try {
            leafletMap.current = L.map(mapRef.current, { zoomControl: false, attributionControl: false }).setView([46.838, 8.247], 13);
            
            const ThrottledTileLayer = L.TileLayer.extend({
                createTile: function(coords, done) {
                    const tile = document.createElement('img');
                    L.DomEvent.on(tile, 'load', L.bind(this._tileOnLoad, this, done, tile));
                    L.DomEvent.on(tile, 'error', L.bind(this._tileOnError, this, done, tile));
                    if (this.options.crossOrigin || this.options.crossOrigin === '') tile.crossOrigin = this.options.crossOrigin === true ? '' : this.options.crossOrigin;
                    tile.alt = ''; tile.setAttribute('role', 'presentation');
                    
                    globalTileCount++;
                    const url = this.getTileUrl(coords);
                    tileQueue.push({ img: tile, url });
                    processTileQueue();
                    return tile;
                }
            });

            // Increased buffer to 400 and updateInterval to 300ms
            const tileOpts = {
                maxZoom: 19,
                keepBuffer: 500,
                updateWhenIdle: true,
                updateInterval: 800,
                unloadInvisibleTiles: false
            };

            tileLayersRef.current.topo = new ThrottledTileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg', tileOpts);
            tileLayersRef.current.satellite = new ThrottledTileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg', tileOpts);
            
            tileLayersRef.current.topo.on('tileunload', () => globalTileCount--);
            tileLayersRef.current.satellite.on('tileunload', () => globalTileCount--);

            tileLayersRef.current[mapLayer].addTo(leafletMap.current);

            heatmapLayerRef.current = L.layerGroup().addTo(leafletMap.current);

            const style = document.createElement('style');
            style.textContent = `@keyframes pulse-ring { 0% { transform: scale(0.33); opacity: 1; } 80%, 100% { opacity: 0; } } .heatmap-center-pulse { position: relative; } .heatmap-center-pulse::before { content: ''; position: absolute; left: -6px; top: -6px; width: 12px; height: 12px; border-radius: 50%; background-color: white; animation: pulse-ring 1.5s cubic-bezier(0.215, 0.61, 0.355, 1) infinite; }`;
            document.head.appendChild(style);

            const createIcon = (color, label) => L.divIcon({ className: 'custom-marker', html: `<div style="background-color: ${color}; width: 24px; height: 24px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; font-weight: bold; color: white; font-size: 10px;">${label}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });

            markersRef.current.tx = L.marker(defaultTx, { draggable: true, icon: createIcon('#2563eb', 'Tx'), zIndexOffset: 1000 }).addTo(leafletMap.current);
            markersRef.current.rx = L.marker(defaultRx, { draggable: true, icon: createIcon('#dc2626', 'Rx'), zIndexOffset: 1000 }).addTo(leafletMap.current);
            polylineRef.current = L.polyline([defaultTx, defaultRx], { color: '#64748b', weight: 4, opacity: 0.6, dashArray: '5, 10', lineCap: 'round' }).addTo(leafletMap.current);

            const clearAnalysis = () => {
                 polylineRef.current.setLatLngs([markersRef.current.tx.getLatLng(), markersRef.current.rx.getLatLng()]);
                 polylineRef.current.setStyle({ color: '#64748b', dashArray: '5, 10', opacity: 0.6 });
                 setLinkStats(prev => ({ ...prev, obstruction: null }));
                 heatmapLayerRef.current.clearLayers();
            };
            markersRef.current.tx.on('drag', clearAnalysis);
            markersRef.current.rx.on('drag', clearAnalysis);
        } catch (err) { console.error("Map init error:", err); logDebug("Map init error: " + err.message, true); }
    }
    return () => { if (leafletMap.current) { leafletMap.current.remove(); leafletMap.current = null; } };
  }, [mapReady]);

  useEffect(() => {
      if (leafletMap.current && tileLayersRef.current.topo && tileLayersRef.current.satellite) {
          leafletMap.current.removeLayer(tileLayersRef.current[mapLayer === 'topo' ? 'satellite' : 'topo']);
          tileLayersRef.current[mapLayer].addTo(leafletMap.current);
      }
  }, [mapLayer]);

  // --- Search Logic ---
  useEffect(() => {
      const delayDebounceFn = setTimeout(async () => {
          if (searchQuery.length > 2) {
              try {
                  trackApiRequest('search');
                  const response = await fetch(`https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=${encodeURIComponent(searchQuery)}&type=locations&limit=5`);
                  if (!response.ok) throw new Error(`Search failed: ${response.status}`);
                  const data = await response.json();
                  setSearchResults(data.results || []);
              } catch (error) { setSearchResults([]); }
          } else { setSearchResults([]); }
      }, 300);
      return () => clearTimeout(delayDebounceFn);
  }, [searchQuery]);

  const handleSearchResultClick = (result) => {
      setIsSearchOpen(false); setSearchQuery('');
      if (leafletMap.current && result.attrs) {
          const newCenter = [result.attrs.lat, result.attrs.lon];
          leafletMap.current.setView(newCenter, 14);
          const newTx = [result.attrs.lat, result.attrs.lon - 0.005];
          const newRx = [result.attrs.lat, result.attrs.lon + 0.005];
          markersRef.current.tx.setLatLng(newTx);
          markersRef.current.rx.setLatLng(newRx);
          polylineRef.current.setLatLngs([newTx, newRx]);
          polylineRef.current.setStyle({ color: '#64748b', dashArray: '5, 10', opacity: 0.6 });
          setLinkStats(prev => ({ ...prev, obstruction: null }));
          heatmapLayerRef.current.clearLayers();
          setElevationData(null);
      }
  };

  // --- Marker Swap Logic ---
  const handleSwapMarkers = () => {
      if (markersRef.current.tx && markersRef.current.rx) {
          const txPos = markersRef.current.tx.getLatLng();
          const rxPos = markersRef.current.rx.getLatLng();
          markersRef.current.tx.setLatLng(rxPos);
          markersRef.current.rx.setLatLng(txPos);
          const oldTxHeight = txHeight;
          setTxHeight(rxHeight);
          setRxHeight(oldTxHeight);
          polylineRef.current.setLatLngs([rxPos, txPos]);
          polylineRef.current.setStyle({ color: '#64748b', dashArray: '5, 10', opacity: 0.6 });
          setLinkStats(prev => ({ ...prev, obstruction: null }));
          heatmapLayerRef.current.clearLayers();
          setElevationData(null);
      }
  };

  // --- Analysis Logic ---
  const analyzePath = useCallback(async () => {
      if (!leafletMap.current || !markersRef.current.tx || !markersRef.current.rx) return;
      setLoading(true);
      heatmapLayerRef.current.clearLayers();
      const txLL = markersRef.current.tx.getLatLng();
      const rxLL = markersRef.current.rx.getLatLng();
      const txLV95 = wgs84ToLv95(txLL.lat, txLL.lng);
      const rxLV95 = wgs84ToLv95(rxLL.lat, rxLL.lng);

      try {
          trackApiRequest('profile');
          const response = await fetch(`https://api3.geo.admin.ch/rest/services/profile.json?geom=${JSON.stringify({ type: "LineString", coordinates: [txLV95, rxLV95] })}&sr=2056&nb_points=500`);
          if (!response.ok) throw new Error(`Profile API failed: ${response.status}`);
          const data = await response.json();
          if (Array.isArray(data) && data.length > 0) {
              const stats = processProfileData(data);
              calculateHeatmap(rxLV95, rxLL, stats.margin);
          } else {
               logDebug("Invalid profile data received", true);
               setLoading(false);
          }
      } catch (e) { console.error(e); logDebug(e.message, true); setLoading(false); }
  }, [txHeight, rxHeight, freq]);

  useEffect(() => { if (needsAnalysis) { analyzePath(); setNeedsAnalysis(false); } }, [needsAnalysis, analyzePath]);

  const processProfileData = (data) => {
      const totalDistKm = data[data.length - 1].dist / 1000;
      const txAbs = data[0].alts.COMB + parseFloat(txHeight || 0);
      const rxAbs = data[data.length - 1].alts.COMB + parseFloat(rxHeight || 0);
      let maxMargin = -Infinity;
      const processed = data.map(p => {
          const dKm = p.dist / 1000;
          const los = txAbs - ((txAbs - rxAbs) * (dKm / totalDistKm));
          const fRad = calculateFresnelRadius(dKm, totalDistKm, parseFloat(freq || 5.8));
          const f60 = los - (fRad * 0.6);
          const margin = p.alts.COMB - f60;
          if (margin > maxMargin) maxMargin = margin;
          return { distKm: dKm.toFixed(2), terrain: p.alts.COMB, los: los, fresnel: f60 };
      });
      const isObstructed = maxMargin > 0;
      if (polylineRef.current) polylineRef.current.setStyle({ color: isObstructed ? '#dc2626' : '#10b981', dashArray: null, opacity: 0.9 });
      const newStats = { distance: totalDistKm.toFixed(2), fspl: calculateFSPL(totalDistKm, parseFloat(freq || 5.8)).toFixed(1), obstruction: isObstructed, margin: (-maxMargin).toFixed(1) };
      setLinkStats(newStats);
      setElevationData(processed);
      setLoading(false);
      if (window.innerWidth < 768) setIsPanelExpanded(true);
      return newStats;
  };

  const calculateHeatmap = async (rxLV95, rxLL_original, centerMargin) => {
      setHeatmapLoading(true);
      const L = window.L;
      const gridRadius = 30; const step = 30;
      const [rxE, rxN] = rxLV95;
      const pointsToFetch = [];
      for (let x = -gridRadius; x <= gridRadius; x += step) {
          for (let y = -gridRadius; y <= gridRadius; y += step) {
              pointsToFetch.push({ e: rxE + x, n: rxN + y, isCenter: (x === 0 && y === 0) });
          }
      }

      try {
         const centerApproxWgs = lv95ToWgs84(rxE, rxN);
         const latOffset = rxLL_original.lat - centerApproxWgs.lat;
         const lngOffset = rxLL_original.lng - centerApproxWgs.lng;
         let centerHeight = null;
         const baseMargin = parseFloat(centerMargin);

         for (const pt of pointsToFetch) {
             try {
                 trackApiRequest('height');
                 const res = await fetch(`https://api3.geo.admin.ch/rest/services/height?easting=${pt.e}&northing=${pt.n}`);
                 if (res.ok) {
                     const data = await res.json();
                     pt.height = parseFloat(data.height);
                     if (pt.isCenter) centerHeight = pt.height;
                 }
             } catch (e) { console.warn("Height fetch failed for point", pt); }
             // Increased throttle to 250ms for heatmap requests
             await sleep(250);
         }

         if (centerHeight === null) centerHeight = pointsToFetch.find(p => !isNaN(p.height))?.height || 0;

         pointsToFetch.forEach(pt => {
             if (isNaN(pt.height)) return;
             const estimatedMargin = baseMargin + (pt.height - centerHeight);
             let color = '#eab308';
             if (estimatedMargin > 2) color = '#10b981';
             else if (estimatedMargin < 0) color = '#dc2626';

             const approxWgs = lv95ToWgs84(pt.e, pt.n);
             const finalLat = approxWgs.lat + latOffset;
             const finalLng = approxWgs.lng + lngOffset;

             const circle = L.circleMarker([finalLat, finalLng], {
                 radius: pt.isCenter ? 8 : 6,
                 color: pt.isCenter ? 'white' : 'rgba(255,255,255,0.5)',
                 weight: pt.isCenter ? 3 : 1,
                 fillColor: color,
                 fillOpacity: pt.isCenter ? 1 : 0.7,
                 className: pt.isCenter ? 'heatmap-center-pulse' : 'heatmap-point'
             }).addTo(heatmapLayerRef.current);

             circle.on('click', () => {
                 if (!pt.isCenter && markersRef.current.rx && polylineRef.current) {
                     const newRxLL = L.latLng(finalLat, finalLng);
                     markersRef.current.rx.setLatLng(newRxLL);
                     polylineRef.current.setLatLngs([markersRef.current.tx.getLatLng(), newRxLL]);
                     setNeedsAnalysis(true);
                 }
             });
         });
      } catch (err) { console.error("Heatmap error", err); logDebug("Heatmap calc error: " + err.message, true); }
      setHeatmapLoading(false);
  };

  // --- UI Helpers ---
  const getStatusColorClass = (margin, obstruction) => {
      if (obstruction === null) return 'bg-slate-100 text-slate-400';
      const m = parseFloat(margin);
      if (m < 0) return 'bg-red-100 text-[#DC0018]';
      if (m <= 2) return 'bg-yellow-100 text-yellow-600';
      return 'bg-emerald-100 text-emerald-600';
  };
  const getStatusText = (margin, obstruction) => {
       if (obstruction === null) return 'Ready to Analyze';
       const m = parseFloat(margin);
       if (m < 0) return 'Obstructed';
       if (m <= 2) return 'Marginal LOS';
       return 'Line of Sight';
  };
  const getStatusIcon = (margin, obstruction) => {
      if (obstruction === null) return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" /></svg>;
      const m = parseFloat(margin);
      if (m < 0) return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6"><path fillRule="evenodd" d="M5.47 5.47a.75.75 0 011.06 0L12 10.94l5.47-5.47a.75.75 0 111.06 1.06L13.06 12l5.47 5.47a.75.75 0 11-1.06 1.06L12 13.06l-5.47 5.47a.75.75 0 01-1.06-1.06L10.94 12 5.47 6.53a.75.75 0 010-1.06z" clipRule="evenodd" /></svg>;
      if (m <= 2) return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6"><path fillRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z" clipRule="evenodd" /></svg>;
      return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6"><path fillRule="evenodd" d="M19.916 4.626a.75.75 0 01.208 1.04l-9 13.5a.75.75 0 01-1.154.114l-6-6a.75.75 0 011.06-1.06l5.353 5.353 8.493-12.739a.75.75 0 011.04-.208z" clipRule="evenodd" /></svg>;
  }
  const chartOptions = { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false }, elements: { point: { radius: 0 } }, scales: { x: { display: true, grid: { display: false }, ticks: { maxTicksLimit: 5, color: '#94a3b8', font: { size: 10 } } }, y: { display: true, grid: { color: '#f1f5f9' }, ticks: { color: '#94a3b8', font: { size: 10 }, maxTicksLimit: 5 } } }, plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(255, 255, 255, 0.95)', titleColor: '#1e293b', bodyColor: '#334155', borderColor: '#e2e8f0', borderWidth: 1, padding: 10, callbacks: { label: (c) => `${c.dataset.label}: ${Number(c.parsed.y).toFixed(0)}m` } } } };
  const chartData = elevationData ? { labels: elevationData.map(d => d.distKm), datasets: [ { label: 'Terrain', data: elevationData.map(d => d.terrain), borderColor: '#64748b', backgroundColor: 'rgba(100, 116, 139, 0.2)', fill: true, borderWidth: 1.5 }, { label: '60% FZ', data: elevationData.map(d => d.fresnel), borderColor: 'rgba(220, 38, 38, 0.5)', borderDash: [4, 4], borderWidth: 1, fill: false }, { label: 'LOS', data: elevationData.map(d => d.los), borderColor: '#10b981', borderWidth: 1.5, fill: false } ] } : null;

  return (
    <div className="fixed inset-0 bg-slate-100 font-sans overflow-hidden touch-none">
      <div ref={mapRef} className="absolute inset-0 z-0" />
      {isDebugOpen && (<div className="absolute top-0 left-0 right-0 z-50 bg-slate-900/90 text-white p-2 text-[10px] font-mono pointer-events-none"><div className="flex justify-between items-start"><div className="space-y-1"><div className={apiReqCount.profile > 30 ? 'text-red-400 font-bold' : 'text-emerald-400'}>Profile: {apiReqCount.profile}/40 req/min</div><div className={apiReqCount.height > 30 ? 'text-red-400 font-bold' : 'text-emerald-400'}>Height: {apiReqCount.height}/40 req/min</div><div className={apiReqCount.search > 30 ? 'text-red-400 font-bold' : 'text-emerald-400'}>Search: {apiReqCount.search}/40 req/min</div><div className="text-slate-400">WMTS Tiles: {apiReqCount.wmts} (Limit: 1200/min)</div><div className="text-slate-400">Est. Tile Mem: {tileMemoryEst} MB</div></div><div className="text-right max-w-[50%]">{debugLog.length === 0 ? <span className="text-slate-500">No errors logged.</span> : debugLog.map((log, i) => (<div key={i} className={log.isError ? 'text-red-400' : 'text-slate-300'}>[{log.time}] {log.msg}</div>))}</div></div></div>)}
      <div className="absolute top-0 left-0 right-0 z-10 p-4 pointer-events-none flex justify-between items-start">
          <div className="bg-white/90 backdrop-blur-md shadow-sm rounded-full px-4 py-2 flex items-center space-x-2 pointer-events-auto"><div className="w-3 h-3 bg-[#DC0018] rounded-full"></div><span className="font-semibold text-slate-800 text-sm">RF-LOS-CH</span></div>
          <div className="flex flex-col space-y-3 items-end pointer-events-auto">
              <button onClick={() => setIsDebugOpen(!isDebugOpen)} className={`w-8 h-8 mb-2 rounded-full flex items-center justify-center transition-colors ${isDebugOpen ? 'bg-slate-800 text-white' : 'bg-white/50 text-slate-600 hover:bg-white/80'}`}><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M10 2a1 1 0 011 1v1.323l-1-.445-1 .445V3a1 1 0 011-1zm4 4a1 1 0 100 2 1 1 0 000-2zM5 6a1 1 0 100 2 1 1 0 000-2zm12 5a1 1 0 102 0 1 1 0 00-2 0zm-14 1a1 1 0 100 2 1 1 0 000-2zm12 5a1 1 0 102 0 1 1 0 00-2 0zm-14 1a1 1 0 100 2 1 1 0 000-2z" clipRule="evenodd" /></svg></button>
              <button onClick={() => setIsSearchOpen(!isSearchOpen)} className="w-12 h-12 bg-white/90 backdrop-blur-md rounded-full shadow-md flex items-center justify-center text-slate-700 active:scale-95 transition-transform"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6"><path fillRule="evenodd" d="M10.5 3.75a6.75 6.75 0 100 13.5 6.75 6.75 0 000-13.5zM2.25 10.5a8.25 8.25 0 1114.59 5.28l4.69 4.69a.75.75 0 11-1.06 1.06l-4.69-4.69A8.25 8.25 0 012.25 10.5z" clipRule="evenodd" /></svg></button>
              <button onClick={() => setMapLayer(mapLayer === 'topo' ? 'satellite' : 'topo')} className="w-12 h-12 bg-white/90 backdrop-blur-md rounded-full shadow-md flex items-center justify-center text-slate-700 active:scale-95 transition-transform">{mapLayer === 'topo' ? <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6"><path fillRule="evenodd" d="M1.5 4.5a3 3 0 013-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 01-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 006.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 011.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 01-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 10.375V4.5zM15 1.5a3 3 0 00-3 3v2.25a3 3 0 003 3h2.25a3 3 0 00-3-3H15zm0 9a3 3 0 00-3 3v2.25a3 3 0 003 3h2.25a3 3 0 00-3-3H15z" clipRule="evenodd" /></svg> : <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6"><path fillRule="evenodd" d="M11.54 22.351l.07.04.028.016a.76.76 0 00.723 0l.028-.015.071-.041a16.975 16.975 0 001.144-.742 19.58 19.58 0 002.683-2.282c1.944-1.99 3.963-4.98 3.963-8.827a8.25 8.25 0 00-16.5 0c0 3.846 2.02 6.837 3.963 8.827a19.58 19.58 0 002.682 2.282 16.975 16.975 0 001.145.742zM12 13.5a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" /></svg>}</button>
          </div>
      </div>
      {isSearchOpen && (<div className="absolute top-20 left-4 right-16 z-50 pointer-events-auto"><div className="bg-white rounded-2xl shadow-xl overflow-hidden"><div className="flex items-center p-3 border-b border-slate-100"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-slate-400 mr-2"><path fillRule="evenodd" d="M10.5 3.75a6.75 6.75 0 100 13.5 6.75 6.75 0 000-13.5zM2.25 10.5a8.25 8.25 0 1114.59 5.28l4.69 4.69a.75.75 0 11-1.06 1.06l-4.69-4.69A8.25 8.25 0 012.25 10.5z" clipRule="evenodd" /></svg><input type="text" placeholder="Search Swiss locations..." className="flex-1 outline-none text-slate-700" autoFocus value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />{searchQuery && <button onClick={() => setSearchQuery('')} className="text-slate-400"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zm-1.72 6.97a.75.75 0 10-1.06 1.06L10.94 12l-1.72 1.72a.75.75 0 101.06 1.06L12 13.06l1.72 1.72a.75.75 0 10-1.06-1.06L12 10.94l-1.72-1.72z" clipRule="evenodd" /></svg></button>}</div><div className="max-h-60 overflow-y-auto">{searchResults.map((result, index) => (<div key={index} onClick={() => handleSearchResultClick(result)} className="p-3 hover:bg-slate-50 cursor-pointer text-sm text-slate-700 border-b border-slate-50 last:border-0">{result.attrs.label.replace('<b>', '').replace('</b>', '')}</div>))}{searchQuery.length > 2 && searchResults.length === 0 && (<div className="p-4 text-center text-sm text-slate-500">No results found</div>)}</div></div></div>)}
      <button onClick={analyzePath} disabled={loading || heatmapLoading} className="absolute bottom-36 md:bottom-10 right-4 md:left-[400px] md:right-auto z-10 bg-[#DC0018] text-white font-bold px-6 py-3 rounded-full shadow-lg active:scale-95 transition-transform flex items-center space-x-2 disabled:opacity-50 disabled:scale-100">{(loading || heatmapLoading) ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div><span>{loading ? 'Analyzing Path...' : 'Scanning Area...'}</span></> : <><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h-2.433l.741.741a5.41 5.41 0 011.033 1.618l.56 1.31a.75.75 0 001.275.16l.975-1.376a5.5 5.5 0 012.464-2.466l1.375-.976a.75.75 0 00-.16-1.275l-1.31-.56a5.409 5.409 0 01-1.618-1.033l-.741-.741v-2.433l.311.312a5.5 5.5 0 012.466 9.201l1.34 1.34a.75.75 0 001.06 0l1.06-1.06a.75.75 0 000-1.06l-1.341-1.34zM4 5a1 1 0 100 2 1 1 0 000-2zm1 9a1 1 0 100 2 1 1 0 000-2zm6-4a1 1 0 100 2 1 1 0 000-2zm4-5a1 1 0 100 2 1 1 0 000-2zm0 9a1 1 0 100 2 1 1 0 000-2zm-4 5a1 1 0 100 2 1 1 0 000-2z" clipRule="evenodd" /></svg><span>Analyze Path</span></>}</button>
      <div className={`fixed z-20 bg-white shadow-[0_-8px_30px_rgba(0,0,0,0.12)] transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] bottom-0 left-0 right-0 rounded-t-[2rem] ${isPanelExpanded ? 'h-[75vh]' : 'h-[110px]'} md:bottom-auto md:right-auto md:top-20 md:left-4 md:w-[380px] md:h-auto md:max-h-[calc(100vh-6rem)] md:rounded-2xl`}>
          <div className="w-full h-8 flex items-center justify-center md:hidden cursor-pointer active:opacity-50" onClick={() => setIsPanelExpanded(!isPanelExpanded)}><div className="w-10 h-1 bg-slate-200 rounded-full"></div></div>
          <div className="px-5 pb-6 h-full flex flex-col">
              <div className="flex items-center justify-between mb-2 md:mt-4 cursor-pointer md:cursor-default" onClick={() => !isPanelExpanded && window.innerWidth < 768 && setIsPanelExpanded(true)}>
                  <div className="flex items-center space-x-3"><div className={`flex items-center justify-center w-10 h-10 rounded-full ${getStatusColorClass(linkStats.margin, linkStats.obstruction)}`}>{getStatusIcon(linkStats.margin, linkStats.obstruction)}</div><div><h2 className="font-bold text-slate-800 text-lg leading-tight">{getStatusText(linkStats.margin, linkStats.obstruction)}</h2><p className="text-sm text-slate-500">{linkStats.distance > 0 ? `${linkStats.distance} km · ${linkStats.fspl} dB FSPL` : 'Drag markers and press Analyze'}</p></div></div>
                  {linkStats.obstruction !== null && (<div className="text-right"><div className={`text-lg font-bold ${parseFloat(linkStats.margin) < 0 ? "text-[#DC0018]" : parseFloat(linkStats.margin) <= 2 ? "text-yellow-600" : "text-emerald-600"}`}>{parseFloat(linkStats.margin) > 0 ? '+' : ''}{linkStats.margin}m</div><div className="text-[10px] uppercase tracking-wider font-medium text-slate-400">60% FZ Clear</div></div>)}
              </div>
              <div className={`flex-1 overflow-y-auto md:block transition-opacity duration-300 ${isPanelExpanded ? 'opacity-100 visible delay-100' : 'opacity-0 invisible md:opacity-100 md:visible'} md:delay-0`}>
                  <div className="h-px w-full bg-slate-100 my-4 md:block hidden"></div>
                  <div className="relative grid grid-cols-2 gap-4 mb-6 pt-2">
                      <div className="space-y-1"><label className="text-xs font-medium text-blue-600 uppercase tracking-wider">Tx Height (m)</label><input type="number" inputMode="numeric" value={txHeight} onChange={e => setTxHeight(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-slate-700 font-medium focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all" /></div>
                      <div className="space-y-1"><label className="text-xs font-medium text-[#DC0018] uppercase tracking-wider">Rx Height (m)</label><input type="number" inputMode="numeric" value={rxHeight} onChange={e => setRxHeight(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-slate-700 font-medium focus:ring-2 focus:ring-red-500/20 focus:border-[#DC0018] outline-none transition-all" /></div>
                      <button onClick={handleSwapMarkers} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 bg-white border border-slate-200 rounded-full p-1.5 shadow-sm text-slate-400 hover:text-blue-600 active:scale-95 transition-all mt-3" title="Swap Tx/Rx"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M2.24 6.8a.75.75 0 001.06-.04l1.95-2.1v8.59a.75.75 0 001.5 0V4.66l1.95 2.1a.75.75 0 101.1-1.02l-3.25-3.5a.75.75 0 00-1.1 0L2.2 5.74a.75.75 0 00.04 1.06zm8 6.4a.75.75 0 00-.04 1.06l3.25 3.5a.75.75 0 001.1 0l3.25-3.5a.75.75 0 10-1.1-1.02l-1.95 2.1V6.75a.75.75 0 00-1.5 0v8.59l-1.95-2.1a.75.75 0 00-1.06-.04z" clipRule="evenodd" /></svg></button>
                      <div className="col-span-2 space-y-1"><label className="text-xs font-medium text-slate-500 uppercase tracking-wider">Frequency (GHz)</label><input type="number" inputMode="decimal" step="0.1" value={freq} onChange={e => setFreq(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-slate-700 font-medium focus:ring-2 focus:ring-slate-500/20 focus:border-slate-400 outline-none transition-all" /></div>
                  </div>
                  <div className="bg-slate-50 rounded-xl p-3 border border-slate-100 mb-4" style={{ height: '200px' }}>{chartData ? <Line options={chartOptions} data={chartData} /> : <div className="h-full flex items-center justify-center text-slate-400 text-sm">Chart will appear after analysis</div>}</div>
                  <div className="text-center md:text-left"><span className="text-[10px] text-slate-400 font-medium">Data source: federal office of topography swisstopo</span></div>
              </div>
          </div>
      </div>
    </div>
  );
}

export default App;
