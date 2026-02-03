// background.js

// Cross-browser handle
const B = typeof browser !== 'undefined' ? browser : chrome;

// ---- Settings (overridable via storage) ----
const FINAL_SIZE = 1000;            // canvas size = 1000x1000
const SAFE_BOX = 618;               // Canva-like safe box for longest side
const JPEG_QUALITY = 1.0;           // export quality
const DOWNLOAD_DELAY_MS = 400;      // sequential download delay

// Allowed extensions for *sources*
const ALLOWED_EXT = ["jpg","jpeg","png","webp","avif","tiff","tif","heic","gif"]; // Utökad lista

// crude blocklist (lowercased substrings)
const URL_BLOCKLIST = [
  'klarna', 'trygg', 'trustly', 'facebook', 'google', 'doubleclick',
  'avatar', 'icon', 'logo', 'placeholder', 'sprite', 'analytics',
  'badge', 'tracking'
];

function baseDomain(host) {
  if (!host) return '';
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

// -------- Utilities --------
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function sanitizeName(name){
  const fallback = 'produkt';
  const s = (name||fallback).trim().replace(/[\/:*?"<>|\n\r\t]+/g, '_').slice(0, 100);
  return s || fallback;
}

function stripQueryHash(u){
  try { const url = new URL(u); url.hash=''; url.search=''; return url.toString(); }
  catch { return (u||'').split('#')[0].split('?')[0]; }
}

function extOf(u){
  const clean = stripQueryHash(u);
  const m = /\.([a-zA-Z0-9]{2,5})$/.exec(clean);
  return m ? m[1].toLowerCase() : '';
}

function isAllowedUrl(u){
  const e = extOf(u);
  if (!ALLOWED_EXT.includes(e)) return false;
  const lower = u.toLowerCase();
  if (URL_BLOCKLIST.some(s => lower.includes(s))) return false;
  return true;
}

// ---- FÖRBÄTTRAD: Smartare dubblettfiltrering ----
// Denna funktion förstår att ?v=1 och ?v=2 KAN vara olika bilder.
// Den jämför HELA URL:en (inkl. query) men prioriterar filtyper enligt din spec.
function choosePreferredByPath(urls) {
    // Prioritetsordning: TIFF (högst), PNG, HEIC/AVIF, JPEG, GIF (lägst)
    const rank = { 
        tiff: 10, 
        tif: 10,
        png: 9, 
        heic: 8,
        avif: 8, 
        jpeg: 7, 
        jpg: 7,
        webp: 6,
        gif: 5
    };
    
    const byBase = new Map();

    for (const u of urls) {
        // ÄNDRING: Använd HELA URL:en utan endast hash som bas
        // Detta betyder att ?v=1 och ?v=2 behandlas som OLIKA bilder
        let basePath;
        try {
            const url = new URL(u);
            url.hash = ''; // Ta bara bort hash
            basePath = url.toString();
        } catch {
            basePath = u.split('#')[0]; // Fallback
        }

        const e = extOf(u);
        const r = rank[e] || 0;

        const prev = byBase.get(basePath);
        
        // Behåll endast om:
        // 1. Vi inte sett denna exakta URL förut, ELLER
        // 2. Den nya filtypen har högre prioritet
        if (!prev || r > prev.rank) {
            byBase.set(basePath, { url: u, rank: r });
        }
    }
    
    return Array.from(byBase.values()).map(x => x.url);
}


// Fetch as blob with referrerless request when possible
async function fetchBlob(url){
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.blob();
  } catch (e) {
    throw e;
  }
}

// Simple SHA-1 of an ArrayBuffer
async function sha1(arrayBuffer){
  const buf = await crypto.subtle.digest('SHA-1', arrayBuffer);
  const view = new DataView(buf);
  let hex = '';
  for (let i=0; i<view.byteLength; i++){
    const b = view.getUint8(i).toString(16).padStart(2, '0');
    hex += b;
  }
  return hex;
}

// Decode a blob into ImageBitmap
async function toBitmap(blob){
  return await createImageBitmap(blob);
}

// Optional background removal
function maybeRemoveBgToAlpha(ctx, w, h){
  const sample = (x, y) => ctx.getImageData(x, y, 1, 1).data;
  const c = [sample(0,0), sample(w-1,0), sample(0,h-1), sample(w-1,h-1)];
  const isWhiteish = (p) => p[0]>245 && p[1]>245 && p[2]>245;
  const whiteCorners = c.filter(isWhiteish).length;
  if (whiteCorners < 3) return;

  const img = ctx.getImageData(0,0,w,h);
  const d = img.data;
  for (let i=0; i<d.length; i+=4){
    if (d[i]>245 && d[i+1]>245 && d[i+2]>245){
      d[i+3] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Render into 1000x1000 with white background and SAFE_BOX scaling
async function renderToJpeg(blob, removeBg){
  const bmp = await toBitmap(blob);
  const srcW = bmp.width, srcH = bmp.height;

  const scale = Math.min(SAFE_BOX / srcW, SAFE_BOX / srcH);
  const dstW = Math.max(1, Math.round(srcW * scale));
  const dstH = Math.max(1, Math.round(srcH * scale));
  const off = new OffscreenCanvas(FINAL_SIZE, FINAL_SIZE);
  const ctx = off.getContext('2d', { alpha: true });

  const temp = new OffscreenCanvas(srcW, srcH);
  const tctx = temp.getContext('2d', { alpha: true });
  tctx.drawImage(bmp, 0, 0);
  if (removeBg) {
    try { maybeRemoveBgToAlpha(tctx, srcW, srcH); } catch {}
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, FINAL_SIZE, FINAL_SIZE);

  const dx = Math.floor((FINAL_SIZE - dstW) / 2);
  const dy = Math.floor((FINAL_SIZE - dstH) / 2);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(temp, 0, 0, srcW, srcH, dx, dy, dstW, dstH);

  const blobOut = await off.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  const ab = await blobOut.arrayBuffer();
  const hash = await sha1(ab);
  return { blob: blobOut, hash };
}

async function downloadBlob(blob, filename, saveAs, conflictAction='uniquify'){
  const url = URL.createObjectURL(blob);
  try {
    const id = await new Promise((resolve, reject) => {
      try {
        B.downloads.download({ url, filename, saveAs: !!saveAs, conflictAction }, (downloadId) => {
          const le = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError : null;
          if (le) return reject(le);
          resolve(downloadId);
        });
      } catch (e) { reject(e); }
    });
    return id;
  } finally {
    setTimeout(()=>URL.revokeObjectURL(url), 15000);
  }
}

async function handleDownloadImages(msg){
  const { urls = [], productName = 'produkt' } = msg || {};
  if (!urls.length) return;

  // Hämta alla inställningar, inklusive den nya "allowNoExtension"
  const st = await new Promise((res)=>{
    const defaults = { askWhere:false, removeBgHeuristic:true, allowNoExtension: false };
    try { B.storage.local.get(defaults, (o)=>res(o||{})); }
    catch { B.storage.local.get(defaults).then(res); }
  });
  const { saveAs, removeBg, allowNoExtension } = st;

  // KRITISK FIX: Använd urls-arrayen DIREKT i den ordning användaren valde
  // URLs kommer redan i rätt ordning från popup (SELECTION_ORDER)
  const safeBase = sanitizeName(productName);
  const pad = (n, width) => String(n).padStart(width, '0');
  const digits = String(urls.length).length || 1;
  const seenHashes = new Set();
  let fileCounter = 0;

  // Iterera genom URLs i exakt den ordning de skickades
  for (const u of urls){
    try {
      const srcBlob = await fetchBlob(u);
      const { blob: outBlob, hash } = await renderToJpeg(srcBlob, removeBg);

      // Hoppa över dubbletter baserat på bildinnehåll (hash)
      if (seenHashes.has(hash)) {
        await sleep(40);
        continue;
      }
      seenHashes.add(hash);

      fileCounter++;
      const fname = `${safeBase}/${pad(fileCounter, digits)}_${safeBase}.jpg`;
      
      await downloadBlob(outBlob, fname, saveAs, 'uniquify');
      await sleep(DOWNLOAD_DELAY_MS);
    } catch (e) {
      console.warn('Failed for', u, e);
      await sleep(120);
    }
  }
}

B.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'downloadImages'){
    (async()=>{ await handleDownloadImages(msg); })();
    sendResponse && sendResponse({ ok: true });
    return true;
  }
});

// Lyssnare som öppnar popup automatiskt
B.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Kör bara när sidan är helt färdigladdad och har en http/https-URL
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
    
    // Använd hjälpfunktionen för att få basdomänen
    const url = new URL(tab.url);
    const bdom = baseDomain(url.hostname);

    // Hämta listan över tillåtna domäner från storage
    B.storage.local.get({ allowedDomains: {} }, (storage) => {
      // Om ett fel uppstod, avbryt
      if (B.runtime.lastError) {
        console.warn("Kunde inte läsa storage:", B.runtime.lastError.message);
        return;
      }
      
      // Kontrollera om domänen är aktiverad
      if (storage.allowedDomains && storage.allowedDomains[bdom]) {
        
        // Öppna popup automatiskt
        if (B.action && B.action.openPopup) {
          B.action.openPopup();
        }

      }
    });
  }
});
