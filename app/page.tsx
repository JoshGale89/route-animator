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
    .panel { background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:16px; padding:16px; }
    .range { accent-color:#22d3ee; }
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
    if (aspect==="square") return { W:1080, H:1080, labelSuffix:"1080x1080", previewSize:{ w:480, h:480 } };
    if (aspect==="wide")   return { W:1920, H:1080, labelSuffix:"1920x1080", previewSize:{ w:640, h:360 } };
    return { W:1080, H:1920, labelSuffix:"1080x1920", previewSize:{ w:360, h:640 } };
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
    const cvs=canvasRef.current!; cvs.width=W; cvs.height=H;
    const ctx=cvs.getContext("2d")!; ctx.clearRect(0,0,W,H);

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
    const hudH = Math.round(H*0.12);
    const stripH = Math.round(H*0.12);
    const sidePad = Math.round(Math.min(W,H)*0.08);
    const projector = makeProjector(samples, W, H,
      { left:sidePad, right:sidePad, top:Math.round(H*0.03)+hudH+16, bottom:stripH+16 },
      pan, zoom
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

    // Splits (labels + celebratory pulse)
    if (splitsOn && totalDist>0) {
      const unit = units==="mph" ? 1609.344 : 1000;
      ctx.fillStyle = layout==="paper" ? "#000" : "#fff";
      ctx.font = `600 ${Math.round(H*0.022)}px ui-sans-serif`;
      for (let m=unit, n=1; m<totalDist; m+=unit, n++){
        let idx=samples.findIndex(s=>s.d>=m); if (idx<0) idx=samples.length-1;
        const {x,y}=projector.toXY(samples[idx]);
        ctx.beginPath(); ctx.arc(x,y,Math.max(8,Math.round(Math.min(W,H)*0.012)),0,Math.PI*2); ctx.fill();
        const lab = units==="mph" ? `${n} mi` : `${n} km`;
        ctx.fillText(lab, x+10, y-10);
      }
      // celebratory pulse
      const pulseWindowFrames = Math.round(0.5*30);
      ctx.strokeStyle="#22d3ee";
      for (let n=0;n<splitIdxs.length;n++){
        const si=splitIdxs[n], df=Math.abs(upto-si);
        if (df<=pulseWindowFrames){
          const k=1-df/pulseWindowFrames, ease=1-Math.pow(1-k,2);
          const {x,y}=projector.toXY(samples[si]);
          ctx.lineWidth=Math.max(3,Math.round(Math.min(W,H)*0.012));
          ctx.shadowColor="#22d3ee"; ctx.shadowBlur=Math.round(Math.min(W,H)*0.02);
          ctx.beginPath();
          ctx.arc(x,y,Math.max(18,Math.round(Math.min(W,H)*0.04))*(1+0.8*ease),0,Math.PI*2);
          ctx.stroke(); ctx.shadowBlur=0;
          // sparks
          const sparks=12;
          for (let s=0;s<sparks;s++){
            const ang=(s/sparks)*Math.PI*2; const len=Math.round(Math.min(W,H)*(0.02+0.03*ease));
            ctx.beginPath(); ctx.moveTo(x+Math.cos(ang)*len*0.6, y+Math.sin(ang)*len*0.6);
            ctx.lineTo(x+Math.cos(ang)*len, y+Math.sin(ang)*len); ctx.stroke();
          }
        }
      }
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

    // HUD panel color (darker on light layouts)
    const hudBg =
      layout==="paper" || layout==="map"
        ? "rgba(0,0,0,0.28)" // ✅ darker on light backgrounds
        : "rgba(255,255,255,0.06)";

    // HUD top
    const hudY = Math.round(H*0.03);
    ctx.fillStyle = hudBg;
    ctx.fillRect(Math.round(W*0.055), hudY, Math.round(W*0.89), Math.round(H*0.12));

    ctx.fillStyle = layout==="paper" ? "#f3f3f3" : "#fff";
    ctx.font = `700 ${Math.round(H*0.033)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    const elapsed = totalTimeMs * progress01;
    const distNow = totalDist * progress01;
    const curPace = smoothedPaceAt(samples, upto, 8);
    ctx.fillText(`${fmtDistByUnits(distNow, units)}  •  ${fmtTime(elapsed)}`, Math.round(W*0.08), Math.round(H*0.085));

    ctx.font = `500 ${Math.round(H*0.024)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = layout==="paper" ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.9)";
    ctx.fillText(`Pace: ${fmtPaceByUnits(curPace, units)}   •   Total: ${fmtDistByUnits(totalDist, units)} in ${fmtTime(totalTimeMs)}`, Math.round(W*0.08), Math.round(H*0.115));

    // Weather (right)
    if (showWeather && weather){
      const t = units==="mph" ? Math.round(weather.tempC*9/5+32) : Math.round(weather.tempC);
      const w = units==="mph" ? Math.round(weather.windKmh/1.609344) : Math.round(weather.windKmh);
      ctx.textAlign="right"; ctx.fillStyle = layout==="paper" ? "#f3f3f3" : "#fff";
      ctx.font = `600 ${Math.round(H*0.022)}px ui-sans-serif`;
      ctx.fillText(`🌡 ${t}${units==="mph"?"°F":"°C"}  •  💨 ${w} ${units==="mph"?"mph":"km/h"}`, W - Math.round(W*0.08), Math.round(H*0.085));
      ctx.textAlign="left";
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

  /** ===================== Map static image ===================== */
  useEffect(()=>{
    const load = async ()=>{
      if (layout!=="map" || !samples.length || !mapToken) { setMapImg(null); return; }
      const { centerLat, centerLon, zoom } = calcCenterZoom(samples, W, H);
      const MAX=1280, scale=Math.min(MAX/W, MAX/H, 1);
      const reqW=Math.max(200, Math.round(W*scale)), reqH=Math.max(200, Math.round(H*scale));
      const url = `https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/static/${centerLon},${centerLat},${zoom},0,0/${reqW}x${reqH}?access_token=${encodeURIComponent(mapToken)}&attribution=false&logo=false`;
      const img=new Image(); img.crossOrigin="anonymous";
      img.onload=()=>setMapImg(img); img.onerror=()=>setMapImg(null); img.src=url;
    };
    load();
  }, [layout, samples, W, H, mapToken]);

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
    <main style={{ minHeight:"100vh", background:"#0b0f14", color:"#fff", fontFamily:"ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto" }}>
      <GlobalCSS />
      <div style={{ maxWidth:1100, margin:"0 auto", padding:"32px 20px 120px" }}>
        <h1 style={{ fontSize:28, fontWeight:700 }}>Route Animator (MVP)</h1>
        <p style={{ opacity:0.9, marginTop:4 }}>Upload a GPX, preview (click to pause/resume), drag to pan, zoom, choose layout (Night Grid by default), export MP4.</p>

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

          <button className="btn btn-ghost" onClick={()=>{ setPan({x:0,y:0}); setZoom(1); }}>Reset position</button>
        </div>

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

          {layout==="transparent" && (
            <>
              <div className="chip">
                <span>Background</span>
                <select value={bgKind} onChange={(e)=>setBgKind(e.target.value as any)}>
                  <option value="none">None</option><option value="image">Image</option><option value="video">Video</option>
                </select>
              </div>
              {bgKind==="image" && (
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
              {bgKind==="video" && (
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

          {layout==="map" && (
            <>
              <input type="text" className="chip" style={{ minWidth:340, background:"rgba(255,255,255,0.06)", color:"#fff" }}
                     value={mapToken} onChange={(e)=>setMapToken(e.target.value)} placeholder="Mapbox token" />
              <span style={{ opacity:0.7, fontSize:12 }}>Token is client-side; rotate if publishing.</span>
            </>
          )}
        </div>

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
              {phase==="frames" ? "Preparing frames…" : "Encoding video…"} {Math.round(progress*100)}%
            </div>
            <div style={{ height:10, background:"rgba(255,255,255,0.12)", borderRadius:6, overflow:"hidden" }}>
              <div style={{ height:"100%", width:`${Math.round(progress*100)}%`, background:"#22d3ee" }} />
            </div>
          </div>
        )}

        {/* Preview */}
        <div className="panel" style={{ marginTop:12, display:"grid", placeItems:"center" }}>
          <canvas
            ref={canvasRef}
            width={W}
            height={H}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onClick={onCanvasClick}
            style={{ width:previewSize.w, height:previewSize.h, borderRadius:12, cursor:"grab" }}
          />
          <p style={{ marginTop:10, opacity:0.7 }}>Preview (click to {pausedRef.current ? "play" : "pause"}, drag to reposition, use Zoom). Export is {labelSuffix}.</p>
        </div>
      </div>
    </main>
  );
}
