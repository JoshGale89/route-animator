"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/** ===================== Types ===================== */
type Pt = { lat: number; lon: number; ele?: number; t: number };
type ProjPt = { x: number; y: number; ele?: number; t: number; d: number; pace?: number };
type Aspect = "vertical" | "square" | "wide";
type Units = "mph" | "kmh";
type Layout = "grid" | "minimal" | "paper" | "transparent" | "map";
type Quality = "fast" | "high";

/** ===================== Global CSS ===================== */
const GlobalCSS = () => (
  <style>{`
    :root { color-scheme: dark; }
    body { margin:0; }
    select, select option { color:#fff; background:#111; }
    input[type="text"]::placeholder { color: rgba(255,255,255,0.6); }
    .group { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .chip { display:inline-flex; gap:8px; align-items:center; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.18); border-radius:10px; padding:10px 14px; }
    .btn { padding:10px 16px; border-radius:10px; border:1px solid rgba(255,255,255,0.18); font-weight:700; cursor:pointer; }
    .btn-primary { background:#22d3ee; color:#08262a; }
    .btn-ghost { background:rgba(255,255,255,0.06); color:#fff; }
    /* Adjusted panel styling for better contrast */
    .panel { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.12); border-radius:16px; padding:16px; }
    .range { accent-color:#22d3ee; }

    /* Responsive tweaks for mobile devices */
    @media (max-width: 640px) {
      .group {
        flex-direction: column;
        align-items: stretch;
      }
      .chip, .btn {
        width: 100%;
        justify-content: space-between;
      }
      .btn {
        text-align: center;
      }
    }
  `}</style>
);

/** ===================== GPX parse & cleaning ===================== */
async function parseGpx(file: File): Promise<Pt[]> {
  const txt = await file.text();
  const doc = new DOMParser().parseFromString(txt, "application/xml");
  let nodes = [...doc.querySelectorAll("trkpt")];
  if (!nodes.length) nodes = [...doc.querySelectorAll("rtept")];
  if (!nodes.length) return [];
  const pts: Pt[] = nodes.map((n) => {
    const lat = parseFloat(n.getAttribute("lat") || "0");
    const lon = parseFloat(n.getAttribute("lon") || "0");
    const ele = n.querySelector("ele") ? parseFloat(n.querySelector("ele")!.textContent || "0") : undefined;
    const timeNode = n.querySelector("time");
    const t = timeNode ? new Date(timeNode.textContent || Date.now()).getTime() : NaN;
    return { lat, lon, ele, t };
  });
  // timestamps monotonic
  let synth = pts.some((p) => !isFinite(p.t));
  if (!synth) for (let i = 1; i < pts.length; i++) if (!(pts[i].t > pts[i - 1].t)) { synth = true; break; }
  if (synth) { const base = Date.now(); for (let i = 0; i < pts.length; i++) pts[i].t = base + i * 1000; } else { pts.sort((a,b)=>a.t-b.t); }
  // dedup
  const out: Pt[] = []; for (const p of pts) if (!out.length || p.t !== out[out.length - 1].t) out.push(p);
  return out;
}

/** ===================== Geo helpers ===================== */
const R = 6371000;
const toRad = (x: number) => (x * Math.PI) / 180;
function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const s = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function smoothElev(points: Pt[], window = 7): Pt[] {
  if (!points.length) return points;
  const out = points.map(p=>({ ...p }));
  for (let i=0;i<points.length;i++) {
    if (points[i].ele==null) continue;
    let sum=0, cnt=0;
    for (let j=Math.max(0,i-window); j<=Math.min(points.length-1,i+window); j++) {
      if (points[j].ele!=null) { sum+=points[j].ele!; cnt++; }
    }
    out[i].ele = cnt? sum/cnt : points[i].ele;
  }
  return out;
}
function removeSpikes(points: Pt[], maxSpeedHint?: number): Pt[] {
  if (points.length < 10) return points;
  const totalDist = points.slice(1).reduce((acc,p,i)=>acc+haversine(points[i],p),0);
  const totalTime = (points.at(-1)!.t - points[0].t)/1000;
  const avgMS = totalTime>0? totalDist/totalTime : 0;
  const cap = maxSpeedHint ?? (avgMS>4 ? 20 : 9); // cycling vs running
  const out: Pt[] = [points[0]];
  for (let i=1;i<points.length;i++){
    const prev = out[out.length-1]; const cur = points[i];
    const dt=(cur.t-prev.t)/1000; const d=haversine(prev,cur);
    const v = dt>0? d/dt : 0;
    if (v<=cap) out.push(cur);
  }
  return out;
}
function trimPrivacy(points: Pt[], meters: number): Pt[] {
  if (points.length<2 || meters<=0) return points;
  let dist=0, startIdx=0;
  for (let i=1;i<points.length;i++){ dist+=haversine(points[i-1],points[i]); if (dist>=meters){ startIdx=i; break; } }
  dist=0; let endIdx=points.length-1;
  for (let i=points.length-1;i>0;i--){ dist+=haversine(points[i],points[i-1]); if (dist>=meters){ endIdx=i; break; } }
  return points.slice(startIdx,endIdx+1);
}
function resample(points: Pt[], fps=30, durationSec=20): ProjPt[] {
  if (!points.length) return [];
  const start=points[0].t, end=points.at(-1)!.t;
  const totalTime = Math.max(1, end-start);
  const frames = Math.max(2, Math.round(fps*durationSec));
  const out: ProjPt[] = [];
  let j=0, cum=0;
  for (let i=0;i<frames;i++){
    const t = start + (i/(frames-1))*totalTime;
    while (j<points.length-1 && points[j+1].t < t) j++;
    const a1=points[j], a2=points[j+1] ?? points[j];
    const span=Math.max(1,a2.t-a1.t);
    const a = Math.min(1, Math.max(0,(t-a1.t)/span));
    const lat=a1.lat + a*(a2.lat-a1.lat);
    const lon=a1.lon + a*(a2.lon-a1.lon);
    const ele=a1.ele!=null && a2.ele!=null ? a1.ele + a*(a2.ele-a1.ele) : undefined;

    if (i>0) { const prev=out[i-1]; const d=haversine({lat:prev.y,lon:prev.x},{lat,lon}); cum+=d; }

    let pace: number|undefined;
    if (i>0) { const prev=out[i-1]; const dt=totalTime/(frames-1); const d=haversine({lat:prev.y,lon:prev.x},{lat,lon}); const mps=d/(dt/1000); pace = mps>0 ? (1000/mps)/60 : undefined; }

    out.push({ x: lon, y: lat, ele, t, d: cum, pace });
  }
  return out;
}

/** ===================== Projector (centers, then pan+zoom) ===================== */
function makeProjector(
  samples: ProjPt[],
  width: number,
  height: number,
  pads: { left: number; right: number; top: number; bottom: number },
  pan: { x: number; y: number },
  zoom: number
) {
  if (!samples.length) {
    return { scale: 1, routeW:0, routeH:0, freeW:width, freeH:height, toXY: (_: {x:number;y:number}) => ({x:width/2,y:height/2}) };
  }
  const xs = samples.map(p=>p.x), ys = samples.map(p=>p.y);
  const minX=Math.min(...xs), maxX=Math.max(...xs);
  const minY=Math.min(...ys), maxY=Math.max(...ys);
  const routeW = Math.max(1e-9, maxX-minX);
  const routeH = Math.max(1e-9, maxY-minY);
  const freeW = Math.max(1, width - pads.left - pads.right);
  const freeH = Math.max(1, height - pads.top  - pads.bottom);
  const base  = Math.min(freeW/routeW, freeH/routeH);
  const scale = base * (zoom || 1);
  const centerX = (freeW - routeW*scale)/2;
  const centerY = (freeH - routeH*scale)/2;
  const offsetX = pads.left + centerX + (pan?.x || 0);
  const offsetY = pads.top  + centerY + (pan?.y || 0);
  return {
    scale, routeW, routeH, freeW, freeH,
    toXY(p:{x:number;y:number}) {
      const x = offsetX + (p.x - minX) * scale;
      const y = offsetY + (maxY - p.y) * scale; // invert Y
      return { x, y };
    }
  };
}

/** ===================== Formatting ===================== */
const fmtTime = (ms:number) => {
  const s=Math.round(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), ss=s%60;
  return h>0 ? `${h}:${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}` : `${m}:${String(ss).padStart(2,"0")}`;
};
function fmtDistByUnits(meters: number, units: Units) {
  if (units === "mph") {
    const miles = meters / 1609.344;
    return miles >= 0.95 ? `${miles.toFixed(2)} mi` : `${(miles * 5280).toFixed(0)} ft`;
  } else {
    return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${meters.toFixed(0)} m`;
  }
}
function fmtPaceByUnits(minPerKm?: number, units: Units = "kmh") {
  if (minPerKm==null || !isFinite(minPerKm)) return "—";
  const factor = units === "mph" ? 1.609344 : 1; // min/mi when mph
  const val = minPerKm * factor;
  const mm = Math.floor(val), ss = Math.round((val-mm)*60);
  return `${mm}:${String(ss).padStart(2,"0")} /${units==="mph"?"mi":"km"}`;
}
function smoothedPaceAt(samples: ProjPt[], idx: number, window = 8) {
  if (!samples.length) return undefined;
  let sum = 0, n = 0;
  const a = Math.max(0, idx - window), b = Math.min(samples.length - 1, idx + window);
  for (let i = a; i <= b; i++) {
    if (samples[i].pace != null && isFinite(samples[i].pace!)) { sum += samples[i].pace!; n++; }
  }
  return n ? sum / n : samples[idx]?.pace;
}

/** ===================== Heat helpers ===================== */
function percentile(sorted:number[], p:number){ if(!sorted.length) return 0; const idx=(sorted.length-1)*p; const lo=Math.floor(idx), hi=Math.ceil(idx); if(lo===hi) return sorted[lo]; return sorted[lo]+(sorted[hi]-sorted[lo])*(idx-lo); }
function speedColor(t:number){
  t=Math.max(0,Math.min(1,t));
  if (t<0.33){ const k=t/0.33; return `rgb(${Math.round(0+55*k)},${Math.round(100+155*k)},255)`; }
  if (t<0.66){ const k=(t-0.33)/0.33; return `rgb(${Math.round(55+200*k)},255,${Math.round(255-255*k)})`; }
  const k=(t-0.66)/0.34; return `rgb(255,${Math.round(255-200*k)},0)`;
}
function toUnits(ms:number, units:Units){ return units==="mph" ? ms*2.23693629 : ms*3.6; }

/** ===================== Mapbox static ===================== */
function lonLatToTile(lon:number, lat:number, z:number){
  const x=(lon+180)/360;
  const y=(1 - Math.log(Math.tan((lat*Math.PI)/180)+1/Math.cos((lat*Math.PI)/180))/Math.PI)/2;
  return { x:x*(1<<z), y:y*(1<<z) };
}
function calcCenterZoom(samples:ProjPt[], W:number, H:number){
  const lons=samples.map(s=>s.x), lats=samples.map(s=>s.y);
  const minLon=Math.min(...lons), maxLon=Math.max(...lons);
  const minLat=Math.min(...lats), maxLat=Math.max(...lats);
  const centerLon=(minLon+maxLon)/2, centerLat=(minLat+maxLat)/2;
  const padding=1.1;
  for (let z=16; z>=0; z--){
    const tl=lonLatToTile(minLon,maxLat,z), br=lonLatToTile(maxLon,minLat,z);
    const dx=Math.abs(br.x-tl.x), dy=Math.abs(br.y-tl.y);
    const fitsX = dx*512 <= (W)/padding, fitsY = dy*512 <= (H)/padding;
    if (fitsX && fitsY) return { centerLon, centerLat, zoom:z };
  }
  return { centerLon, centerLat, zoom:0 };
}

// HUD drawing helper. Draws the statistics (distance, time, pace, climb), elevation strip, and title.
// Used by both 2D canvas rendering and 3D export. It assumes the canvas is sized W x H and uses
// current p (0–1) to compute the progress. Does not draw the route itself.
function drawHud(ctx: CanvasRenderingContext2D, p01: number, W: number, H: number,
  samples: ProjPt[], units: Units, totalDist: number, totalTimeMs: number,
  showTitle: boolean, titleText: string, fileName: string, showWeather: boolean,
  weather: { tempC: number; windKmh: number } | null, showLegend: boolean, splitsOn: boolean,
  elevGain: number
) {
  // Compute top and bottom sizes based on canvas height
  const hudH = Math.round(H * 0.09);
  const hudX = Math.round(W * 0.055);
  const hudY = Math.round(H * 0.02);
  const hudW = Math.round(W * 0.89);
  const stripH = Math.round(H * 0.09);
  const baseY = H - Math.round(stripH * 0.25);
  const usableH = stripH - Math.round(stripH * 0.55);
  const stripPad = Math.round(W * 0.08);
  // Determine metrics at this progress
  const nowDist = totalDist * p01;
  const nowMs = totalTimeMs * p01;
  const msPerKm = totalDist > 0 ? totalTimeMs / (totalDist / 1000) : undefined;
  // HUD background: dark semi-transparent for legibility on 3D and 2D
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(hudX, hudY, hudW, hudH);
  // Draw cells
  const cells = [
    { label: 'Distance', value: fmtDistByUnits(nowDist, units) },
    { label: 'Time', value: fmtTime(nowMs) },
    { label: 'Avg pace', value: fmtPaceByUnits(msPerKm, units) },
    { label: 'Climb', value: units === 'mph' ? `${Math.round(elevGain * 3.28084)} ft` : `${Math.round(elevGain)} m` },
  ];
  const cellW = hudW / cells.length;
  ctx.textAlign = 'center';
  const valuePx = Math.round(H * 0.030);
  const labelPx = Math.round(H * 0.014);
  cells.forEach((m, i) => {
    const cx = hudX + i * cellW + cellW / 2;
    ctx.fillStyle = '#fff';
    ctx.font = `${valuePx}px ui-sans-serif`;
    ctx.fillText(m.value, cx, hudY + Math.round(hudH * 0.48));
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `${labelPx}px ui-sans-serif`;
    ctx.fillText(m.label, cx, hudY + Math.round(hudH * 0.78));
  });
  // Elevation strip background
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, H - stripH, W, stripH);
  // Elevation text
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(H * 0.018)}px ui-sans-serif`;
  ctx.fillText('Elevation', Math.round(W * 0.055), H - stripH + Math.round(H * 0.035));
  // Elevation line
  const elevs = samples.map((p) => p.ele ?? 0);
  const minE = Math.min(...elevs);
  const maxE = Math.max(...elevs);
  const rng = Math.max(1, maxE - minE);
  ctx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const px = (i / (samples.length - 1)) * (W - stripPad * 2) + stripPad;
    const py = baseY - ((elevs[i] - minE) / rng) * usableH;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 3;
  ctx.stroke();
  // Title
  if (showTitle) {
    ctx.font = `600 ${Math.round(H * 0.022)}px ui-sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    const raw = titleText?.trim() || (fileName ? fileName.replace(/\.[^.]+$/, '') : 'Your Activity');
    const text = raw.slice(0, 80);
    const y = H - stripH - Math.round(H * 0.018);
    const m = ctx.measureText(text);
    const startX = Math.max(Math.round(W / 2 - m.width / 2), 12);
    ctx.fillText(text, startX, y);
  }
}
/** ===================== Historical weather (Open-Meteo ERA5) ===================== */
const isoDate = (ms:number) => new Date(ms).toISOString().slice(0,10);
function nearestIndexToTime(times:string[], targetMs:number){
  let best=0, diff=Infinity;
  for (let i=0;i<times.length;i++){ const d=Math.abs(Date.parse(times[i])-targetMs); if (d<diff){ diff=d; best=i; } }
  return best;
}
async function fetchHistoricalWeather(lat:number, lon:number, startMs:number, endMs:number){
  const day = 24*3600*1000;
  const startDate = isoDate(startMs-day);
  const endDate   = isoDate(endMs+day);
  const url = `https://archive-api.open-meteo.com/v1/era5?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&hourly=temperature_2m,windspeed_10m&timezone=UTC`;
  const res = await fetch(url); if (!res.ok) return null;
  const data = await res.json();
  const times: string[] = data?.hourly?.time || [];
  const temps: number[] = data?.hourly?.temperature_2m || [];
  const winds: number[] = data?.hourly?.windspeed_10m || [];
  if (!times.length || !temps.length || !winds.length) return null;
  const mid = (startMs + endMs)/2;
  const idx = nearestIndexToTime(times, mid);
  const tempC = temps[idx], windKmh = winds[idx];
  if (typeof tempC!=="number" || typeof windKmh!=="number") return null;
  return { tempC, windKmh };
}

/** ===================== Component ===================== */
export default function Page() {
  // Core state
  const [layout, setLayout] = useState<Layout>("grid"); // Night grid default
  const [aspect, setAspect] = useState<Aspect>("vertical");
  const [durationSec, setDurationSec] = useState(20);
  const [privacyM, setPrivacyM] = useState(120);
  const [status, setStatus] = useState("");
  const [fileName, setFileName] = useState("");

  // Data
  const [samples, setSamples] = useState<ProjPt[]>([]);
  const [units, setUnits] = useState<Units>("mph");
  const [heatOn, setHeatOn] = useState(true);
  const [splitsOn, setSplitsOn] = useState(true);
  const [highContrastRoute, setHighContrastRoute] = useState(false);

  // Title
  const [showTitle, setShowTitle] = useState(true);
  const [titleText, setTitleText] = useState("");
  const [titleAlign, setTitleAlign] = useState<"left"|"center"|"right">("right");

  // Weather
  const [showWeather, setShowWeather] = useState(false);
  const [weather, setWeather] = useState<{ tempC:number; windKmh:number } | null>(null);

  // Legend (draggable)
  const [showLegend, setShowLegend] = useState(false);
  const [legendXY, setLegendXY] = useState<{x:number;y:number} | null>(null);
  const legendDrag = useRef<{down:boolean; offx:number; offy:number}>({down:false, offx:0, offy:0});

  // Background (transparent)
  const [bgKind, setBgKind] = useState<"none"|"image"|"video">("none");
  const [bgAlpha, setBgAlpha] = useState(1);
  const bgImgRef = useRef<HTMLImageElement|null>(null);
  const bgVidRef = useRef<HTMLVideoElement|null>(null);
  const [bgVidReady, setBgVidReady] = useState(false);
  const [bgTick, setBgTick] = useState(0);

  // Mode: 2D or 3D
  // Users can toggle between a 2D canvas animation and a 3D Mapbox GL JS preview.
  type Mode = "2d" | "3d";
  const [mode, setMode] = useState<Mode>("2d");

  // Map style selection for static images (when using map layout)
  const [mapStyle, setMapStyle] = useState<string>("streets-v12");

  // Ref to hold base zoom level after fitting the route in 3D.  This is used
  // during export to keep a consistent zoom when capturing frames.  It is
  // populated once the 3D map has loaded and fit to bounds.
  const baseZoomRef = useRef<number | null>(null);

  // Canvas overlay for drawing the HUD on top of the 3D map.  When the 3D
  // preview is active, this canvas is layered over the map and updated on
  // each animation frame.  During export of the 3D view, we also draw the
  // HUD onto the offscreen canvas along with the map image.
  const hudCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // 3D view controls
  const [pitch, setPitch] = useState<number>(45);
  const [bearing, setBearing] = useState<number>(0);
  const [showTrail, setShowTrail] = useState<boolean>(false);

  // Keep the latest pitch and bearing in refs for use in the animation loop.
  const pitchRef = useRef(pitch);
  const bearingRef = useRef(bearing);
  useEffect(() => { pitchRef.current = pitch; }, [pitch]);
  useEffect(() => { bearingRef.current = bearing; }, [bearing]);

  // Camera mode for the 3D view.  Different modes change how the camera follows the route.
  //  - "follow" keeps the camera centered on the marker with the current pitch/bearing.
  //  - "behind" orients the camera behind the marker, facing the direction of travel.
  //  - "drone" continuously pans around the marker for an aerial effect.
  //  - "flyover" begins from a wider zoom and gradually zooms in; currently behaves like follow.
  // Added 'stationary' camera mode for an overhead, stationary view.
  const [cameraMode, setCameraMode] = useState<"follow" | "behind" | "drone" | "flyover" | "ground" | "orbit" | "stationary">("follow");

  // Keep showTrail in a ref so the animation loop reads the current value without causing re-renders
  const showTrailRef = useRef(showTrail);
  useEffect(() => {
    showTrailRef.current = showTrail;
  }, [showTrail]);

  // Keep camera mode in a ref so the animation loop sees updates without reinitializing the map.  This
  // allows the user to switch camera modes live without tearing down the map instance.
  const cameraModeRef = useRef(cameraMode);
  useEffect(() => {
    cameraModeRef.current = cameraMode;
  }, [cameraMode]);

  // Keep track of the last heading for smoothing in behind/ground modes
  const lastHeadingRef = useRef<number>(0);

  // References to the current marker and trail source in the 3D map.  These are populated on map load.
  const markerRef = useRef<any>(null);
  const trailRef = useRef<any>(null);

  // Reference for 3D map container and map instance
  const map3dRef = useRef<any>(null);
  const mapContainerRef = useRef<HTMLDivElement|null>(null);

  // Error state for 3D map loading
  const [map3dError, setMap3dError] = useState<string | null>(null);

  // Mapbox
  const [mapToken, setMapToken] = useState<string>("pk.eyJ1Ijoiam9zaGc4OSIsImEiOiJjbWVqY21uOXEwYmk5Mmxvb3BmdGN1dGk5In0.RgMUvKwdqQFTqcPOCEEueg");
  const [mapImg, setMapImg] = useState<HTMLImageElement|null>(null);

  // Canvas + animation
  const canvasRef = useRef<HTMLCanvasElement|null>(null);
  const offscreenRef = useRef<HTMLCanvasElement|null>(null);
  const animRef = useRef<number|null>(null);
  const startRef = useRef<number|null>(null);
  const pausedRef = useRef(false);
  const clickGuard = useRef<{ moved:boolean }>({ moved:false });

  // Pan/Zoom
  const [pan, setPan] = useState({ x:0, y:0 });
  const [zoom, setZoom] = useState(1);
  const drag = useRef<{down:boolean; sx:number; sy:number; ox:number; oy:number}>({down:false,sx:0,sy:0,ox:0,oy:0});

  // Export
  const [quality, setQuality] = useState<Quality>("fast"); // ✅ default to FAST
  const [phase, setPhase] = useState<""|"frames"|"encoding">("");
  const [progress, setProgress] = useState(0);
  const [ffmpeg, setFfmpeg] = useState<any|null>(null);
  const [loadingFfmpeg, setLoadingFfmpeg] = useState(false);
  const abortRef = useRef(false);

  // Aspect → canvas size
  const FPS = 30;
  const { W, H, labelSuffix, previewSize } = useMemo(() => {
    // Define intrinsic resolutions and preview sizes based on aspect ratio.
    // Reduced preview sizes for a more compact layout.
    if (aspect === "square") return { W: 1080, H: 1080, labelSuffix: "1080x1080", previewSize: { w: 420, h: 420 } };
    if (aspect === "wide")   return { W: 1920, H: 1080, labelSuffix: "1920x1080", previewSize: { w: 560, h: 315 } };
    // default to vertical
    return { W: 1080, H: 1920, labelSuffix: "1080x1920", previewSize: { w: 330, h: 610 } };
  }, [aspect]);

  // Derived
  const totalDist = useMemo(()=> (samples.at(-1)?.d ?? 0), [samples]);
  const totalTimeMs = useMemo(()=> (samples.length ? samples.at(-1)!.t - samples[0].t : 0), [samples]);

  // Splits
  const splitIdxs = useMemo(()=>{
    if (!samples.length) return [] as number[];
    const unit = units==="mph" ? 1609.344 : 1000;
    const res:number[] = [];
    for (let m=unit;m<totalDist;m+=unit){
      let idx=samples.findIndex(s=>s.d>=m);
      if (idx<0) idx=samples.length-1;
      res.push(idx);
    }
    return res;
  }, [samples, totalDist, units]);

  // Speeds
  const speedsMS = useMemo(()=>{
    if (samples.length<2) return [] as number[];
    const out:number[] = [];
    const dt = (totalTimeMs/(samples.length-1))/1000;
    for (let i=1;i<samples.length;i++){
      const a=samples[i-1], b=samples[i];
      const d=haversine({lat:a.y,lon:a.x},{lat:b.y,lon:b.x});
      out.push(dt>0? d/dt : 0);
    }
    return out;
  }, [samples, totalTimeMs]);
  const speedStats = useMemo(()=>{
    const arr=speedsMS.slice().sort((x,y)=>x-y);
    if (!arr.length) return { lo:0, hi:0, loU:0, hiU:0 };
    const lo=percentile(arr,0.05), hi=percentile(arr,0.95);
    return { lo, hi, loU:toUnits(lo,units), hiU:toUnits(hi,units) };
  }, [speedsMS, units]);

  // Total elevation gain (sum of positive climbs) across the entire activity
  const elevGain = useMemo(() => {
    if (!samples.length) return 0;
    let gain = 0;
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1];
      const cur = samples[i];
      const diff = (cur.ele ?? 0) - (prev.ele ?? 0);
      if (diff > 0) gain += diff;
    }
    return gain;
  }, [samples]);

  /** ---------- Legend rect ---------- */
  function legendRect() {
    const legendW = Math.round(W*0.14);
    const legendH = Math.round(H*0.012) + 18;
    const defX = W - Math.round(W*0.08) - legendW;
    const defY = Math.round(H*0.105) - 8;
    const x = legendXY?.x ?? defX;
    const y = legendXY?.y ?? defY;
    return { x, y, w:legendW, h:legendH };
  }
  function pointerInLegend(e: React.PointerEvent<HTMLCanvasElement>) {
    const r=(e.target as HTMLCanvasElement).getBoundingClientRect();
    const cx=(e.clientX-r.left)*(W/r.width), cy=(e.clientY-r.top)*(H/r.height);
    const {x,y,w,h}=legendRect();
    return { hit: cx>=x && cx<=x+w && cy>=y && cy<=y+h, cx, cy };
  }

  /** ===================== Draw ===================== */
  const drawFrame = (progress01:number) => {
    const cvs=canvasRef.current;
    if(!cvs) return; // hydration guard: bail if canvas is not ready
    cvs.width=W; cvs.height=H;
    const ctx=cvs.getContext("2d");
    if(!ctx) return;
    ctx.clearRect(0,0,W,H);

    // Backgrounds
    if (layout==="transparent") {
      ctx.fillStyle="#0b0f14"; ctx.fillRect(0,0,W,H);
      if (bgImgRef.current && bgKind==="image") {
        const img=bgImgRef.current; const r=Math.max(W/img.width, H/img.height);
        const iw=img.width*r, ih=img.height*r, ox=(W-iw)/2, oy=(H-ih)/2;
        ctx.save(); ctx.globalAlpha=bgAlpha; ctx.drawImage(img,ox,oy,iw,ih); ctx.restore();
      } else if (bgVidRef.current && bgVidReady && bgKind==="video") {
        const vid=bgVidRef.current;
        try { if (isFinite(vid.duration)) vid.currentTime = Math.max(0,Math.min(1,progress01))*vid.duration; } catch {}
        const r=Math.max(W/vid.videoWidth, H/vid.videoHeight);
        const vw=vid.videoWidth*r, vh=vid.videoHeight*r, ox=(W-vw)/2, oy=(H-vh)/2;
        ctx.save(); ctx.globalAlpha=bgAlpha; ctx.drawImage(vid,ox,oy,vw,vh); ctx.restore();
      }
    } else if (layout==="map") {
      if (mapImg) {
        const r=Math.max(W/mapImg.width, H/mapImg.height);
        const iw=mapImg.width*r, ih=mapImg.height*r, ox=(W-iw)/2, oy=(H-ih)/2;
        ctx.drawImage(mapImg,ox,oy,iw,ih);
      } else { ctx.fillStyle="#0b0f14"; ctx.fillRect(0,0,W,H); }
    } else if (layout==="grid") {
      ctx.fillStyle="#0a0d12"; ctx.fillRect(0,0,W,H);
      ctx.strokeStyle="rgba(255,255,255,0.06)"; ctx.lineWidth=1;
      const step=Math.round(Math.min(W,H)*0.04);
      for (let x=0;x<=W;x+=step){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
      for (let y=0;y<=H;y+=step){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
      const g=ctx.createRadialGradient(W/2,H/2,Math.min(W,H)*0.2,W/2,H/2,Math.max(W,H)*0.7);
      g.addColorStop(0,"rgba(0,0,0,0)"); g.addColorStop(1,"rgba(0,0,0,0.35)"); ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
    } else if (layout==="paper") {
      ctx.fillStyle="#f4efe8"; ctx.fillRect(0,0,W,H);
      // darker topo lines for contrast
      ctx.strokeStyle="rgba(0,0,0,0.12)"; // was 0.05
      const step=Math.round(Math.min(W,H)*0.06);
      for (let y=Math.round(H*0.15); y < H-Math.round(H*0.2); y+=step){
        ctx.beginPath(); const amp=Math.round(step*0.2);
        for (let x=0;x<=W;x+=12){ const yy=y + Math.sin(x*0.015)*amp; if (x===0) ctx.moveTo(x,yy); else ctx.lineTo(x,yy); }
        ctx.stroke();
      }
      const g=ctx.createLinearGradient(0,0,0,H);
      g.addColorStop(0,"rgba(0,0,0,0.08)"); g.addColorStop(0.05,"rgba(0,0,0,0)");
      g.addColorStop(0.95,"rgba(0,0,0,0)"); g.addColorStop(1,"rgba(0,0,0,0.08)");
      ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
    } else {
      ctx.fillStyle="#0b0f14"; ctx.fillRect(0,0,W,H);
    }

    if (!samples.length) {
      ctx.fillStyle= layout==="paper" ? "#111" : "#fff";
      ctx.font="bold 48px ui-sans-serif, -apple-system, Segoe UI, Roboto";
      ctx.fillText("Upload a GPX to preview", 60, H/2);
      return;
    }

    // Layout metrics + projector
    // Reserve space at the top for a stats panel (HUD) and at the bottom for the elevation strip
    const hudHeight = Math.round(H * 0.12);
    const stripHeight = Math.round(H * 0.12);
    const sidePad = Math.round(Math.min(W,H)*0.08);
    const projector = makeProjector(
      samples,
      W,
      H,
      {
        left: sidePad,
        right: sidePad,
        // Top padding includes a small margin, the HUD height and extra spacing
        top: Math.round(H * 0.03) + hudHeight + 16,
        // Bottom padding includes the elevation strip height plus spacing
        bottom: stripHeight + 16,
      },
      pan,
      zoom,
    );

    const upto = Math.max(1, Math.floor(progress01*(samples.length-1)));
    const routeWidth = Math.max(8, Math.round(Math.min(W,H)*0.012));

    // Optional outline for contrast
    if (highContrastRoute) {
      ctx.lineCap="round"; ctx.lineWidth=routeWidth+4;
      ctx.strokeStyle = layout==="paper" ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.6)";
      ctx.beginPath();
      samples.forEach((p,i)=>{ const {x,y}=projector.toXY(p); if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
      ctx.stroke();
    }

    // Route (heat or solid)
    if (heatOn && speedsMS.length===samples.length-1) {
      const blur=Math.round(Math.min(W,H)*0.006);
      ctx.lineCap="round";
      for (let i=1;i<samples.length;i++){
        const a=projector.toXY(samples[i-1]); const b=projector.toXY(samples[i]);
        const v=speedsMS[i-1]; const t = speedStats.hi>speedStats.lo ? (v-speedStats.lo)/(speedStats.hi-speedStats.lo) : 0.5;
        ctx.strokeStyle=speedColor(t); ctx.lineWidth=routeWidth; ctx.shadowColor=ctx.strokeStyle as string; ctx.shadowBlur=blur;
        ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
      }
      ctx.shadowBlur=0;
    } else {
      ctx.lineWidth=routeWidth;
      ctx.strokeStyle = layout==="paper" ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.9)";
      ctx.beginPath();
      samples.forEach((p,i)=>{ const {x,y}=projector.toXY(p); if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
      ctx.stroke();
    }

    // Splits (mile/km markers).  Draw small markers and labels, but remove the celebratory pulse animation.
    if (splitsOn && totalDist > 0) {
      const unit = units === "mph" ? 1609.344 : 1000;
      ctx.fillStyle = layout === "paper" ? "#000" : "#fff";
      ctx.font = `600 ${Math.round(H * 0.022)}px ui-sans-serif`;
      for (let m = unit, n = 1; m < totalDist; m += unit, n++) {
        let idx = samples.findIndex((s) => s.d >= m);
        if (idx < 0) idx = samples.length - 1;
        const { x, y } = projector.toXY(samples[idx]);
        // Small filled circle at the split point
        // Use a thinner marker radius so it doesn't dominate the view
        const rad = Math.max(4, Math.round(Math.min(W, H) * 0.005));
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
        // Label slightly offset
        const lab = units === "mph" ? `${n} mi` : `${n} km`;
        ctx.fillText(lab, x + 8, y - 8);
      }
      // Removed celebratory pulse and sparks to avoid early triggering and heavy visuals
    }

    // Progress comet head
    const uptoPt=samples[upto];
    ctx.lineWidth=Math.max(10,Math.round(Math.min(W,H)*0.015));
    ctx.strokeStyle="#22d3ee";
    ctx.shadowColor="#22d3ee"; ctx.shadowBlur=Math.round(Math.min(W,H)*0.018);
    ctx.beginPath();
    for (let i=0;i<=upto;i++){ const {x,y}=projector.toXY(samples[i]); if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }
    ctx.stroke(); ctx.shadowBlur=0;
    const {x:cx,y:cy}=projector.toXY(uptoPt);
    ctx.fillStyle="#22d3ee"; ctx.beginPath(); ctx.arc(cx,cy,Math.max(10,Math.round(Math.min(W,H)*0.017)),0,Math.PI*2); ctx.fill();

    // HUD panel color: provide a semi-transparent dark backdrop on all layouts for legibility
    const hudBg = "rgba(0,0,0,0.35)";

    // HUD top (stats panel)
    const hudX = Math.round(W * 0.055);
    const hudY = Math.round(H * 0.03);
    const hudW = Math.round(W * 0.89);
    const hudH = Math.round(H * 0.12);
    // Draw HUD background
    ctx.fillStyle = hudBg;
    ctx.fillRect(hudX, hudY, hudW, hudH);
    // Compute dynamic metrics
    const elapsed = totalTimeMs * progress01;
    const distNow = totalDist * progress01;
    const curPace = smoothedPaceAt(samples, upto, 8);
    // Compute current elevation gain up to this frame
    let curElevGain = 0;
    for (let i = 1; i <= upto; i++) {
      const prev = samples[i - 1];
      const cur = samples[i];
      const diff = (cur.ele ?? 0) - (prev.ele ?? 0);
      if (diff > 0) curElevGain += diff;
    }
    const curElevStr = units === "mph"
      ? `${Math.round(curElevGain * 3.28084)} ft`
      : `${Math.round(curElevGain)} m`;
    // Compose metric objects
    const metrics = [
      { label: "Distance", value: fmtDistByUnits(distNow, units) },
      { label: "Time", value: fmtTime(elapsed) },
      { label: "Pace", value: fmtPaceByUnits(curPace, units) },
      { label: "Climb", value: curElevStr },
    ];
    // Draw each metric in its own cell
    const cellW = hudW / metrics.length;
    ctx.textAlign = "center";
    metrics.forEach((m, i) => {
      const cxPos = hudX + i * cellW + cellW / 2;
      // Value (big)
      ctx.fillStyle = layout === "paper" ? "#111" : "#fff";
      ctx.font = `${Math.round(H * 0.035)}px ui-sans-serif`;
      ctx.fillText(m.value, cxPos, hudY + Math.round(hudH * 0.45));
      // Label (small)
      ctx.fillStyle = layout === "paper" ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.75)";
      ctx.font = `${Math.round(H * 0.016)}px ui-sans-serif`;
      ctx.fillText(m.label, cxPos, hudY + Math.round(hudH * 0.75));
    });
    // Compose total metrics row
    const totDistStr = fmtDistByUnits(totalDist, units);
    const totTimeStr = fmtTime(totalTimeMs);
    const totElevStr = units === "mph"
      ? `${Math.round(elevGain * 3.28084)} ft`
      : `${Math.round(elevGain)} m`;
    // Average pace over entire activity (minutes per km)
    const totPaceMinPerKm = totalDist > 0 ? (totalTimeMs / 60000) / (totalDist / 1000) : undefined;
    const totPaceStr = fmtPaceByUnits(totPaceMinPerKm, units);
    const totRow = `Total: ${totDistStr} in ${totTimeStr}  •  Avg pace: ${totPaceStr}  •  Elev: ${totElevStr}`;
    ctx.fillStyle = layout === "paper" ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.7)";
    ctx.font = `${Math.round(H * 0.014)}px ui-sans-serif`;
    ctx.fillText(totRow, hudX + hudW / 2, hudY + Math.round(hudH * 0.96));
    ctx.textAlign = "left";
    // Weather (right) overlay (still fits inside HUD). Position near top right of HUD.
    if (showWeather && weather) {
      const tVal = units === "mph" ? Math.round(weather.tempC * 9/5 + 32) : Math.round(weather.tempC);
      const wVal = units === "mph" ? Math.round(weather.windKmh / 1.609344) : Math.round(weather.windKmh);
      const wxStr = `🌡 ${tVal}${units === "mph" ? "°F" : "°C"}  •  💨 ${wVal} ${units === "mph" ? "mph" : "km/h"}`;
      ctx.textAlign = "right";
      ctx.fillStyle = layout === "paper" ? "#111" : "#fff";
      ctx.font = `${Math.round(H * 0.022)}px ui-sans-serif`;
      ctx.fillText(wxStr, hudX + hudW - Math.round(W * 0.02), hudY + Math.round(hudH * 0.35));
      ctx.textAlign = "left";
    }

    // Mini speed legend
    if (heatOn && speedsMS.length && showLegend){
      const legendW=Math.round(W*0.14), legendBarH=Math.round(H*0.012);
      const {x:x0,y:y0}=legendRect();
      // backdrop for readability
      ctx.fillStyle = layout==="paper" || layout==="map" ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.18)";
      ctx.fillRect(x0-8, y0-8, legendW+16, legendBarH+26);
      for (let i=0;i<legendW;i++){
        const t=i/(legendW-1); ctx.strokeStyle=speedColor(t);
        ctx.beginPath(); ctx.moveTo(x0+i+0.5,y0); ctx.lineTo(x0+i+0.5,y0+legendBarH); ctx.stroke();
      }
      ctx.font = `500 ${Math.round(H*0.016)}px ui-sans-serif`;
      ctx.fillStyle = "#fff";
      ctx.fillText(`${speedStats.loU.toFixed(1)} ${units}`, x0-6, y0+legendBarH+16);
      const hi=`${speedStats.hiU.toFixed(1)} ${units}`; const w = ctx.measureText(hi).width;
      ctx.fillText(hi, x0+legendW+6-w, y0+legendBarH+16);
    }

    // Elevation strip
    const stripPad=Math.round(W*0.08);
    const elevs=samples.map(p=>p.ele ?? 0); const minE=Math.min(...elevs), maxE=Math.max(...elevs), range=Math.max(1,maxE-minE);
    const stripHpx=Math.round(H*0.12);
    ctx.fillStyle = layout==="paper" ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)";
    ctx.fillRect(0, H-stripHpx, W, stripHpx);

    // "Elevation" label (left)
    ctx.fillStyle = layout==="paper" ? "#111" : "#fff";
    ctx.font = `700 ${Math.round(H*0.02)}px ui-sans-serif`;
    ctx.fillText("Elevation", Math.round(W*0.055), H - stripHpx + Math.round(H*0.04));

    // Profile line
    ctx.beginPath();
    for (let i=0;i<samples.length;i++){
      const px=(i/(samples.length-1))*(W-stripPad*2)+stripPad;
      const py=H-Math.round(stripHpx*0.2) - ((elevs[i]-minE)/range)*(stripHpx-Math.round(stripHpx*0.6));
      if (i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
    }
    ctx.strokeStyle = layout==="paper" ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.6)";
    ctx.lineWidth=3; ctx.stroke();

    // progress on strip
    const uptoX=(upto/(samples.length-1))*(W-stripPad*2)+stripPad;
    const uptoY=H-Math.round(stripHpx*0.2) - ((elevs[upto]-minE)/range)*(stripHpx-Math.round(stripHpx*0.6));
    ctx.fillStyle="#22d3ee"; ctx.beginPath(); ctx.arc(uptoX,uptoY,10,0,Math.PI*2); ctx.fill();

    // Footer title
    if (showTitle){
      ctx.font = `600 ${Math.round(H*0.028)}px ui-sans-serif`;
      ctx.fillStyle = layout==="paper" ? "rgba(0,0,0,0.9)" : "rgba(255,255,255,0.95)";
      const raw = titleText?.trim() || (fileName ? fileName.replace(/\.[^.]+$/, "") : "Your Activity");
      const text = raw.slice(0,80);
      const y= H - stripHpx - Math.round(H*0.02);
      const padL = Math.round(W*0.055), padR = Math.round(Math.min(W,H)*0.08);
      const m = ctx.measureText(text);
      if (titleAlign==="left") ctx.fillText(text, padL, y);
      else if (titleAlign==="center") ctx.fillText(text, Math.round(W/2 - m.width/2), y);
      else ctx.fillText(text, Math.round(W - padR - m.width), y);
    }
  };

  /** ===================== Preview loop ===================== */
  useEffect(() => {
  if (!samples.length) {
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, W, H);
    return;
  }

  const step = (ts: number) => {
    if (startRef.current == null) startRef.current = ts;
    const elapsedSec = (ts - startRef.current) / 1000;
    const p = Math.min(1, elapsedSec / durationSec);

    // Draw current frame
    drawFrame(p);

    if (!pausedRef.current) {
      if (p < 1) {
        animRef.current = requestAnimationFrame(step);
      } else {
        // ✅ Final frame: draw once more at exactly 1, then pause & stop
        drawFrame(1);
        pausedRef.current = true;
        animRef.current = null;
        startRef.current = null;
      }
    }
  };

  animRef.current = requestAnimationFrame(step);
  return () => {
    if (animRef.current != null) cancelAnimationFrame(animRef.current);
    animRef.current = null;
    startRef.current = null;
  };
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [
  samples,
  durationSec,
  W,
  H,
  layout,
  heatOn,
  units,
  splitsOn,
  showLegend,
  showTitle,
  titleText,
  titleAlign,
  showWeather,
  pan,
  zoom,
  bgAlpha,
  mapImg,
  bgTick,
  highContrastRoute,
]);


  /** ===================== Weather fetch on demand ===================== */
  useEffect(()=>{
    const run = async ()=>{
      if (!showWeather || !samples.length) return;
      const mid = samples[Math.floor(samples.length/2)];
      const wh = await fetchHistoricalWeather(mid.y, mid.x, samples[0].t, samples.at(-1)!.t);
      if (wh) setWeather(wh);
    };
    run();
  }, [showWeather, samples]);

  /** ===================== 3D map initialization and updates ===================== */
  useEffect(() => {
    // Only initialize in 3D mode with samples and a token
    if (mode !== '3d' || !samples.length || !mapToken) {
      if (map3dRef.current) {
        try { map3dRef.current.remove(); } catch {}
        map3dRef.current = null;
      }
      return;
    }
    let cancelled = false;
    let animId: number | null = null;
    (async () => {
      try {
        const mapboxgl = (await import('mapbox-gl')).default as any;
        mapboxgl.accessToken = mapToken;
        // Destroy any existing map
        if (map3dRef.current) {
          try { map3dRef.current.remove(); } catch {}
          map3dRef.current = null;
        }
        // Create map instance
        const map = new mapboxgl.Map({
          container: mapContainerRef.current!,
          style: `mapbox://styles/mapbox/${mapStyle || 'streets-v12'}`,
          antialias: true,
          preserveDrawingBuffer: true,
        });
        map3dRef.current = map;
        map.addControl(new mapboxgl.NavigationControl());
        map.on('load', () => {
          if (cancelled) return;
          map.resize();
          try { map.setProjection('mercator'); } catch {}
          // DEM terrain
          if (!map.getSource('mapbox-dem')) {
            map.addSource('mapbox-dem', { type: 'raster-dem', url: 'mapbox://mapbox.mapbox-terrain-dem-v1', tileSize: 512, maxzoom: 14 });
            map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.2 });
          }
          // Sky layer
          if (!map.getLayer('sky')) {
            map.addLayer({ id: 'sky', type: 'sky', paint: { 'sky-type': 'atmosphere' } });
          }
          const coords: [number, number][] = samples.map((p) => [p.x, p.y]);
          // Route source & layer
          if (map.getSource('route')) {
            (map.getSource('route') as any).setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } });
          } else {
            map.addSource('route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } } });
          }
          if (!map.getLayer('route-line')) {
            map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#22d3ee', 'line-width': 5, 'line-opacity': 0.95 } });
          }
          // Trail source & layer
          if (!map.getSource('trail')) {
            // Initialize the trail as an empty GeoJSON line. It will be updated every frame when showTrailRef.current is true.
            map.addSource('trail', {
              type: 'geojson',
              data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }
            });
          }
          if (!map.getLayer('trail-line')) {
            // Use a lighter colour and thinner width for the trail so it is distinct from the main route.
            map.addLayer({
              id: 'trail-line',
              type: 'line',
              source: 'trail',
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: {
                'line-color': '#fbbf24',
                'line-width': 4,
                'line-opacity': 0.6
              }
            });
          }
          // Fit bounds and clamp zoom
          const lons = samples.map((s) => s.x), lats = samples.map((s) => s.y);
          const minLon = Math.min(...lons), maxLon = Math.max(...lons);
          const minLat = Math.min(...lats), maxLat = Math.max(...lats);
          const bounds = new (mapboxgl as any).LngLatBounds([minLon, minLat], [maxLon, maxLat]);
          map.fitBounds(bounds, { padding: 60, duration: 0 });
          map.once('moveend', () => {
            const minZoom = 12;
            if (map.getZoom() < minZoom) map.easeTo({ zoom: minZoom, duration: 0 });
            baseZoomRef.current = map.getZoom();
            try { map.setPitch(pitch); map.setBearing(bearing); } catch {}
          });
          // Marker & refs
          // Marker to represent the moving athlete: use a warm color to contrast the route and buildings
          const marker = new mapboxgl.Marker({ color: '#f97316' }).setLngLat(coords[0]).addTo(map);
          markerRef.current = marker;
          trailRef.current = map.getSource('trail');
          // Grab HUD canvas context
          const hudCanvas = hudCanvasRef.current;
          const hudCtx = hudCanvas ? hudCanvas.getContext('2d') : null;
          // Animation variables
          let frame = 0;
          const totalFrames = Math.max(2, Math.round(FPS * durationSec));
          let droneAngle = 0;
          // Precompute route bounding box center for orbit mode
          const centerLonLat: [number, number] = [ (minLon + maxLon) / 2, (minLat + maxLat) / 2 ];
          const animate = () => {
            if (cancelled || mode !== '3d') return;
            frame = (frame + 1) % totalFrames;
            const idx = Math.min(samples.length - 1, Math.floor((frame / totalFrames) * samples.length));
            const curr = coords[idx];
            // update marker position
            marker.setLngLat(curr);
            // update trail using ref
            if (showTrailRef.current && trailRef.current) {
              const sub = coords.slice(0, idx + 1);
              (trailRef.current as any).setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: sub } });
            } else if (trailRef.current) {
              (trailRef.current as any).setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
            }
            // camera modes
            const cm = cameraModeRef.current;
            if (cm === 'behind' || cm === 'ground') {
              // compute heading to next point and smooth it
              const nextIdx = Math.min(samples.length - 1, idx + 1);
              const next = coords[nextIdx];
              const currLon = curr[0], currLat = curr[1];
              const nextLon = next[0], nextLat = next[1];
              const dx = (nextLon - currLon) * Math.cos((currLat * Math.PI) / 180);
              const dy = nextLat - currLat;
              let rawHeading = Math.atan2(dx, dy) * 180 / Math.PI;
              if (rawHeading < 0) rawHeading += 360;
              const prev = lastHeadingRef.current ?? rawHeading;
              let delta = rawHeading - prev;
              if (delta > 180) delta -= 360;
              if (delta < -180) delta += 360;
              // Smooth the heading changes to avoid jitter. Using a smaller factor slows down rapid swings.
              const smoothed = prev + delta * 0.05;
              lastHeadingRef.current = smoothed;
              if (cm === 'ground') {
                // ground: high pitch, ensure high zoom; extend duration for smoother motion
                const gz = Math.max(baseZoomRef.current ?? map.getZoom(), 16);
                map.easeTo({ center: curr as any, bearing: smoothed, pitch: 80, zoom: gz, duration: 300 });
              } else {
                // behind: medium pitch; slightly longer duration for smoother transitions
                map.easeTo({ center: curr as any, bearing: smoothed, pitch: 45, zoom: baseZoomRef.current ?? map.getZoom(), duration: 250 });
              }
            } else if (cm === 'drone') {
              droneAngle += 0.5;
              map.easeTo({ center: curr as any, bearing: droneAngle, pitch: 60, zoom: baseZoomRef.current ?? map.getZoom(), duration: 200 });
            } else if (cm === 'flyover') {
              const progress = frame / totalFrames;
              const startPitch = 75;
              const endPitch = 45;
              const thisPitch = startPitch - (startPitch - endPitch) * progress;
              map.easeTo({ center: curr as any, bearing: map.getBearing(), pitch: thisPitch, zoom: baseZoomRef.current ?? map.getZoom(), duration: 200 });
            } else if (cm === 'orbit') {
              const progress = frame / totalFrames;
              const zoomStart = (baseZoomRef.current ?? map.getZoom()) - 2;
              const zoomEnd = baseZoomRef.current ?? map.getZoom();
              const zoomNow = zoomStart + (zoomEnd - zoomStart) * progress;
              const pitchStart = 80;
              const pitchEnd = 45;
              const pitchNow = pitchStart - (pitchStart - pitchEnd) * progress;
              const bearingNow = 360 * progress;
              map.easeTo({ center: centerLonLat as any, zoom: zoomNow, pitch: pitchNow, bearing: bearingNow, duration: 200 });
            } else if (cm === 'stationary') {
              // Stationary: keep view over the route center with user-defined pitch and bearing
              const z = baseZoomRef.current ?? map.getZoom();
              map.easeTo({ center: centerLonLat as any, bearing: bearingRef.current, pitch: pitchRef.current, zoom: z, duration: 200 });
            } else {
              // Follow: center on current point using current pitch/bearing
              map.easeTo({ center: curr as any, bearing: bearingRef.current, pitch: pitchRef.current, zoom: baseZoomRef.current ?? map.getZoom(), duration: 200 });
            }
            // draw HUD overlay
            if (hudCtx && hudCanvas) {
              hudCanvas.width = previewSize.w;
              hudCanvas.height = previewSize.h;
              hudCtx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
              const p = (samples.length > 1 ? idx / (samples.length - 1) : 0);
              hudCtx.save();
              hudCtx.scale(previewSize.w / W, previewSize.h / H);
              drawHud(hudCtx as any, p, W, H, samples, units, totalDist, totalTimeMs, showTitle, titleText, fileName, showWeather, weather, showLegend, splitsOn, elevGain);
              hudCtx.restore();
            }
            animId = requestAnimationFrame(animate);
          };
          animId = requestAnimationFrame(animate);
        });
      } catch (err: any) {
        console.warn(err);
        setMap3dError('Failed to load 3D map. Make sure mapbox-gl is installed.');
      }
    })();
    return () => {
      cancelled = true;
      if (animId != null) cancelAnimationFrame(animId);
      if (map3dRef.current) {
        try { map3dRef.current.remove(); } catch {}
        map3dRef.current = null;
      }
    };
  }, [mode, samples, mapToken, mapStyle, durationSec]);

  // Update pitch and bearing on the existing 3D map when they change
  useEffect(() => {
    const map = map3dRef.current;
    if (map && mode === '3d') {
      try {
        map.setPitch(pitch);
        map.setBearing(bearing);
      } catch {}
    }
  }, [pitch, bearing, mode]);

  /** ===================== Map static image ===================== */
  // ===================== Map static image =====================
useEffect(() => {
  const load = async () => {
    if (layout !== "map" || !samples.length || !mapToken) {
      setMapImg(null);
      return;
    }
    // compute bbox
    const lons = samples.map(s => s.x), lats = samples.map(s => s.y);
    let minLon = Math.min(...lons), maxLon = Math.max(...lons);
    let minLat = Math.min(...lats), maxLat = Math.max(...lats);

    // pad bbox ~1% to avoid cropping
    const padLon = (maxLon - minLon || 0.001) * 0.01;
    const padLat = (maxLat - minLat || 0.001) * 0.01;
    minLon -= padLon; maxLon += padLon;
    minLat -= padLat; maxLat += padLat;

    // Mapbox static with bbox
    const MAX = 1280, scale = Math.min(MAX / W, MAX / H, 1);
    const reqW = Math.max(200, Math.round(W * scale));
    const reqH = Math.max(200, Math.round(H * scale));
    const bbox = `[${minLon},${minLat},${maxLon},${maxLat}]`;
    // Use the selected style for static backgrounds.  Default to outdoors-v12 if none selected.
    const styleId = mapStyle || 'outdoors-v12';
    const base = `https://api.mapbox.com/styles/v1/mapbox/${styleId}/static`;
    const url =
      `${base}/${bbox}/${reqW}x${reqH}` +
      `?padding=24&attribution=false&logo=false&access_token=${encodeURIComponent(mapToken)}`;

    const img = new Image();
    // important: don't set crossOrigin; allow a straightforward load
    img.onload = () => setMapImg(img);
    img.onerror = () => {
      // fallback to auto with overlay (if bbox fails)
      try {
        const coords = samples.map(p => `${p.x},${p.y}`).join(";");
        const path = `path-5+22d3ee-0.8(${coords})`;
        const autoUrl =
          `${base}/${path}/auto/${reqW}x${reqH}` +
          `?padding=24&attribution=false&logo=false&access_token=${encodeURIComponent(mapToken)}`;
        const img2 = new Image();
        img2.onload = () => setMapImg(img2);
        img2.onerror = () => setMapImg(null);
        img2.src = autoUrl;
      } catch {
        setMapImg(null);
      }
    };
    img.src = url;
  };
  load();
}, [layout, samples, W, H, mapToken, mapStyle]);


  /** ===================== Pointer & click ===================== */
  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    clickGuard.current.moved = false;

    // Legend first — if hit, drag legend only
    const hit = pointerInLegend(e);
    if (showLegend && hit.hit) {
      legendDrag.current = { down: true, offx: legendRect().x - hit.cx, offy: legendRect().y - hit.cy };
      return; // do not start route drag
    }

    // Start route drag
    const r=(e.target as HTMLCanvasElement).getBoundingClientRect();
    drag.current= { down:true, sx:e.clientX-r.left, sy:e.clientY-r.top, ox:pan.x, oy:pan.y };
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>){
    const r=(e.target as HTMLCanvasElement).getBoundingClientRect();
    const cx=e.clientX-r.left, cy=e.clientY-r.top;

    // Legend drag (independent)
    if (legendDrag.current.down){
      const cxx=cx*(W/r.width), cyy=cy*(H/r.height);
      const nx=cxx + legendDrag.current.offx, ny=cyy + legendDrag.current.offy;
      setLegendXY({ x:Math.max(10,Math.min(W-10,nx)), y:Math.max(10,Math.min(H-10,ny)) });
      clickGuard.current.moved=true;
      return;
    }

    // Route drag
    if (drag.current.down){
      const nx = drag.current.ox + (cx - drag.current.sx) * (W/r.width);
      const ny = drag.current.oy + (cy - drag.current.sy) * (H/r.height);
      if (Math.abs(nx-drag.current.ox)+Math.abs(ny-drag.current.oy)>2) clickGuard.current.moved=true;
      setPan({ x:nx, y:ny });
    }
  }
  function onPointerUp(){
    drag.current.down=false; legendDrag.current.down=false; clickGuard.current.moved=false;
  }
  function onCanvasClick() {
  if (clickGuard.current.moved) return;

  // Toggle paused state
  const nowPaused = !pausedRef.current;
  pausedRef.current = nowPaused;

  if (nowPaused) {
    // Pausing: cancel any RAF
    if (animRef.current != null) cancelAnimationFrame(animRef.current);
    animRef.current = null;
    return;
  }

  // Resuming (or starting after reaching the end): restart clock
  if (animRef.current == null) {
    startRef.current = null;
    const step = (ts: number) => {
      const s0 = startRef.current ?? (startRef.current = ts);
      const p = Math.min(1, ((ts - s0) / 1000) / durationSec);

      drawFrame(p);

      if (!pausedRef.current) {
        if (p < 1) {
          animRef.current = requestAnimationFrame(step);
        } else {
          // ✅ Stop at final frame
          drawFrame(1);
          pausedRef.current = true;
          animRef.current = null;
          startRef.current = null;
        }
      }
    };
    animRef.current = requestAnimationFrame(step);
  }
}


  /** ===================== File load ===================== */
  async function onFile(f?: File){
    if (!f) return;
    setFileName(f.name); setStatus("Parsing GPX…");
    let pts = await parseGpx(f);
    pts = smoothElev(pts);
    pts = removeSpikes(pts);
    if (privacyM>0 && pts.length>50) pts = trimPrivacy(pts, privacyM);
    if (pts.length<2){ setStatus("This GPX has too few usable points."); setSamples([]); return; }
    const smp = resample(pts, 30, durationSec).filter(p=>isFinite(p.x)&&isFinite(p.y));
    if (smp.length<2){ setStatus("No drawable points in this GPX."); setSamples([]); return; }
    setSamples(smp);
    setPan({x:0,y:0}); setZoom(1);
    setStatus(`Loaded ${pts.length} points → ${smp.length} frames.`);
    if (showWeather){
      try { const mid=pts[Math.floor(pts.length/2)]; const wh=await fetchHistoricalWeather(mid.lat, mid.lon, pts[0].t, pts.at(-1)!.t); if (wh) setWeather(wh); } catch {}
    }
  }

  /** ===================== Export (ffmpeg.wasm v0.12) ===================== */
  async function ensureFFmpeg(){
    if (ffmpeg) return ffmpeg;
    setLoadingFfmpeg(true);
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const inst:any = new FFmpeg();
    await inst.load();
    setFfmpeg(inst);
    setLoadingFfmpeg(false);
    return inst;
  }
  async function cancelExport(){
    abortRef.current=true;
    try{ await ffmpeg?.terminate?.(); }catch{}
    setPhase(""); setProgress(0); setStatus("Export canceled.");
  }
  async function exportMp4(){
    if (!samples.length) return;
    abortRef.current=false;
    try{
      setStatus("Encoding: preparing frames…"); setPhase("frames"); setProgress(0);
      const ff=await ensureFFmpeg();
      if (!offscreenRef.current) offscreenRef.current=document.createElement("canvas");
      const oc=offscreenRef.current!; oc.width=W; oc.height=H;
      const octx=oc.getContext("2d")!;
      const totalFrames=Math.max(2,Math.round(30*durationSec));
      for (let i=0;i<totalFrames;i++){
        if (abortRef.current) throw new Error("Canceled");
        const p=i/(totalFrames-1);
        drawFrame(p);
        octx.clearRect(0,0,W,H);
        octx.drawImage(canvasRef.current!,0,0);
        const blob:Blob = await new Promise(res=>oc.toBlob(b=>res(b!),"image/png"));
        const u8=new Uint8Array(await blob.arrayBuffer());
        const name=`frame_${String(i).padStart(5,"0")}.png`;
        await ff.writeFile(name, u8);
        if (i%2===0) setProgress(i/(totalFrames-1));
      }
      setStatus("Encoding: running ffmpeg…"); setPhase("encoding"); setProgress(0);
      const re=/frame=\s*([0-9]+)/;
      ff.on?.("log", ({message}:any)=>{ const m=re.exec(message); if (m) setProgress(Math.min(1, parseInt(m[1],10)/totalFrames)); });
      const output="out.mp4";
      const args = quality==="fast"
        ? ["-y","-framerate","30","-i","frame_%05d.png","-v","warning","-stats","-c:v","mpeg4","-q:v","5","-pix_fmt","yuv420p","-movflags","+faststart","-vf","pad=ceil(iw/2)*2:ceil(ih/2)*2",output]
        : ["-y","-framerate","30","-i","frame_%05d.png","-v","warning","-stats","-c:v","libx264","-crf","20","-preset","veryfast","-pix_fmt","yuv420p","-movflags","+faststart","-vf","pad=ceil(iw/2)*2:ceil(ih/2)*2",output];
      await ff.exec(args);
      const data:Uint8Array = await ff.readFile(output);
      const url = URL.createObjectURL(new Blob([data],{type:"video/mp4"}));
      // cleanup
      try{ for (let i=0;i<totalFrames;i++) await ff.deleteFile(`frame_${String(i).padStart(5,"0")}.png`); await ff.deleteFile(output); }catch{}
      // download
      const a=document.createElement("a");
      a.href=url; const base=(fileName?fileName.replace(/\.[^.]+$/,""):"route"); a.download=`${base}_${labelSuffix}_${units}_${quality==="fast"?"fast":"hq"}.mp4`; a.click();
      URL.revokeObjectURL(url);
      setStatus("Export complete ✓");
    }catch(e:any){
      setStatus(e?.message==="Canceled" ? "Export canceled." : `Export failed: ${e?.message||e}`);
    }finally{
      setPhase(""); setProgress(0); abortRef.current=false;
    }
  }

  /** ===================== UI ===================== */
  return (
    <main style={{ minHeight:"100vh", background:"#0f1216", color:"#fff", fontFamily:"ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto" }}>
      <GlobalCSS />
      <div style={{ maxWidth:1100, margin:"0 auto", padding:"32px 20px 120px" }}>
        <h1 style={{ fontSize:28, fontWeight:700 }}>Route Animator (MVP)</h1>
        <p style={{ opacity:0.9, marginTop:4 }}>Upload a GPX, preview (click to pause/resume), drag to pan, zoom, choose layout (Night Grid by default), export MP4. Toggle between 2D and experimental 3D modes.</p>

        {/* Mode toggle */}
        <h3 style={{ marginTop:16, marginBottom:6, opacity:0.8, fontWeight:600 }}>Mode</h3>
        <div className="group">
          <label className="chip">
            <input type="radio" name="mode" checked={mode === '2d'} onChange={() => setMode('2d')} />
            <span>2D</span>
          </label>
          <label className="chip">
            <input type="radio" name="mode" checked={mode === '3d'} onChange={() => setMode('3d')} />
            <span>3D (beta)</span>
          </label>
        </div>

        {/* File */}
        <h3 style={{ marginTop:16, marginBottom:6, opacity:0.8, fontWeight:600 }}>File</h3>
        <div className="group">
          <label className="chip" style={{ cursor:"pointer" }}>
            <input type="file" accept=".gpx" style={{ display:"none" }} onChange={(e)=>onFile(e.target.files?.[0] || undefined)} />
            <span>📂 Upload GPX</span>
          </label>

          <div className="chip">
            <span>Aspect</span>
            <select value={aspect} onChange={(e)=>setAspect(e.target.value as Aspect)}>
              <option value="vertical">Vertical (1080×1920)</option>
              <option value="square">Square (1080×1080)</option>
              <option value="wide">Wide (1920×1080)</option>
            </select>
          </div>

          <div className="chip">
            <span>Duration</span>
            <select value={durationSec} onChange={(e)=>setDurationSec(parseInt(e.target.value))}>
              <option value={10}>10s</option><option value={20}>20s</option><option value={30}>30s</option>
            </select>
          </div>

          <div className="chip">
            <span>Privacy</span>
            <select value={privacyM} onChange={(e)=>setPrivacyM(parseInt(e.target.value))}>
              <option value={0}>Off</option><option value={120}>120 m</option><option value={200}>200 m</option><option value={300}>300 m</option>
            </select>
          </div>

          {/* Reset only relevant for 2D canvas */}
          {mode === '2d' && (
            <button className="btn btn-ghost" onClick={()=>{ setPan({x:0,y:0}); setZoom(1); }}>Reset position</button>
          )}
        </div>

        {/* Preview / 3D View */}
        {mode === '2d' ? (
          <div className="panel" style={{ marginTop:16, display:"grid", placeItems:"center" }}>
            <canvas
              ref={canvasRef}
              width={W}
              height={H}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              onClick={onCanvasClick}
              style={{ width: previewSize.w, height: previewSize.h, borderRadius: 12, cursor: "grab", maxWidth: "100%" }}
            />
            <p style={{ marginTop:10, opacity:0.7 }}>Preview (click to {pausedRef.current ? "play" : "pause"}, drag to reposition, use Zoom). Export is {labelSuffix}.</p>
          </div>
        ) : (
          <div className="panel" style={{ marginTop:16 }}>
            {/* Map container with overlay canvas */}
            <div style={{ position:'relative', width: previewSize.w, height: previewSize.h, borderRadius: 12, maxWidth:'100%', overflow:'hidden' }}>
              <div
                ref={mapContainerRef}
                style={{ position:'absolute', top:0, left:0, width:'100%', height:'100%' }}
              />
              <canvas
                ref={hudCanvasRef}
                style={{ position:'absolute', top:0, left:0, width:'100%', height:'100%', pointerEvents:'none' }}
              />
            </div>
            {/* 3D Controls */}
            <div className="group" style={{ marginTop:12 }}>
              <div className="chip" style={{ gap:12 }}>
                <span>Pitch</span>
                <input className="range" type="range" min={0} max={60} step={1} value={pitch} onChange={(e)=>setPitch(parseFloat(e.target.value))} />
              </div>
              <div className="chip" style={{ gap:12 }}>
                <span>Bearing</span>
                <input className="range" type="range" min={0} max={360} step={1} value={bearing} onChange={(e)=>setBearing(parseFloat(e.target.value))} />
              </div>
              <label className="chip"><input type="checkbox" checked={showTrail} onChange={(e)=>setShowTrail(e.target.checked)} /><span>Trailing line</span></label>

              {/* Camera mode selector */}
              <div className="chip">
                <span>Camera</span>
                <select value={cameraMode} onChange={(e) => setCameraMode(e.target.value as any)}>
                  <option value="follow">Follow</option>
                  <option value="behind">Behind</option>
                  <option value="drone">Drone</option>
                  <option value="flyover">Flyover</option>
                  <option value="ground">Ground</option>
                  <option value="orbit">Orbit</option>
                  <option value="stationary">Stationary</option>
                </select>
              </div>
              {/* Map style selector in 3D */}
              <div className="chip">
                <span>Style</span>
                <select value={mapStyle} onChange={(e) => setMapStyle(e.target.value)}>
                  <option value="streets-v12">Streets</option>
                  <option value="outdoors-v12">Outdoors</option>
                  <option value="satellite-streets-v12">Satellite streets</option>
                  <option value="satellite-v9">Satellite</option>
                  <option value="light-v11">Light</option>
                  <option value="dark-v11">Dark</option>
                  <option value="standard">Standard</option>
                  <option value="standard-satellite">Standard Satellite</option>
                </select>
              </div>
            </div>
            {map3dError && (
              <p style={{ color:"#f43f5e", marginTop:8, fontSize:14 }}>{map3dError}</p>
            )}
          </div>
        )}

        {mode === '2d' && (
          <>
            {/* Visual */}
            <h3 style={{ marginTop:18, marginBottom:6, opacity:0.8, fontWeight:600 }}>Visual</h3>
            <div className="group">
              <div className="chip">
                <span>Layout</span>
                <select value={layout} onChange={(e)=>setLayout(e.target.value as Layout)}>
                  <option value="grid">Night grid</option>
                  <option value="minimal">Minimal dark</option>
                  <option value="paper">Paper topo</option>
                  <option value="transparent">Transparent (upload bg)</option>
                  <option value="map">Map (Mapbox static)</option>
                </select>
              </div>

              <div className="chip" style={{ gap:12 }}>
                <span>Zoom</span>
                <input className="range" type="range" min={0.5} max={2} step={0.05} value={zoom} onChange={(e)=>setZoom(parseFloat(e.target.value))} />
              </div>

              <label className="chip"><input type="checkbox" checked={highContrastRoute} onChange={(e)=>setHighContrastRoute(e.target.checked)} /><span>High-contrast route</span></label>

              {layout === 'transparent' && (
                <>
                  <div className="chip">
                    <span>Background</span>
                    <select value={bgKind} onChange={(e)=>setBgKind(e.target.value as any)}>
                      <option value="none">None</option><option value="image">Image</option><option value="video">Video</option>
                    </select>
                  </div>
                  {bgKind === 'image' && (
                    <label className="chip" style={{ cursor:"pointer" }}>
                      <input type="file" accept="image/*" style={{ display:"none" }}
                        onChange={(e)=>{
                          const f=e.target.files?.[0]; if(!f) return;
                          const url=URL.createObjectURL(f);
                          const img=new Image();
                          img.onload=()=>{ bgImgRef.current=img; setBgTick(t=>t+1); };
                          img.src=url;
                        }} />
                      <span>Upload image</span>
                    </label>
                  )}
                  {bgKind === 'video' && (
                    <label className="chip" style={{ cursor:"pointer" }}>
                      <input type="file" accept="video/*" style={{ display:"none" }}
                        onChange={(e)=>{
                          const f=e.target.files?.[0]; if(!f) return;
                          const url=URL.createObjectURL(f);
                          const v=document.createElement("video");
                          v.src=url; v.crossOrigin="anonymous"; v.muted=true; v.loop=true; v.playsInline=true;
                          v.onloadeddata=()=>{ bgVidRef.current=v; setBgVidReady(true); setBgTick(t=>t+1); v.play().catch(()=>{}); };
                        }} />
                      <span>Upload video</span>
                    </label>
                  )}
                  <div className="chip" style={{ gap:12 }}>
                    <span>Background transparency</span>
                    <input className="range" type="range" min={0} max={1} step={0.05} value={bgAlpha} onChange={(e)=>setBgAlpha(parseFloat(e.target.value))} />
                  </div>
                </>
              )}

              {layout === 'map' && (
                <>
                  {/* Map static parameters */}
                  <div className="chip">
                    <span>Map style</span>
                    <select value={mapStyle} onChange={(e) => setMapStyle(e.target.value)}>
                      <option value="streets-v12">Streets</option>
                      <option value="outdoors-v12">Outdoors</option>
                      <option value="satellite-streets-v12">Satellite streets</option>
                      <option value="satellite-v9">Satellite</option>
                      <option value="light-v11">Light</option>
                      <option value="dark-v11">Dark</option>
                    </select>
                  </div>
                  <input type="text" className="chip" style={{ minWidth:220, background:"rgba(255,255,255,0.06)", color:"#fff" }}
                         value={mapToken} onChange={(e)=>setMapToken(e.target.value)} placeholder="Mapbox token" />
                  <span style={{ opacity:0.7, fontSize:12 }}>Token is client-side; rotate if publishing.</span>
                </>
              )}
            </div>
          </>
        )}

        {mode === '2d' && (
          <>
            {/* Overlays */}
            <h3 style={{ marginTop:18, marginBottom:6, opacity:0.8, fontWeight:600 }}>Overlays</h3>
            <div className="group">
              <label className="chip"><input type="checkbox" checked={heatOn} onChange={(e)=>setHeatOn(e.target.checked)} /><span>Speed heat coloring</span></label>
              <label className="chip"><input type="checkbox" checked={showLegend} onChange={(e)=>setShowLegend(e.target.checked)} /><span>Mini speed bar (draggable)</span></label>
              <div className="chip">
                <span>Units</span>
                <select value={units} onChange={(e)=>setUnits(e.target.value as Units)}>
                  <option value="mph">mph</option><option value="kmh">km/h</option>
                </select>
              </div>
              <label className="chip"><input type="checkbox" checked={splitsOn} onChange={(e)=>setSplitsOn(e.target.checked)} /><span>Split markers + pulse</span></label>
              <label className="chip"><input type="checkbox" checked={showTitle} onChange={(e)=>setShowTitle(e.target.checked)} /><span>Show title</span></label>
              <input className="chip" style={{ minWidth:160, background:"rgba(255,255,255,0.06)", color:"#fff" }}
                     value={titleText} onChange={(e)=>setTitleText(e.target.value)} placeholder="Custom title (optional)" />
              <div className="chip">
                <span>Title align</span>
                <select value={titleAlign} onChange={(e)=>setTitleAlign(e.target.value as any)}>
                  <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
                </select>
              </div>
              <label className="chip"><input type="checkbox" checked={showWeather} onChange={(e)=>setShowWeather(e.target.checked)} /><span>Weather (historical in HUD)</span></label>
            </div>

            {/* Export */}
            <h3 style={{ marginTop:18, marginBottom:6, opacity:0.8, fontWeight:600 }}>Export</h3>
            <div className="group">
              <div className="chip">
                <span>Quality</span>
                <select value={quality} onChange={(e)=>setQuality(e.target.value as Quality)}>
                  <option value="fast">Fast (MPEG-4)</option><option value="high">High (H.264)</option>
                </select>
              </div>
              <button className="btn btn-primary" onClick={exportMp4} disabled={!samples.length || loadingFfmpeg}>
                {loadingFfmpeg ? "Loading encoder…" : "Export MP4"}
              </button>
              <button className="btn btn-ghost" onClick={cancelExport}>Cancel</button>
            </div>
            <p style={{ marginTop:8, minHeight:24, opacity:0.85 }}>{status}</p>
            {phase && (
              <div style={{ marginTop:8, width:"100%", maxWidth:600 }}>
                <div style={{ fontSize:12, opacity:.8, marginBottom:6 }}>
                  {phase === "frames" ? "Preparing frames…" : "Encoding video…"} {Math.round(progress*100)}%
                </div>
                <div style={{ height:10, background:"rgba(255,255,255,0.12)", borderRadius:6, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${Math.round(progress*100)}%`, background:"#22d3ee" }} />
                </div>
              </div>
            )}
          </>
        )}

      </div>
    </main>
  );
}
