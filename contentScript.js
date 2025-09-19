// contentScript.js (Slutgiltig version med URL-omvandling och script-sökning)

(function(){
  const B = typeof browser !== 'undefined' ? browser : chrome;

  // domain activation cache (updated by popup via message)
  let ACTIVE_FOR_DOMAIN = null; // null => unknown; boolean when known

  // --- NYCKELN: REGLER FÖR URL-OMVANDLING ---
  // Varje regel försöker omvandla en lågupplöst URL till en högupplöst.
  const TRANSFORMATION_RULES = [
    // För Inet.se: /product/112x63/ -> /product/1600x900/
    { search: /\/product\/\d+x\d+\//g, replace: '/product/1600x900/' },
    // För många andra sidor: /..._100x100.jpg -> /...jpg
    { search: /_\d+x\d+\.(jpe?g|png|webp|avif)/g, replace: '.$1' },
    // ...-small.jpg -> ...-large.jpg
    { search: /-(small|thumb|thumbnail|150w|300w)\.(jpe?g|png|webp|avif)/g, replace: '-large.$2' },
    // .../thumb/... -> .../original/...
    { search: /\/thumb\//g, replace: '/original/' },
    // Query-parametrar: ?w=150&h=150 -> (tas bort)
    { search: /[?&](w|width|h|height)=\d+/g, replace: '' },
  ];
  const FINAL_QUERY_PARAMS = '?w=2000&h=2000&quality=100';
  // --- SLUT PÅ REGLER ---

  const DEFAULT_GALLERY_SELECTORS = [
    '.product-gallery', '.gallery', '[role="main"]', 'main', '.pdp-image-gallery',
    'media-gallery', '[aria-label="Galleri"]', '.c-imageslider', '#lightbox', '#ivImagesTab'
  ];

  function baseDomain(host){
    if (!host) return '';
    const parts = host.split('.');
    return parts.length <= 2 ? host : parts.slice(-2).join('.');
  }

  function getElementPath(el) {
    if (!el || !el.tagName) return '';
    const path = [];
    let currentEl = el;
    while (currentEl && currentEl.tagName !== 'BODY') {
      let selector = currentEl.tagName.toLowerCase();
      if (currentEl.id) {
        selector += `#${currentEl.id}`;
      }
      if (currentEl.className && typeof currentEl.className === 'string') {
        const classes = currentEl.className.trim().split(/\s+/).join('.');
        if (classes) {
          selector += `.${classes}`;
        }
      }
      path.unshift(selector); // Lägg till i början av arrayen
      currentEl = currentEl.parentElement;
    }
    path.unshift('body');
    return path.join(' > ');
  }
  
  async function ensureActiveFlag(){
    if (ACTIVE_FOR_DOMAIN !== null) return ACTIVE_FOR_DOMAIN;
    const host = location.hostname;
    const bdom = baseDomain(host);
    const st = await new Promise((res)=>{
      try { B.storage.local.get({ allowedDomains: {} }, (o)=>res(o||{allowedDomains:{}})); }
      catch { B.storage.local.get({ allowedDomains: {} }).then(res); }
    });
    ACTIVE_FOR_DOMAIN = !!(st.allowedDomains && st.allowedDomains[bdom]);
    return ACTIVE_FOR_DOMAIN;
  }

  function ordWalk(root){
    const out = [];
    let ord = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
    while (walker.nextNode()){
      const el = walker.currentNode;
      el.__img_ord = ord++;
      out.push(el);
    }
    return out;
  }

  function parseSrcset(ss){
    if (!ss) return [];
    return ss.split(',').map(s=>s.trim().split(' ')[0]).filter(Boolean);
  }

  function collectCssBg(el){
    const urls = [];
    try {
      const cs = getComputedStyle(el);
      const bg = cs && cs.backgroundImage || '';
      const re = /url\(("([^"]+)"|'([^']+)'|([^\)]+))\)/g;
      let m;
      while ((m = re.exec(bg))){
        const u = (m[2]||m[3]||m[4]||'').trim();
        if (u && !u.startsWith('data:')) urls.push(new URL(u, location.href).toString());
      }
    } catch {}
    return urls;
  }

 function attrCandidates(el){
    const c = new Set();
    const push = (v)=>{ 
        if (v && typeof v === 'string' && !v.startsWith('data:')) { 
            try { 
                // Hanterar protokoll-lösa URL:er (som börjar med //) genom att lägga till https:
                let url = v.startsWith('//') ? `https:${v}` : v;
                c.add(new URL(url, location.href).toString()); 
            } catch {} 
        } 
    };

    // Genomsöker en uttömmande lista av möjliga data-attribut, inklusive Dells 'data-full-img'
    const dataAttrs = ['data-full-img', 'data-src', 'data-original', 'data-lazy', 'data-zoom', 'data-large', 'data-full', 'data-fancybox', 'data-image', 'data-img', 'data-photo'];
    dataAttrs.forEach(attr => {
        if (el.hasAttribute(attr)) {
            push(el.getAttribute(attr));
        }
    });

    if (el.tagName === 'IMG'){
      push(el.currentSrc || el.src);
      parseSrcset(el.srcset).forEach(push);
    }
    if (el.tagName === 'SOURCE'){
      parseSrcset(el.srcset).forEach(push);
      push(el.src);
    }
    if (el.tagName === 'A'){
      const href = el.getAttribute('href');
      if (href && /\.(?:jpe?g|png|webp|avif)(?:$|[?#])/.test(href)) push(href);
    }
    collectCssBg(el).forEach(push);
    if (el.tagName === 'PICTURE'){
      const img = el.querySelector('img');
      if (img) {
        push(img.currentSrc || img.src);
        parseSrcset(img.srcset).forEach(push);
      }
    }
    return Array.from(c);
  }

  function metaAndLinkedImages(){
    const out = new Set();
    const push = (v)=>{ if (v) { try{ out.add(new URL(v, location.href).toString()); }catch{} } };
    document.querySelectorAll('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"], meta[property="twitter:image"], meta[itemprop="image"]').forEach(m=>push(m.getAttribute('content')));
    document.querySelectorAll('link[rel~="preload"][as="image"], link[rel~="image_src"]').forEach(l=>push(l.getAttribute('href')));
    document.querySelectorAll('noscript').forEach(ns=>{
      const html = ns.textContent || '';
      const m = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
      if (m) push(m[1]);
    });
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s=>{
      try {
        const j = JSON.parse(s.textContent);
        const arr = Array.isArray(j) ? j : [j];
        arr.forEach(o=>{
          const img = o && (o.image || (o.offers && o.offers.image));
          if (typeof img === 'string') push(img);
          else if (Array.isArray(img)) img.forEach(push);
        });
      } catch {}
    });
    return Array.from(out);
  }

  function findImagesInScripts() {
      const urls = new Set();
      const push = (v) => { if (v) { try { urls.add(new URL(v, location.href).toString()); } catch {} } };
      const urlRegex = /https?:\/\/[^"']+\.(?:jpe?g|png|webp|avif)/g;
      document.querySelectorAll('script').forEach(script => {
          const content = script.textContent;
          if (content.length > 100) {
              const matches = content.match(urlRegex);
              if (matches) {
                  matches.forEach(push);
              }
          }
      });
      return Array.from(urls);
  }

  function measureNatural(url){
    return new Promise((resolve)=>{
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.onload = () => resolve({ w: img.naturalWidth||0, h: img.naturalHeight||0 });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = url;
    });
  }

  function isAllowed(u){
    if (!u) return false;
    const lower = String(u).toLowerCase();
    if (lower.startsWith('data:')) return false;
    if (!/\.(?:jpe?g|png|webp|avif)(?:$|[?#])/.test(lower)) return false;
    if (/(?:sprite|icon|logo|svg)/.test(lower)) return false;
    if (/(klarna|trygg|facebook|google|doubleclick|analytics)/.test(lower)) return false;
    return true;
  }

  function getProductNameFallback(){
    let name = '';
    try {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const s of scripts){
        try {
          const j = JSON.parse(s.textContent);
          const arr = Array.isArray(j) ? j : [j];
          for (const o of arr){
            if (o && (o['@type']==='Product' || (Array.isArray(o['@type']) && o['@type'].includes('Product'))) && o.name){
              name = o.name; break;
            }
          }
          if (name) break;
        } catch {}
      }
    } catch {}
    if (!name){
      const h1 = document.querySelector('h1');
      if (h1 && h1.textContent) name = h1.textContent.trim();
    }
    if (!name) name = (document.title||'').trim();
    return name;
  }

  // NY FUNKTION: Hittar den närmaste gemensamma "föräldern" till två element.
  function getNearestCommonAncestor(el1, el2) {
    if (!el1 || !el2) return document.body;
    const parents1 = new Set();
    let current = el1;
    while (current) {
      parents1.add(current);
      current = current.parentElement;
    }
    current = el2;
    while (current) {
      if (parents1.has(current)) {
        return current;
      }
      current = current.parentElement;
    }
    return document.body;
  }

  function assignPriority(el, gallerySelectorString) {
    // Priority 1: Check against the dynamic list of gallery selectors
    if (el.closest(gallerySelectorString)) {
      return 1;
    }
    // Priority 2: Sidebars and recommendations (this list remains hardcoded for now)
    if (el.closest('aside, .sidebar, [class*="related"], [class*="recommend"], .accessories')) {
      return 2;
    }
    // Priority 3: Allt annat (header, footer, etc.)
    return 3;
  }
  
  function generateTransformedUrls(sourceUrls) {
      const transformed = new Set();
      for (const url of sourceUrls) {
          let currentUrl = url;
          let transformedByRule = false;
          for (const rule of TRANSFORMATION_RULES) {
              if (rule.search.test(currentUrl)) {
                  currentUrl = currentUrl.replace(rule.search, rule.replace);
                  transformedByRule = true;
              }
          }
          // Hantera query-parametrar separat för att bygga en ren URL
          if (transformedByRule && currentUrl.includes('?')) {
              const [baseUrl] = currentUrl.split('?');
              // Lägg till nya query-parametrar bara om vi rensade gamla
              if (TRANSFORMATION_RULES.some(r => r.search.test(url) && r.replace === '')) {
                 transformed.add(baseUrl + FINAL_QUERY_PARAMS);
              }
          }
          transformed.add(currentUrl);
      }
      return Array.from(transformed);
  }

  async function collectImages(){
    const active = await ensureActiveFlag();
    if (!active) return { urls: [], productName: '' };

    const storageData = await B.storage.local.get({ gallerySelectors: DEFAULT_GALLERY_SELECTORS });
    const gallerySelectorString = storageData.gallerySelectors.join(', ');

    console.log("Använder följande väljare för prio 1:", gallerySelectorString);
    
    ordWalk(document.documentElement);
    
    const set = new Map();
    const push = (u, el, w=0, h=0) => { // 'el' är nu en parameter
      if (!isAllowed(u)) return;

      const prio = el ? assignPriority(el, gallerySelectorString) : 3;
      const ord = el ? el.__img_ord : Number.POSITIVE_INFINITY;

      const prev = set.get(u);
      if (!prev) {
        set.set(u, { url: u, w, h, ord, prio }); // Spara prio
      } else {
        if ((!prev.w && w) || (!prev.h && h)) { prev.w = Math.max(prev.w||0, w); prev.h = Math.max(prev.h||0, h); }
        if (ord < (prev.ord || Number.POSITIVE_INFINITY)) prev.ord = ord;
        if (prio < (prev.prio || 3)) prev.prio = prio; // Uppdatera till bästa (lägsta) prio
      }
    };

    // Steg 1: Samla alla URL:er vi kan hitta med befintliga metoder
    const initialCandidates = new Set();
    document.querySelectorAll('img, source, a, picture, figure, [style*="background"], [class*="bg"], [data-src], [data-original], [data-lazy]').forEach(el=>{
      attrCandidates(el).forEach(u => initialCandidates.add(JSON.stringify({ u, el })));
    });
    metaAndLinkedImages().forEach(u => initialCandidates.add(JSON.stringify({ u, ord: 0 })));
    findImagesInScripts().forEach(u => initialCandidates.add(JSON.stringify({ u, ord: 0 })));

    // Steg 2: Applicera URL-omvandling för att gissa högupplösta versioner
    const initialUrls = Array.from(initialCandidates).map(s => JSON.parse(s).u);
    const transformedUrls = generateTransformedUrls(initialUrls);
    transformedUrls.forEach(u => initialCandidates.add(JSON.stringify({ u, ord: 0 })));
    
    // Steg 3: Mät och bearbeta den kompletta listan
    const allCandidates = Array.from(initialCandidates);
    const limited = allCandidates.slice(0, 500).map(s=>JSON.parse(s));
    const measurePromises = limited.map(async ({u, el})=>{
      let w=0,h=0;
      try { const m = await measureNatural(u); w=m.w; h=m.h; } catch {}
      push(u, el, w, h);
    });

    allCandidates.slice(500).forEach(s=>{
      const {u, el} = JSON.parse(s);
      push(u, el, 0, 0);
    });

    await Promise.allSettled(measurePromises);

    const productName = getProductNameFallback();

    // --- DEBUGGER: Log the collected image data to the console ---
    const finalImages = Array.from(set.values());
    console.log(`--- [Produktbild-samlare] Debug Info: Found ${finalImages.length} images ---`);
    console.table(finalImages, ["prio", "ord", "w", "h", "url"]);
    // --- END DEBUGGER ---

    return { urls: Array.from(set.values()), productName };
  }

  (typeof B.runtime.onMessage !== 'undefined') && B.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'collectImages'){
      (async()=>{
        try { const res = await collectImages(); sendResponse(res); }
        catch (e) { console.error(e); sendResponse({ urls: [], productName: '' }); }
      })();
      return true; // async
    }
    if (msg.type === 'setActiveForDomain'){
      ACTIVE_FOR_DOMAIN = !!msg.active;
      sendResponse && sendResponse({ ok: true });
      return; // sync ok
    }
  });
})();