// contentScript.js (Slutgiltig version med URL-omvandling och script-sökning)

(function(){
  const B = typeof browser !== 'undefined' ? browser : chrome;

  // domain activation cache (updated by popup via message)
  let ACTIVE_FOR_DOMAIN = null; // null => unknown; boolean when known

  // --- NYCKELN: REGLER FÖR URL-OMVANDLING ---
  // Varje regel försöker omvandla en lågupplöst URL till en högupplöst.
  const TRANSFORMATION_RULES = [
    // ---- NY SAMSUNG-REGEL ----
    // Ersätter Samsungs storleksparameter (t.ex. ?$684_547_PNG$) med den för högsta kvalitet.
    { search: /\?\$[^$]+\$$/, replace: '?$Q90_2052_1641_JPG$' },
    // ---- SLUT PÅ SAMSUNG-REGEL ----

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
    '#pd-header-gallery', // Specifik väljare för Samsungs produktgalleri
    '.product-gallery', '.gallery', '[role="main"]', 'main', '.pdp-image-gallery',
    'media-gallery', '[aria-label="Galleri"]', '[aria-label="Produktgalleri"]', '.c-imageslider', '#lightbox', '#ivImagesTab'
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
  
  /**
   * Lägger till en bild i samlingen. Sätter endast prio om den är BÄTTRE 
   * än den som redan är satt (lägre nummer är bättre).
   * @param {string} url 
   * @param {HTMLElement|null} el 
   * @param {number} w 
   * @param {number} h 
   * @param {number} [newPrio] - Den nya prioriteten att försöka sätta.
   */
  function push(url, el, w, h, newPrio = 3) {
      const key = stripQueryHash(url);
      const existing = set.get(key);
      
      // Lägg till element-referens
      if (el && !elementMap.has(url)) {
          elementMap.set(url, el);
      }

      // Om URL:en redan finns
      if (existing) {
          // **PRIORITETSSKYDD:** Behåll den lägsta (bästa) prioriteten
          if (newPrio < existing.prio) {
              existing.prio = newPrio;
          }
          // Behåll de bästa w/h om de nya är 0/0
          if (w > existing.w) existing.w = w;
          if (h > existing.h) existing.h = h;
          
          set.set(key, existing);
          return;
      }

      // Lägg till ny bild
      set.set(key, {
          url: url,
          prio: newPrio,
          w: w,
          h: h,
          el: el,
          ord: set.size
      });
  }

  /**
   * Validerar om URL:en finns, är stor (minst 1200x400) och ger Prio 0.
   * Kräver att funktionen 'measureNatural(url)' finns tillgänglig.
   */
  async function validateHighResUrl(url) {
      if (!url || url.length < 10) return false;
      
      // 1. HEAD-check (För att se om filen finns)
      try {
          const headResponse = await fetch(url, { method: 'HEAD', mode: 'cors' });
          if (!headResponse.ok) return false;
      } catch (e) {
          return false;
      }

      // 2. DIMENSION-check (För att se om filen är stor nog)
      try {
          const { w, h } = await measureNatural(url);
          
          const area = w * h;
          const MIN_AREA = 1200 * 400; // 480,000 pixlar
          
          if (area >= MIN_AREA) {
              // Lägg till i den globala insamlingen omedelbart med Prio 0 (högsta)
              push(url, null, w, h, 0); 
              return true;
          }

      } catch (e) {
          return false;
      }

      return false;
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

    // ---- NYTT FÖR SAMSUNG ----
    // Genomsöker en uttömmande lista av möjliga data-attribut, inklusive Samsungs 'data-desktop-src'
    const dataAttrs = ['data-desktop-src', 'data-full-img', 'data-src', 'data-original', 'data-lazy', 'data-zoom', 'data-large', 'data-full', 'data-fancybox', 'data-image', 'data-img', 'data-photo'];
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

  function isAllowed(u, allowNoExtension = false){
    if (!u) return false;
    const lower = String(u).toLowerCase();
    if (lower.startsWith('data:')) return false;

    // ---- ÄNDRING: Ny, flexibel logik för filändelser ----
    const hasStandardExt = /\.(?:jpe?g|png|webp|avif)(?:$|[?#])/.test(lower);
    if (!hasStandardExt && !allowNoExtension) {
        // Om den saknar standardändelse OCH vi inte tillåter det, avvisa.
        return false;
    }
    
    if (/(?:sprite|icon|logo|svg)/.test(lower)) return false;

    const smallImageMatch = lower.match(/_(\d{1,3})x(\d{1,3})\./);
    if (smallImageMatch) {
        const width = parseInt(smallImageMatch[1], 10);
        const height = parseInt(smallImageMatch[2], 10);
        if (width <= 300 && height <= 300) {
            // Om filnamnet indikerar att bilden är 300x300 eller mindre, ignorera den.
            return false; 
        }
    }

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

  /**
   * Lägger till en bild i samlingen. Sätter endast prio om den är BÄTTRE 
   * än den som redan är satt (lägre nummer är bättre).
   * @param {string} url 
   * @param {HTMLElement|null} el 
   * @param {number} w 
   * @param {number} h 
   * @param {number} [newPrio] - Den nya prioriteten att försöka sätta.
   */
  function push(url, el, w, h, newPrio = 3) {
      const key = stripQueryHash(url);
      const existing = set.get(key);
      
      // Lägg till element-referens
      if (el && !elementMap.has(url)) {
          elementMap.set(url, el);
      }

      // Om URL:en redan finns
      if (existing) {
          // **PRIORITETSSKYDD:** Behåll den lägsta (bästa) prioriteten
          if (newPrio < existing.prio) {
              existing.prio = newPrio;
          }
          // Behåll de bästa w/h om de nya är 0/0
          if (w > existing.w) existing.w = w;
          if (h > existing.h) existing.h = h;
          
          set.set(key, existing);
          return;
      }

      // Lägg till ny bild
      set.set(key, {
          url: url,
          prio: newPrio,
          w: w,
          h: h,
          el: el,
          ord: set.size
      });
  }

  function assignPriority(el, gallerySelectorString) {
      // Prio 1: Galleri/Lightbox (Högst prio efter Prio 0)
      if (el && el.closest(gallerySelectorString)) {
        return 1;
      }
      // Prio 2: Produktbeskrivning/CMS-innehåll
      if (el && el.closest('[data-test-id="cms-content"], [class*="description"], [class*="cms-content"]')) {
          return 2; 
      }
      // Prio 3: Sidobarer, rekommendationer, etc. (Lägsta prioritet)
      if (el && el.closest('aside, .sidebar, [class*="related"], [class*="recommend"], .accessories')) {
        return 3; 
      }
      // Fallback till Prio 3.
      return 3; 
  }

  // Huvudfunktion för att skrapa och mäta
  async function scrapeAndMeasure() { 
    
    // Rensa samlingarna
    set.clear();
    elementMap.clear();

    // 1. DOMÄNKONTROLL & FÖRBEREDELSER
    const hostname = window.location.hostname;
    const isInet = hostname.endsWith('inet.se');
    const gallerySelectorString = (await getCustomSelectors()).join(',');

    // Hämta dolda URL:er
    const hiddenUrls = metaAndLinkedImages(); 
    
    // initialUrls innehåller alla funna URL:er (dolda och från DOM)
    const initialUrls = new Set(hiddenUrls); 

    // Gå igenom DOM, samla in URL:er och fyll elementMap 
    const allElements = ordWalk(document.body); 
    allElements.forEach(el => {
        attrCandidates(el).forEach(u => {
            if (isAllowed(u)) { 
                initialUrls.add(u);
                if (!elementMap.has(u)) {
                    elementMap.set(u, el);
                }
            }
        });
    });

    // Hämta URL:er från script-taggar
    findImagesInScripts().forEach(u => {
      if (isAllowed(u)) initialUrls.add(u);
    });
    
    
    // --- 2. INET-SPECIFIK GISSNINGSLOGIK ---
    if (isInet) {
        const inetRule = TRANSFORMATION_RULES.find(r => r.search.toString() === '/\\/product\\/\\d+x\\d+\\//g'.toString());
        if (inetRule) {
            initialUrls.forEach(u => {
                let transformed = u.replace(inetRule.search, inetRule.replace);
                if (transformed !== u && transformed.includes('/product/1600x900/')) {
                    // Lägg till den gissade Prio 1-URL:en.
                    initialUrls.add(transformed);
                }
            });
        }
    }
    // --- SLUT PÅ GISSNINGSLOGIK ---

    // --- 3. MÄTNING & PRIORITERING (FIXEN ÄR HÄR) ---
    
    const allUrls = Array.from(initialUrls);

    // Mät och prioritera de 500 bästa URL:erna.
    const measurePromises = allUrls.slice(0, 500).map(async (u)=>{
      const el = elementMap.get(u) || null;
      let w=0, h=0;
      let calculatedPrio = 3; // Standard Prio innan analys

      // Mät dimensioner FÖRST (w och h används för "Visa endast stora bilder")
      try { 
          const m = await measureNatural(u); w=m.w; h=m.h; 
      } catch {}

      // Applicera Inet-regler baserat på URL-sökvägen ENBART (utan w/h-krav):
      if (isInet) {
          // **PRIO 1 (HÖGST): URL innehåller 1600x900**
          if (u.includes('/1600x900/')) {
              calculatedPrio = 1; 
          } 
          // **PRIO 2: URL innehåller 800x10000**
          else if (u.includes('/800x10000/')) {
              calculatedPrio = 2; 
          } 
      }
      
      // Om ingen av Inet-reglerna matchade (calculatedPrio är fortfarande 3) eller om det inte är Inet:
      // Använd DOM-baserad prioritering (returnerar 1, 2 eller 3).
      if (calculatedPrio === 3) {
          calculatedPrio = assignPriority(el, gallerySelectorString); 
      }
      
      // Anropa push. Push-funktionen skyddar det lägsta prioritetstalet.
      push(u, el, w, h, calculatedPrio); 
    });

    // Hantera de resterande URL:erna utan mätning
    allUrls.slice(500).forEach(u=>{
      const el = elementMap.get(u) || null;
      const calculatedPrio = assignPriority(el, gallerySelectorString);
      push(u, el, 0, 0, calculatedPrio); 
    });

    // Vänta på att mätningarna är klara
    await Promise.allSettled(measurePromises);

    // --- 4. SLUTRESULTAT ---
    const productName = getProductNameFallback(); 
    const finalImages = Array.from(set.values());

    console.log(`--- [Produktbild-samlare] Debug Info: Hittade ${finalImages.length} bilder ---`);
    console.table(finalImages.sort((a,b) => a.prio - b.prio || a.ord - b.ord), ["prio", "ord", "w", "h", "url"]);

    return { urls: finalImages, productName };
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

    // ---- ÄNDRING (SAKNAS I DIN KOD) ----
    // Hämta den nya inställningen "allowNoExtension" från storage
    const storageData = await B.storage.local.get({ 
        gallerySelectors: DEFAULT_GALLERY_SELECTORS,
        allowNoExtension: false 
    });
    const { gallerySelectorString, allowNoExtension } = {
        gallerySelectorString: storageData.gallerySelectors.join(', '),
        allowNoExtension: storageData.allowNoExtension
    };
    
    console.log("Använder följande väljare för prio 1:", gallerySelectorString);

    ordWalk(document.documentElement);
    
    const set = new Map();
    const push = (u, el, w=0, h=0) => {
      // ---- ÄNDRING (SAKNAS I DIN KOD) ----
      // Skicka med den nya flaggan till isAllowed()
      if (!isAllowed(u, allowNoExtension)) return;

      const prio = el ? assignPriority(el, gallerySelectorString) : 3;
      const ord = el ? el.__img_ord : Number.POSITIVE_INFINITY;

      const prev = set.get(u);
      if (!prev) {
        set.set(u, { url: u, w, h, ord, prio });
      } else {
        if ((!prev.w && w) || (!prev.h && h)) { prev.w = Math.max(prev.w||0, w); prev.h = Math.max(prev.h||0, h); }
        if (ord < (prev.ord || Number.POSITIVE_INFINITY)) prev.ord = ord;
        if (prio < (prev.prio || 3)) prev.prio = prio;
      }
    };

    // Använd en Map för att koppla en URL till dess ursprungliga element
    const elementMap = new Map();
    document.querySelectorAll('img, source, a, picture, figure, [style*="background"], [data-src], [data-original], [data-lazy], [data-desktop-src]').forEach(el => {
        attrCandidates(el).forEach(u => {
            if (!elementMap.has(u)) {
                elementMap.set(u, el);
            }
        });
    });

    const initialUrls = new Set(elementMap.keys());
    metaAndLinkedImages().forEach(u => initialUrls.add(u));
    findImagesInScripts().forEach(u => initialUrls.add(u));
    
    const transformedUrls = generateTransformedUrls(Array.from(initialUrls));
    transformedUrls.forEach(u => initialUrls.add(u));

    const allUrls = Array.from(initialUrls);

    const measurePromises = allUrls.slice(0, 500).map(async (u)=>{
      const el = elementMap.get(u) || null;
      let w=0, h=0;
      try { const m = await measureNatural(u); w=m.w; h=m.h; } catch {}
      push(u, el, w, h);
    });

    allUrls.slice(500).forEach(u=>{
      const el = elementMap.get(u) || null;
      push(u, el, 0, 0);
    });

    await Promise.allSettled(measurePromises);

    const productName = getProductNameFallback();
    const finalImages = Array.from(set.values());

    console.log(`--- [Produktbild-samlare] Debug Info: Hittade ${finalImages.length} bilder ---`);
    console.table(finalImages.sort((a,b) => a.prio - b.prio || a.ord - b.ord), ["prio", "ord", "w", "h", "url"]);

    return { urls: finalImages, productName };
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