// popup.js

(function () {
  const B = typeof browser !== 'undefined' ? browser : chrome;

  const DEFAULT_GALLERY_SELECTORS = [
    '#pd-header-gallery',
    '.product-gallery', '.gallery', '[role="main"]', 'main', '.pdp-image-gallery',
    'media-gallery', '[aria-label="Galleri"]', '[aria-label="Produktgalleri"]', '.c-imageslider', '#lightbox', '#ivImagesTab'
  ];

  function stripQueryHash(u){
    try { const url = new URL(u); url.hash=''; url.search=''; return url.toString(); }
    catch { return (u||'').split('#')[0].split('?')[0]; }
  }
  
  function extOf(u){
    const clean = stripQueryHash(u);
    const m = /\.([a-zA-Z0-9]{2,5})$/.exec(clean);
    return m ? m[1].toLowerCase() : '';
  }
  
  // FÖRBÄTTRAD: Bättre dubblettfiltrering som respekterar query-parametrar
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
          let basePath;
          try {
              const url = new URL(u);
              url.hash = ''; // Ta bara bort hash
              basePath = url.toString();
          } catch {
              basePath = u.split('#')[0];
          }

          const e = extOf(u);
          const r = rank[e] || 0;

          const prev = byBase.get(basePath);
          
          if (!prev || r > prev.rank) {
              byBase.set(basePath, { url: u, rank: r });
          }
      }
      
      return Array.from(byBase.values()).map(x => x.url);
  }

  const grid = document.getElementById('grid');
  const productEl = document.getElementById('product');
  const saveBtn = document.getElementById('saveBtn');
  const countEl = document.getElementById('count');
  const askWhereCb = document.getElementById('askWhere');
  const removeBgCb = document.getElementById('removeBgHeuristic');
  const onlyLargeCb = document.getElementById('onlyLarge');
  const hideDuplicatesCb = document.getElementById('hideDuplicates');
  const allowNoExtensionCb = document.getElementById('allowNoExtension');
  const selectAllBtn = document.getElementById('selectAllBtn');
  const deselectAllBtn = document.getElementById('deselectAllBtn');
  const enableDomainCb = document.getElementById('enableDomain');
  const domainLabel = document.getElementById('domainLabel');
  const selectorsText = document.getElementById('selectorsText');
  const saveSelectorsBtn = document.getElementById('saveSelectorsBtn');
  const resetSelectorsBtn = document.getElementById('resetSelectorsBtn');
  const saveStatus = document.getElementById('saveStatus');

  let ALL_ITEMS = [];
  let SELECTION_ORDER = [];

  function updateSelectionNumbers() {
    grid.querySelectorAll('.item').forEach(item => {
      const url = item.dataset.url;
      const numberEl = item.querySelector('.selection-number');
      if (!numberEl) return;
      const index = SELECTION_ORDER.indexOf(url);
      if (index !== -1) {
        numberEl.textContent = index + 1;
      } else {
        numberEl.textContent = '';
      }
    });
  }

  function storageGet(keys, defaults) {
    return new Promise((resolve) => {
      try {
        B.storage.local.get(keys, (res) => {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
            resolve(defaults || {});
          } else {
            resolve(Object.assign({}, defaults || {}, res || {}));
          }
        });
      } catch {
        B.storage.local.get(keys).then(
          (res)=>resolve(Object.assign({}, defaults || {}, res || {})),
          ()=>resolve(defaults||{})
        );
      }
    });
  }

  async function loadSettings() {
    const defaults = { askWhere: false, removeBgHeuristic: true, onlyLarge: true, hideDuplicates: true, allowNoExtension: false };
    const settings = await storageGet(defaults);
    
    askWhereCb.checked = !!settings.askWhere;
    removeBgCb.checked = settings.removeBgHeuristic !== false;
    onlyLargeCb.checked = settings.onlyLarge !== false;
    hideDuplicatesCb.checked = settings.hideDuplicates !== false;
    allowNoExtensionCb.checked = !!settings.allowNoExtension;
  }

  // Spara alla inställningar
  askWhereCb.addEventListener('change', () => B.storage.local.set({ askWhere: askWhereCb.checked }));
  removeBgCb.addEventListener('change', () => B.storage.local.set({ removeBgHeuristic: removeBgCb.checked }));
  allowNoExtensionCb.addEventListener('change', () => B.storage.local.set({ allowNoExtension: allowNoExtensionCb.checked }));

  // Inställningar som kräver att griden ritas om
  onlyLargeCb.addEventListener('change', () => { B.storage.local.set({ onlyLarge: onlyLargeCb.checked }); renderGrid(); });
  hideDuplicatesCb.addEventListener('change', () => { B.storage.local.set({ hideDuplicates: hideDuplicatesCb.checked }); renderGrid(); });

  async function loadCustomSelectors() {
    const data = await storageGet({ gallerySelectors: DEFAULT_GALLERY_SELECTORS });
    selectorsText.value = data.gallerySelectors.join('\n');
  }

  saveSelectorsBtn.addEventListener('click', async () => {
    const selectors = selectorsText.value.split('\n').map(s => s.trim()).filter(Boolean);
    await B.storage.local.set({ gallerySelectors: selectors });
    saveStatus.textContent = 'Sparat!';
    setTimeout(() => { saveStatus.textContent = ''; }, 2000);
  });

  resetSelectorsBtn.addEventListener('click', () => {
    selectorsText.value = DEFAULT_GALLERY_SELECTORS.join('\n');
    saveSelectorsBtn.click();
  });

  function isBig(item) {
    const w = +item.w || 0, h = +item.h || 0;
    if (!w || !h) return false;
    if (w >= 650 && h >= 650) return true;
    if ((w >= 1000 && h >= 350) || (h >= 1000 && w >= 350)) return true;
    if (w * h >= 280000) return true;
    return false;
  }

  // FÖRBÄTTRAD: Sortering som tar hänsyn till filtyp och storlek
  function sortItems(items) {
    // Prioritetsordning för filtyper (högre = bättre)
    const extRank = { 
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
    
    return items.slice().sort((a, b) => {
      // 1. Sortera först efter prioritet (lägre prio = bättre, visas först)
      const prioA = a.prio || 3;
      const prioB = b.prio || 3;
      if (prioA !== prioB) return prioA - prioB;
      
      // 2. Sortera sedan efter ordning (om tillgänglig)
      const ao = (typeof a.ord === 'number') ? a.ord : Number.POSITIVE_INFINITY;
      const bo = (typeof b.ord === 'number') ? b.ord : Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      
      // 3. Sortera efter filtyp (högre rank = bättre)
      const extA = extOf(a.url);
      const extB = extOf(b.url);
      const rankA = extRank[extA] || 0;
      const rankB = extRank[extB] || 0;
      if (rankA !== rankB) return rankB - rankA; // Högre rank först
      
      // 4. Sortera efter area (större = bättre)
      const aArea = (+a.w||0) * (+a.h||0);
      const bArea = (+b.w||0) * (+b.h||0);
      if (bArea !== aArea) return bArea - aArea;
      
      // 5. Alfabetisk sortering som sista utväg
      return String(a.url).localeCompare(String(b.url));
    });
  }

  function renderGrid() {
    SELECTION_ORDER = [];
    
    const active = !grid.classList.contains('disabled');
    grid.innerHTML = '';
    if (!active) { return; }
    
    let listToRender = ALL_ITEMS.slice();
    
    // Filtrera efter storlek
    if (onlyLargeCb.checked) {
      listToRender = listToRender.filter(isBig);
    }
    
    // Filtrera bort dubbletter
    if (hideDuplicatesCb.checked) {
        const urlsInCurrentList = listToRender.map(item => item.url);
        const preferredUrls = new Set(choosePreferredByPath(urlsInCurrentList));
        listToRender = listToRender.filter(item => preferredUrls.has(item.url));
    }
    
    // Sortera listan
    const finalList = sortItems(listToRender);

    if (!finalList.length) {
      grid.innerHTML = '<div class="empty">Inga bilder hittades (med nuvarande filter). Du kan behöva ladda om popupen efter att ha ändrat filter.</div>';
      countEl.textContent = '';
      saveBtn.disabled = true;
      return;
    }

    finalList.forEach((it, i) => {
      const div = document.createElement('div');
      div.className = 'item';
      div.dataset.url = it.url;
      
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = false;
      cb.dataset.url = it.url;
      
      const img = document.createElement('img');
      img.src = it.url;
      img.alt = `Bild ${i+1}`;
      
      // Förbättrad tooltip med filtyp
      const ext = extOf(it.url).toUpperCase();
      img.title = (it.w && it.h) ? `${it.w}×${it.h} (${ext})` : ext;
      img.referrerPolicy = 'no-referrer';
      img.decoding = 'async';
      img.loading = 'lazy';
      
      const num = document.createElement('span');
      num.className = 'selection-number';

      div.appendChild(cb);
      div.appendChild(img);
      div.appendChild(num);
      grid.appendChild(div);
    });

    saveBtn.disabled = true;
    updateCount();
  }

  function render(items, productName, active) {
    ALL_ITEMS = Array.isArray(items) ? items : [];
    grid.classList.toggle('disabled', !active);
    productEl.textContent = productName || '';
    renderGrid();
  }

  function updateCount() {
    const selected = SELECTION_ORDER.length;
    const total = grid.querySelectorAll('.item').length;
    countEl.textContent = total ? `${selected} / ${total} valda` : '';
    saveBtn.disabled = selected === 0;
  }

  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.item');
    if (!card) return;
    const cb = card.querySelector('input[type="checkbox"]');
    if (!cb) return;

    if (e.target !== cb) {
      cb.checked = !cb.checked;
    }
    
    card.classList.toggle('selected', cb.checked);
    const url = cb.dataset.url;

    if (cb.checked) {
      if (!SELECTION_ORDER.includes(url)) {
        SELECTION_ORDER.push(url);
      }
    } else {
      SELECTION_ORDER = SELECTION_ORDER.filter(u => u !== url);
    }
    
    updateCount();
    updateSelectionNumbers();
  });

  selectAllBtn.addEventListener('click', () => {
    SELECTION_ORDER = [];
    grid.querySelectorAll('.item').forEach(card => {
      const cb = card.querySelector('input[type="checkbox"]');
      if (cb) {
        cb.checked = true; 
        card.classList.add('selected');
        const url = cb.dataset.url;
        if (!SELECTION_ORDER.includes(url)) {
            SELECTION_ORDER.push(url);
        }
      }
    });
    updateCount();
    updateSelectionNumbers();
  });

  deselectAllBtn.addEventListener('click', () => {
    grid.querySelectorAll('.item').forEach(card => {
      const cb = card.querySelector('input[type="checkbox"]');
      if (cb) { 
        cb.checked = false; 
        card.classList.remove('selected'); 
      }
    });
    SELECTION_ORDER = [];
    updateCount();
    updateSelectionNumbers();
  });

  saveBtn.addEventListener('click', async () => {
    try {
      // KRITISK FIX: Skicka SELECTION_ORDER direkt (användarens valda ordning)
      const selected = SELECTION_ORDER;
      if (!selected.length) return;
      const productName = productEl.textContent || 'produkt';
      
      // Logga för debug
      console.log('Skickar bilder i ordning:', selected);
      
      await B.runtime.sendMessage({ type: 'downloadImages', urls: selected, productName });
      window.close();
    } catch (e) { console.error(e); }
  });

  function getActiveTab() {
    return new Promise((resolve) => {
      B.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs && tabs[0]));
    });
  }
  
  function getAllFrames(tabId) {
    if (B.webNavigation && B.webNavigation.getAllFrames) {
      try {
        return new Promise((resolve, reject) => {
          B.webNavigation.getAllFrames({ tabId }, (frames) => {
            const le = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError : null;
            if (le) return reject(le);
            resolve(frames || []);
          });
        });
      } catch {
        return B.webNavigation.getAllFrames({ tabId }).catch(()=>[]);
      }
    }
    return Promise.resolve([{ frameId: 0 }]);
  }
  
  function askFrame(tabId, frameId) {
    return new Promise((resolve) => {
      try {
        B.tabs.sendMessage(tabId, { type: 'collectImages' }, { frameId }, (resp) => {
          const le = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError : null;
          if (le) return resolve(null);
          resolve(resp || null);
        });
      } catch { resolve(null); }
    });
  }

  async function collectFromAllFrames(tabId) {
    const frames = await getAllFrames(tabId).catch(() => [{ frameId: 0 }]);
    const byUrl = new Map();
    let name = null;
    for (const f of frames) {
      const resp = await askFrame(tabId, f.frameId);
      if (resp && Array.isArray(resp.urls)) {
        for (const it of resp.urls) {
          if (!it) continue;
          const url = (typeof it === 'string') ? it : it.url;
          if (!url) continue;
          const w   = (typeof it === 'object' && Number.isFinite(+it.w))   ? +it.w   : 0;
          const h   = (typeof it === 'object' && Number.isFinite(+it.h))   ? +it.h   : 0;
          const ord = (typeof it === 'object' && Number.isFinite(+it.ord)) ? +it.ord : undefined;
          const prio = (typeof it === 'object' && Number.isFinite(+it.prio)) ? +it.prio : undefined;
          const prev = byUrl.get(url);
          if (!prev) {
            byUrl.set(url, { url, w, h, ord, prio });
          } else {
            if ((!prev.w && w) || (!prev.h && h)) { prev.w = Math.max(prev.w || 0, w); prev.h = Math.max(prev.h || 0, h); }
            if (typeof ord === 'number') {
              if (typeof prev.ord !== 'number' || ord < prev.ord) prev.ord = ord;
            }
            if(typeof prio === 'number'){
              if (typeof prev.prio !== 'number' || prio < prev.prio) prev.prio = prio;
            }
          }
        }
      }
      if (!name && resp && resp.productName) name = resp.productName;
    }
    return { items: Array.from(byUrl.values()), productName: name };
  }

  async function setDomainActive(tabId, active, baseDomain) {
    const { allowedDomains = {} } = await storageGet({ allowedDomains: {} }, { allowedDomains: {} });
    allowedDomains[baseDomain] = !!active;
    B.storage.local.set({ allowedDomains });
    const frames = await getAllFrames(tabId).catch(()=>[{frameId:0}]);
    await Promise.all(frames.map(f => new Promise((resolve) => {
      try {
        B.tabs.sendMessage(tabId, { type: 'setActiveForDomain', active }, { frameId: f.frameId }, () => resolve());
      } catch { resolve(); }
    })));
  }

  function baseDomain(host) {
    if (!host) return '';
    const parts = host.split('.');
    return parts.length <= 2 ? host : parts.slice(-2).join('.');
  }

  async function init() {
    try {
      await loadSettings();
      await loadCustomSelectors();
      const tab = await getActiveTab();
      if (!tab) { render([], '', false); return; }
      const url = new URL(tab.url);
      const bdom = baseDomain(url.hostname);
      domainLabel.textContent = bdom;
      const { allowedDomains = {} } = await storageGet({ allowedDomains: {} }, { allowedDomains: {} });
      const isActive = !!allowedDomains[bdom];
      enableDomainCb.checked = isActive;
      enableDomainCb.addEventListener('change', async () => {
        await setDomainActive(tab.id, enableDomainCb.checked, bdom);
        if (enableDomainCb.checked) {
          const { items, productName } = await collectFromAllFrames(tab.id);
          render(items, productName || '', true);
        } else {
          render([], '', false);
        }
      });
      if (!isActive) { render([], '', false); return; }
      let { items, productName } = await collectFromAllFrames(tab.id);
      if (!items.length) {
        await new Promise(r => setTimeout(r, 250));
        const r2 = await collectFromAllFrames(tab.id);
        if (r2.items.length) { items = r2.items; productName = r2.productName || productName; }
      }
      render(items, productName || '', true);
    } catch (e) {
      console.error(e);
      render([], '', false);
    }
  }

  init();
})();
