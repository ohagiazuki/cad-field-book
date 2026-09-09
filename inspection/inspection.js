(() => {
  'use strict';
  pdfjsLib.GlobalWorkerOptions.workerSrc = '../pdfjs/pdf.worker.min.js';
  const pdfOptions = {
    cMapUrl: '../pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '../pdfjs/standard_fonts/'
  };
  const $ = (id) => document.getElementById(id);
  const state = {
    element: { doc: null, page: 1, viewer: $('elementViewer'), label: $('elementPage'), zoom: 1, focus: null },
    photo: { doc: null, page: 1, viewer: $('photoViewer'), label: $('photoPage'), zoom: 1, focus: null, matches: null },
    photoIndex: new Map(), renderToken: { element: 0, photo: 0 },
    ocrWorker: null, ocrHotspots: new Map(), ocrJobs: new Map()
  };
  const normalizeDigits = (value) => value.replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xFEE0));
  const damageNumbers = (value) => {
    const normalized = normalizeDigits(value).replace(/[\s　]+/g, '').replace(/損傷[OoＯ〇]/g, '損傷0');
    const numbers = [];
    for (const match of normalized.matchAll(/損傷[「『\[（(]?((?:0*\d{1,4})(?:[、,，・／/]0*\d{1,4})*)/g)) {
      for (const part of match[1].split(/[、,，・／/]/)) {
        const number = String(Number(part));
        if (number !== '0' && number !== 'NaN') numbers.push(number);
      }
    }
    return numbers;
  };
  const resolveDamageNumber = (raw) => {
    const number = String(Number(raw));
    if (!state.photoIndex.size || state.photoIndex.has(number)) return number;
    const digits = String(raw).replace(/\D/g, '');
    for (let i = 1; i < digits.length; i++) {
      if (digits[i] !== digits[i - 1]) continue;
      const deduplicated = String(Number(digits.slice(0, i) + digits.slice(i + 1)));
      if (state.photoIndex.has(deduplicated)) return deduplicated;
    }
    const candidates = new Set();
    for (let i = 0; i < digits.length; i++) {
      const candidate = String(Number(digits.slice(0, i) + digits.slice(i + 1)));
      if (candidate !== '0' && candidate !== 'NaN' && state.photoIndex.has(candidate)) candidates.add(candidate);
    }
    return candidates.size === 1 ? [...candidates][0] : number;
  };
  async function loadPdf(file, side) {
    const target = state[side];
    target.viewer.innerHTML = '<div class="loading">PDFを読み込んでいます…</div>';
    $('globalStatus').textContent = `${file.name} を読み込んでいます`;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      target.doc = await pdfjsLib.getDocument({ data: bytes, ...pdfOptions }).promise;
      const requestedPage = Number(new URLSearchParams(location.search).get(`${side}Page`));
      target.page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
      target.zoom = 1;
      target.focus = null;
      target.matches = null;
      $(side === 'element' ? 'elementName' : 'photoName').textContent = file.name;
      if (side === 'photo') await buildPhotoIndex();
      await renderSide(side);
      if (side === 'photo' && state.element.doc) {
        state.ocrHotspots.clear();
        await renderSide('element');
      }
      $('globalStatus').textContent = side === 'photo'
        ? `損傷写真を索引化しました（${state.photoIndex.size}番号）`
        : '部材要素番号図の「損傷○○」をタップしてください';
    } catch (error) {
      target.viewer.innerHTML = `<div class="empty">PDFを読み込めませんでした<br>${escapeHtml(String(error))}</div>`;
      $('globalStatus').textContent = 'PDF読み込みエラー';
    }
  }
  async function buildPhotoIndex() {
    state.photoIndex.clear();
    const doc = state.photo.doc;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      $('globalStatus').textContent = `損傷写真の索引を作成中 ${pageNumber} / ${doc.numPages}`;
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const strings = content.items.map(item => item.str || '');
      const viewport = page.getViewport({ scale: 1 });
      for (let i = 0; i < strings.length; i++) {
        const ownNumbers = damageNumbers(strings[i]);
        const windowStrings = strings.slice(i, i + 4);
        // A complete label in a later item must not be attributed to the
        // coordinates of an earlier table cell. Joined text is only a fallback
        // for PDFs that split "損傷" and its number into separate items.
        if (!ownNumbers.length && windowStrings.some(value => damageNumbers(value).length)) continue;
        const numbers = [...new Set(ownNumbers.length ? ownNumbers : damageNumbers(windowStrings.join('')))];
        if (!numbers.length) continue;
        const anchorOffset = ownNumbers.length ? 0 : Math.max(0, windowStrings.findIndex(value => /損|傷/.test(value)));
        const item = content.items[i + anchorOffset] || content.items[i];
        const x = Number(item?.transform?.[4] || 0);
        const y = Number(item?.transform?.[5] || 0);
        const focus = { column: x >= viewport.width / 2 ? 1 : 0, row: y < viewport.height / 2 ? 1 : 0 };
        for (const number of numbers) {
          const entries = state.photoIndex.get(number) || [];
          if (!entries.some(entry => entry.page === pageNumber && entry.focus.column === focus.column && entry.focus.row === focus.row)) {
            entries.push({ page: pageNumber, focus });
            state.photoIndex.set(number, entries);
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  async function renderSide(side) {
    const target = state[side];
    if (!target.doc) return;
    if (side === 'photo' && target.matches?.length) {
      await renderPhotoMatches();
      return;
    }
    target.page = Math.max(1, Math.min(target.doc.numPages, target.page));
    const token = ++state.renderToken[side];
    const page = await target.doc.getPage(target.page);
    const base = page.getViewport({ scale: 1 });
    const crop = side === 'photo' && target.focus
      ? { x: target.focus.column * base.width / 2, y: base.height * (target.focus.row ? .55 : .255), width: base.width / 2, height: base.height * .315 }
      : { x: 0, y: 0, width: base.width, height: base.height };
    const available = Math.max(320, target.viewer.clientWidth - 18);
    const cssScale = available / crop.width * target.zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const viewport = page.getViewport({ scale: cssScale * dpr });
    const wrap = document.createElement('div');
    wrap.className = 'pageWrap';
    wrap.style.width = `${crop.width * cssScale}px`;
    wrap.style.height = `${crop.height * cssScale}px`;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(crop.width * cssScale * dpr);
    canvas.height = Math.ceil(crop.height * cssScale * dpr);
    wrap.appendChild(canvas);
    target.viewer.replaceChildren(wrap);
    if (side === 'photo' && target.focus) {
      const factor = cssScale * dpr;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [1, 0, 0, 1, -crop.x * factor, -crop.y * factor] }).promise;
    } else {
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
    if (token !== state.renderToken[side]) return;
    target.label.textContent = `${target.page} / ${target.doc.numPages}`;
    $(side + 'ZoomLabel').textContent = `${Math.round(target.zoom * 100)}%`;
      if (side === 'element') await addDamageHotspots(page, wrap, cssScale);
  }
  async function renderPhotoMatches() {
    const target = state.photo;
    const token = ++state.renderToken.photo;
    const available = Math.max(320, target.viewer.clientWidth - 18);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const fragment = document.createDocumentFragment();
    for (const match of target.matches) {
      const page = await target.doc.getPage(match.page);
      const base = page.getViewport({ scale: 1 });
      const crop = { x: match.focus.column * base.width / 2, y: base.height * (match.focus.row ? .55 : .255), width: base.width / 2, height: base.height * .315 };
      const cssScale = available / crop.width * target.zoom;
      const factor = cssScale * dpr;
      const viewport = page.getViewport({ scale: factor });
      const wrap = document.createElement('div');
      wrap.className = 'pageWrap photoMatch';
      wrap.style.width = `${crop.width * cssScale}px`;
      wrap.style.height = `${crop.height * cssScale}px`;
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(crop.width * factor);
      canvas.height = Math.ceil(crop.height * factor);
      wrap.appendChild(canvas);
      fragment.appendChild(wrap);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [1, 0, 0, 1, -crop.x * factor, -crop.y * factor] }).promise;
      if (token !== state.renderToken.photo) return;
    }
    target.viewer.replaceChildren(fragment);
    target.label.textContent = `${target.matches.length}件`;
    $('photoZoomLabel').textContent = `${Math.round(target.zoom * 100)}%`;
  }
  async function addDamageHotspots(page, wrap, cssScale) {
    const content = await page.getTextContent();
    const items = content.items;
    const baseViewport = page.getViewport({ scale: cssScale });
    const found = new Set();
    for (let i = 0; i < items.length; i++) {
      const sequences = [items[i].str || '', items.slice(i, i + 4).map(v => v.str || '').join('')];
      const numbers = [...new Set(sequences.flatMap(damageNumbers))];
      for (const number of numbers) {
        const key = `${number}:${i}`;
        if (found.has(key)) continue;
        found.add(key);
        const transform = pdfjsLib.Util.transform(baseViewport.transform, items[i].transform);
        const fontHeight = Math.max(12, Math.hypot(transform[2], transform[3]));
        const button = document.createElement('button');
        button.className = 'hotspot';
        button.dataset.label = `損傷${number.padStart(2, '0')}`;
        button.title = `${button.dataset.label} の写真を表示`;
        button.style.left = `${transform[4] - 6}px`;
        button.style.top = `${transform[5] + 5}px`;
        button.style.width = `${Math.max(44, (items[i].width || 28) * cssScale + 14)}px`;
        button.style.height = `${Math.max(28, fontHeight + 10)}px`;
        button.addEventListener('click', event => { event.stopPropagation(); jumpToDamage(number); });
        wrap.appendChild(button);
      }
    }
    if (found.size === 0) {
      await addOcrDamageHotspots(page, wrap);
    } else {
      $('globalStatus').textContent = `${found.size}件の損傷番号を認識しました`;
    }
  }
  async function ensureOcrWorker() {
    if (state.ocrWorker) return state.ocrWorker;
    $('globalStatus').textContent = '図形化された損傷番号の画像認識を準備中…';
    state.ocrWorker = await Tesseract.createWorker('jpn', 1, {
      workerPath: '../tesseract/worker.min.js',
      langPath: '../tesseract/lang',
      corePath: '../tesseract/tesseract-core-lstm.wasm.js',
      logger: message => {
        if (message.status === 'recognizing text') {
          $('globalStatus').textContent = `損傷番号を画像認識中 ${Math.round((message.progress || 0) * 100)}%`;
        }
      }
    });
    await state.ocrWorker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
      preserve_interword_spaces: '1',
      user_defined_dpi: '220'
    });
    return state.ocrWorker;
  }
  function showDamageChoice(numbers, anchor) {
    document.querySelector('.damage-choice')?.remove();
    const chooser = document.createElement('div');
    chooser.className = 'damage-choice';
    for (const number of numbers) {
      const option = document.createElement('button');
      option.textContent = `損傷${number.padStart(2, '0')}`;
      option.addEventListener('click', event => {
        event.stopPropagation();
        chooser.remove();
        jumpToDamage(number);
      });
      chooser.appendChild(option);
    }
    chooser.style.left = `${anchor.offsetLeft}px`;
    chooser.style.top = `${anchor.offsetTop + anchor.offsetHeight + 4}px`;
    anchor.parentElement.appendChild(chooser);
  }
  function addHotspot(wrap, numberOrNumbers, box, sourceWidth, sourceHeight) {
    const numbers = Array.isArray(numberOrNumbers) ? numberOrNumbers : [numberOrNumbers];
    const button = document.createElement('button');
    button.className = 'hotspot';
    button.dataset.label = numbers.map(number => `損傷${number.padStart(2, '0')}`).join('・');
    button.title = numbers.length > 1 ? `${button.dataset.label} から選択` : `${button.dataset.label} の写真を表示`;
    // OCR sometimes returns the whole annotation line. Derive the visible width
    // from the character height so the outline covers only "損傷00", while the
    // invisible button remains large enough to tap comfortably.
    const measuredHeight = box.height * wrap.clientHeight / sourceHeight;
    const visualHeight = Math.min(18, Math.max(12, measuredHeight));
    const visualWidth = Math.min(48, Math.max(30, visualHeight * 2.7));
    const tapWidth = Math.max(44, visualWidth + 12);
    const tapHeight = Math.max(34, visualHeight + 10);
    const centerX = (box.left + box.width / 2) * wrap.clientWidth / sourceWidth;
    const centerY = (box.top + box.height / 2) * wrap.clientHeight / sourceHeight;
    button.style.left = `${centerX - tapWidth / 2}px`;
    button.style.top = `${centerY - tapHeight / 2}px`;
    button.style.width = `${tapWidth}px`;
    button.style.height = `${tapHeight}px`;
    const outline = document.createElement('span');
    outline.className = 'hotspot-outline';
    outline.style.width = `${visualWidth}px`;
    outline.style.height = `${visualHeight}px`;
    button.appendChild(outline);
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (numbers.length > 1) showDamageChoice(numbers, button);
      else jumpToDamage(numbers[0]);
    });
    wrap.appendChild(button);
  }
  async function addOcrDamageHotspots(page, wrap) {
    const pageKey = state.element.page;
    if (state.ocrHotspots.has(pageKey)) return paintCachedOcrHotspots(pageKey, wrap);
    const running = state.ocrJobs.get(pageKey);
    if (running) {
      await running;
      return paintCachedOcrHotspots(pageKey, wrap);
    }
    const job = runOcrDamageHotspots(page, wrap);
    state.ocrJobs.set(pageKey, job);
    try { await job; } finally { state.ocrJobs.delete(pageKey); }
  }
  function paintCachedOcrHotspots(pageKey, wrap) {
    const cached = state.ocrHotspots.get(pageKey);
    if (!cached) return;
    for (const hit of cached.hits) addHotspot(wrap, hit.numbers || hit.number, hit.box, cached.width, cached.height);
    const count = cached.hits.reduce((total, hit) => total + (hit.numbers?.length || 1), 0);
    $('globalStatus').textContent = `${count}件の損傷番号を認識しました`;
  }
  async function runOcrDamageHotspots(page, wrap) {
    const pageKey = state.element.page;
    const cached = state.ocrHotspots.get(pageKey);
    if (cached) {
      paintCachedOcrHotspots(pageKey, wrap);
      return;
    }
    try {
      const base = page.getViewport({ scale: 1 });
      const ocrScale = Math.min(6, 5200 / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale: ocrScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      await page.render({ canvasContext: context, viewport }).promise;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const originalPixels = new Uint8ClampedArray(pixels.data);
      for (let i = 0; i < pixels.data.length; i += 4) {
        const r = pixels.data[i], g = pixels.data[i + 1], b = pixels.data[i + 2];
        // Damage labels are not always red. The Japanese pass reads every
        // sufficiently dark/coloured stroke and later keeps only "損傷00".
        const value = Math.min(r, g, b) < 205 ? 0 : 255;
        pixels.data[i] = value; pixels.data[i + 1] = value; pixels.data[i + 2] = value; pixels.data[i + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      const worker = await ensureOcrWorker();
      let hits = [];
      const appendJapaneseHits = (tsv, coordinateScale = 1) => {
        const rows = String(tsv || '').split(/\r?\n/).slice(1).map(line => line.split('\t')).filter(parts => parts.length >= 12 && parts[0] === '5');
        const lines = new Map();
        for (const parts of rows) {
          const key = `${parts[2]}:${parts[3]}:${parts[4]}`;
          const item = { left: Number(parts[6]) * coordinateScale, top: Number(parts[7]) * coordinateScale, width: Number(parts[8]) * coordinateScale, height: Number(parts[9]) * coordinateScale, text: parts.slice(11).join('\t') };
          if (!lines.has(key)) lines.set(key, []);
          lines.get(key).push(item);
        }
        for (const words of lines.values()) {
          const text = words.map(word => word.text).join('');
          const numbers = [...new Set(damageNumbers(text).map(resolveDamageNumber))]
            .filter(number => !state.photoIndex.size || state.photoIndex.has(number));
          if (!numbers.length) continue;
          for (const number of numbers) {
          const padded = number.padStart(2, '0');
          const matchedWords = words.filter(word => {
            const normalized = normalizeDigits(word.text).replace(/[\s　]+/g, '');
            return damageNumbers(normalized).map(resolveDamageNumber).includes(number) ||
              normalized.includes(`損傷${padded}`) || normalized === padded;
          });
          const source = matchedWords.length ? matchedWords : words.slice(0, 1);
          const left = Math.min(...source.map(word => word.left));
          const top = Math.min(...source.map(word => word.top));
          const right = Math.max(...source.map(word => word.left + word.width));
          const bottom = Math.max(...source.map(word => word.top + word.height));
          hits.push({ number, box: { left: left - 12, top: top - 7, width: right - left + 24, height: bottom - top + 14 } });
          }
        }
      };
      const result = await worker.recognize(canvas, {}, { tsv: true });
      appendJapaneseHits(result.data.tsv);
      // A second pass on the original colours catches light and anti-aliased
      // labels that disappear during thresholding.
      const colourPixels = context.getImageData(0, 0, canvas.width, canvas.height);
      colourPixels.data.set(originalPixels);
      context.putImageData(colourPixels, 0, 0);
      const colourResult = await worker.recognize(canvas, {}, { tsv: true });
      appendJapaneseHits(colourResult.data.tsv);
      // Dense pages can produce different correct labels at different raster
      // sizes. Merge the former 4000px pass with the high-resolution result.
      const legacyScale = Math.min(5, 4000 / Math.max(base.width, base.height));
      if (legacyScale < ocrScale) {
        const legacyViewport = page.getViewport({ scale: legacyScale });
        const legacyCanvas = document.createElement('canvas');
        legacyCanvas.width = Math.ceil(legacyViewport.width);
        legacyCanvas.height = Math.ceil(legacyViewport.height);
        const legacyContext = legacyCanvas.getContext('2d', { willReadFrequently: true });
        await page.render({ canvasContext: legacyContext, viewport: legacyViewport }).promise;
        const ratio = legacyScale / ocrScale;
        const legacyOriginal = legacyContext.getImageData(0, 0, legacyCanvas.width, legacyCanvas.height);
        const legacyColourResult = await worker.recognize(legacyCanvas, {}, { tsv: true });
        appendJapaneseHits(legacyColourResult.data.tsv, 1 / ratio);
        const legacyThreshold = legacyContext.getImageData(0, 0, legacyCanvas.width, legacyCanvas.height);
        for (let i = 0; i < legacyThreshold.data.length; i += 4) {
          const value = Math.min(legacyOriginal.data[i], legacyOriginal.data[i + 1], legacyOriginal.data[i + 2]) < 205 ? 0 : 255;
          legacyThreshold.data[i] = value;
          legacyThreshold.data[i + 1] = value;
          legacyThreshold.data[i + 2] = value;
          legacyThreshold.data[i + 3] = 255;
        }
        legacyContext.putImageData(legacyThreshold, 0, 0);
        const legacyThresholdResult = await worker.recognize(legacyCanvas, {}, { tsv: true });
        appendJapaneseHits(legacyThresholdResult.data.tsv, 1 / ratio);
      }
      // Some inspection PDFs convert every red annotation to vector outlines.
      // Japanese OCR may then miss the word "損傷" even though its two digits
      // remain clear. A digits-only pass supplies tap targets for those labels.
      if (hits.length === 0) {
        const numericPixels = context.getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < numericPixels.data.length; i += 4) {
          const r = originalPixels[i], g = originalPixels[i + 1], b = originalPixels[i + 2];
          const isRed = r > 105 && r > g * 1.22 && r > b * 1.22;
          const value = isRed ? 0 : 255;
          numericPixels.data[i] = value;
          numericPixels.data[i + 1] = value;
          numericPixels.data[i + 2] = value;
          numericPixels.data[i + 3] = 255;
        }
        context.putImageData(numericPixels, 0, 0);
        await worker.setParameters({
          tessedit_char_whitelist: '0123456789',
          tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT
        });
        const numericResults = [await worker.recognize(canvas, {}, { tsv: true })];
        await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO });
        numericResults.push(await worker.recognize(canvas, {}, { tsv: true }));
        await worker.setParameters({ tessedit_char_whitelist: '' });
        const known = new Set(hits.map(hit => hit.number));
        for (const numericResult of numericResults) {
          const numericRows = String(numericResult.data.tsv || '').split(/\r?\n/).slice(1).map(line => line.split('\t')).filter(parts => parts.length >= 12 && parts[0] === '5');
          for (const parts of numericRows) {
            const raw = normalizeDigits(parts.slice(11).join('\t')).replace(/\D/g, '');
            if (!/^\d{1,3}$/.test(raw)) continue;
            const number = resolveDamageNumber(raw);
            if (number === '0' || known.has(number)) continue;
            if (state.photoIndex.size && !state.photoIndex.has(number)) continue;
            known.add(number);
            hits.push({
              number,
              box: { left: Number(parts[6]) - 38, top: Number(parts[7]) - 9, width: Number(parts[8]) + 50, height: Number(parts[9]) + 18 }
            });
          }
        }
      }
      // If OCR reads one label as an existing number (for example 52 as 62),
      // use the spatial order of its confirmed neighbours to repair the duplicate.
      const center = hit => ({ x: hit.box.left + hit.box.width / 2, y: hit.box.top + hit.box.height / 2 });
      const presentNumbers = new Set(hits.map(hit => hit.number));
      const byNumber = new Map();
      for (const hit of hits) {
        if (!byNumber.has(hit.number)) byNumber.set(hit.number, []);
        byNumber.get(hit.number).push(hit);
      }
      for (const [number, duplicates] of byNumber) {
        const distinct = duplicates.filter((hit, index, list) => {
          const point = center(hit);
          return list.findIndex(other => {
            const otherPoint = center(other);
            return Math.hypot(point.x - otherPoint.x, point.y - otherPoint.y) < 80;
          }) === index;
        });
        if (distinct.length < 2 || !state.photoIndex.size) continue;
        const candidates = [...state.photoIndex.keys()].filter(candidate => {
          if (candidate.length !== number.length || presentNumbers.has(candidate)) return false;
          let differences = 0;
          for (let i = 0; i < candidate.length; i++) if (candidate[i] !== number[i]) differences++;
          return differences === 1 && presentNumbers.has(String(Number(candidate) - 1)) && presentNumbers.has(String(Number(candidate) + 1));
        });
        if (candidates.length !== 1) continue;
        const candidate = candidates[0];
        const neighbours = hits.filter(hit => hit.number === String(Number(candidate) - 1) || hit.number === String(Number(candidate) + 1));
        if (!neighbours.length) continue;
        const target = neighbours.reduce((sum, hit) => {
          const point = center(hit);
          return { x: sum.x + point.x, y: sum.y + point.y };
        }, { x: 0, y: 0 });
        target.x /= neighbours.length; target.y /= neighbours.length;
        const replacement = distinct.sort((a, b) => {
          const pa = center(a), pb = center(b);
          return Math.hypot(pa.x - target.x, pa.y - target.y) - Math.hypot(pb.x - target.x, pb.y - target.y);
        })[0];
        for (const hit of duplicates) {
          const p = center(hit), r = center(replacement);
          if (Math.hypot(p.x - r.x, p.y - r.y) < 80) hit.number = candidate;
        }
        presentNumbers.add(candidate);
      }
      // Prefer the smallest, most precise candidate when OCR creates boxes at
      // almost the same place. This prevents overlapping orange tap targets.
      const area = hit => Math.max(1, hit.box.width * hit.box.height);
      const overlapRatio = (a, b) => {
        const left = Math.max(a.box.left, b.box.left);
        const top = Math.max(a.box.top, b.box.top);
        const right = Math.min(a.box.left + a.box.width, b.box.left + b.box.width);
        const bottom = Math.min(a.box.top + a.box.height, b.box.top + b.box.height);
        const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
        return intersection / Math.min(area(a), area(b));
      };
      const compact = [];
      const isOneExtraDigit = (longer, shorter) => {
        const a = String(longer), b = String(shorter);
        if (a.length !== b.length + 1) return false;
        for (let i = 0; i < a.length; i++) {
          if (a.slice(0, i) + a.slice(i + 1) === b) return true;
        }
        return false;
      };
      const isOneDigitDifferent = (a, b) => {
        a = String(a); b = String(b);
        if (a.length !== b.length) return false;
        let differences = 0;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differences++;
        return differences === 1;
      };
      const neighbourScore = number =>
        (presentNumbers.has(String(Number(number) - 1)) ? 1 : 0) +
        (presentNumbers.has(String(Number(number) + 1)) ? 1 : 0);
      for (const hit of [...hits].sort((a, b) => area(a) - area(b))) {
        const existing = compact.find(candidate => overlapRatio(candidate, hit) > .55);
        if (existing) {
          const currentNumbers = existing.numbers || [existing.number];
          const related = currentNumbers.find(number => isOneExtraDigit(hit.number, number) || isOneExtraDigit(number, hit.number));
          if (related) {
            if (neighbourScore(hit.number) > neighbourScore(related)) {
              Object.assign(existing, hit);
              delete existing.numbers;
            }
            continue;
          }
          const similar = currentNumbers.find(number => isOneDigitDifferent(hit.number, number));
          if (similar && neighbourScore(hit.number) !== neighbourScore(similar)) {
            if (neighbourScore(hit.number) > neighbourScore(similar)) {
              Object.assign(existing, hit);
              delete existing.numbers;
            }
            continue;
          }
          existing.numbers = [...new Set([...currentNumbers, hit.number])]
            .sort((a, b) => Number(a) - Number(b));
          continue;
        }
        compact.push(hit);
      }
      hits = compact;
      state.ocrHotspots.set(pageKey, { hits, width: canvas.width, height: canvas.height });
      for (const hit of hits) addHotspot(wrap, hit.numbers || hit.number, hit.box, canvas.width, canvas.height);
      const recognizedCount = hits.reduce((count, hit) => count + (hit.numbers?.length || 1), 0);
      $('globalStatus').textContent = recognizedCount
        ? `${recognizedCount}件の損傷番号を画像認識しました。オレンジ枠をタップしてください`
        : '損傷番号を画像認識できませんでした。右上の番号入力をご利用ください';
    } catch (error) {
      console.error('Damage OCR failed', error);
      $('globalStatus').textContent = '画像認識に失敗しました。右上の番号入力をご利用ください';
    }
  }
  async function jumpToDamage(raw) {
    const number = String(Number(normalizeDigits(String(raw)).replace(/\D/g, '')));
    if (!number || number === 'NaN') return;
    $('damageInput').value = number.padStart(2, '0');
    if (!state.photo.doc) { $('matchStatus').textContent = '先に損傷写真PDFを選択してください'; return; }
    const entries = state.photoIndex.get(number);
    if (!entries?.length) { $('matchStatus').textContent = `損傷${number.padStart(2, '0')}が見つかりません`; return; }
    state.photo.page = entries[0].page;
    state.photo.focus = entries[0].focus;
    state.photo.matches = entries;
    state.photo.zoom = 1;
    $('matchStatus').textContent = `損傷${number.padStart(2, '0')}：${entries.length}件（写真欄を拡大）`;
    await renderSide('photo');
  }
  function bindPager(side) {
    const move = (delta) => {
      state[side].page += delta;
      state[side].focus = null;
      state[side].matches = null;
      state[side].zoom = 1;
      renderSide(side);
    };
    $(side + 'Prev').addEventListener('click', () => move(-1));
    $(side + 'Next').addEventListener('click', () => move(1));
  }
  function bindZoom(side) {
    const change = (factor) => {
      state[side].zoom = Math.max(.5, Math.min(4, state[side].zoom * factor));
      renderSide(side);
    };
    $(side + 'ZoomOut').addEventListener('click', () => change(1 / 1.25));
    $(side + 'ZoomIn').addEventListener('click', () => change(1.25));
    $(side + 'Fit').addEventListener('click', () => {
      state[side].zoom = 1;
      if (side === 'photo') { state.photo.focus = null; state.photo.matches = null; }
      renderSide(side);
    });
  }
  function bindGestureZoom(side) {
    const target = state[side];
    const viewer = target.viewer;
    let pinchStartDistance = 0;
    let pinchStartZoom = 1;
    let pinchAnchor = null;
    let previewRatio = 1;
    let wheelTimer = 0;
    const distance = touches => Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY
    );
    const captureAnchor = (clientX, clientY) => {
      const pages = [...viewer.querySelectorAll('.pageWrap')];
      if (!pages.length) return null;
      let index = pages.findIndex(page => {
        const rect = page.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
      });
      if (index < 0) index = pages.reduce((best, page, current) => {
        const rect = page.getBoundingClientRect();
        const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
        return dy < best.distance ? { index: current, distance: dy } : best;
      }, { index: 0, distance: Infinity }).index;
      const rect = pages[index].getBoundingClientRect();
      return {
        index, clientX, clientY,
        xRatio: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
        yRatio: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
      };
    };
    const restoreAnchor = anchor => {
      if (!anchor) return;
      const page = viewer.querySelectorAll('.pageWrap')[anchor.index];
      if (!page) return;
      const rect = page.getBoundingClientRect();
      const newX = rect.left + rect.width * anchor.xRatio;
      const newY = rect.top + rect.height * anchor.yRatio;
      viewer.scrollLeft += newX - anchor.clientX;
      viewer.scrollTop += newY - anchor.clientY;
    };
    const clearPreview = () => {
      for (const page of viewer.querySelectorAll('.pageWrap')) {
        page.style.transform = '';
        page.style.transformOrigin = '';
      }
    };
    viewer.addEventListener('touchstart', event => {
      if (event.touches.length !== 2) return;
      pinchStartDistance = distance(event.touches);
      pinchStartZoom = target.zoom;
      pinchAnchor = captureAnchor(
        (event.touches[0].clientX + event.touches[1].clientX) / 2,
        (event.touches[0].clientY + event.touches[1].clientY) / 2
      );
      previewRatio = 1;
      event.preventDefault();
    }, { passive: false });
    viewer.addEventListener('touchmove', event => {
      if (event.touches.length !== 2 || !pinchStartDistance) return;
      const nextZoom = Math.max(.5, Math.min(4, pinchStartZoom * distance(event.touches) / pinchStartDistance));
      previewRatio = nextZoom / pinchStartZoom;
      target.zoom = nextZoom;
      $(side + 'ZoomLabel').textContent = `${Math.round(nextZoom * 100)}%`;
      for (const page of viewer.querySelectorAll('.pageWrap')) {
        page.style.transformOrigin = pinchAnchor
          ? `${pinchAnchor.xRatio * 100}% ${pinchAnchor.yRatio * 100}%`
          : 'center top';
        page.style.transform = `scale(${previewRatio})`;
      }
      event.preventDefault();
    }, { passive: false });
    const finishPinch = async event => {
      if (!pinchStartDistance || event.touches.length > 1) return;
      pinchStartDistance = 0;
      clearPreview();
      await renderSide(side);
      restoreAnchor(pinchAnchor);
      pinchAnchor = null;
    };
    viewer.addEventListener('touchend', finishPinch, { passive: true });
    viewer.addEventListener('touchcancel', finishPinch, { passive: true });
    viewer.addEventListener('wheel', event => {
      if (!target.doc) return;
      event.preventDefault();
      const anchor = captureAnchor(event.clientX, event.clientY);
      const factor = Math.exp(-event.deltaY * .0015);
      target.zoom = Math.max(.5, Math.min(4, target.zoom * factor));
      $(side + 'ZoomLabel').textContent = `${Math.round(target.zoom * 100)}%`;
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(async () => {
        await renderSide(side);
        restoreAnchor(anchor);
      }, 90);
    }, { passive: false });
  }
  function bindPaneDivider() {
    const divider = $('paneDivider');
    const main = divider.parentElement;
    let dragging = false;
    divider.addEventListener('pointerdown', event => {
      dragging = true;
      divider.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    divider.addEventListener('pointermove', event => {
      if (!dragging) return;
      const rect = main.getBoundingClientRect();
      if (matchMedia('(max-width: 700px) and (orientation: portrait)').matches) {
        const percent = Math.max(25, Math.min(75, (event.clientY - rect.top) / rect.height * 100));
        main.style.gridTemplateRows = `${percent}% 8px minmax(180px, 1fr)`;
      } else {
        const percent = Math.max(25, Math.min(75, (event.clientX - rect.left) / rect.width * 100));
        main.style.setProperty('--left-pane', `${percent}%`);
      }
      event.preventDefault();
    });
    const finish = event => {
      if (!dragging) return;
      dragging = false;
      if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
      renderSide('element');
      renderSide('photo');
    };
    divider.addEventListener('pointerup', finish);
    divider.addEventListener('pointercancel', finish);
  }
  function escapeHtml(value) { const div = document.createElement('div'); div.textContent = value; return div.innerHTML; }
  $('elementFile').addEventListener('change', e => e.target.files[0] && loadPdf(e.target.files[0], 'element'));
  $('photoFile').addEventListener('change', e => e.target.files[0] && loadPdf(e.target.files[0], 'photo'));
  $('damageJump').addEventListener('click', () => jumpToDamage($('damageInput').value));
  $('damageInput').addEventListener('keydown', e => { if (e.key === 'Enter') jumpToDamage(e.target.value); });
  $('elementColorToggle').addEventListener('click', event => {
    const enabled = !state.element.viewer.classList.contains('monochrome');
    state.element.viewer.classList.toggle('monochrome', enabled);
    event.currentTarget.setAttribute('aria-pressed', String(enabled));
    event.currentTarget.textContent = enabled ? 'カラー' : 'モノクロ';
  });
  $('backButton').addEventListener('click', () => { location.href = '../?mode=draw'; });
  bindPager('element'); bindPager('photo');
  bindZoom('element'); bindZoom('photo');
  bindGestureZoom('element'); bindGestureZoom('photo');
  bindPaneDivider();
  window.addEventListener('resize', () => { clearTimeout(window.__inspectionResize); window.__inspectionResize = setTimeout(() => { renderSide('element'); renderSide('photo'); }, 180); });
  const startup = new URLSearchParams(location.search);
  const loadUrl = async (url, side) => {
    const response = await fetch(url);
    const blob = await response.blob();
    await loadPdf(new File([blob], url.split('/').pop() || `${side}.pdf`, { type: 'application/pdf' }), side);
  };
  (async () => {
    try {
      // The photo index is the authoritative number list. Build it first so
      // element OCR can reject drawing dimensions and repair stray OCR digits.
      const photoUrl = startup.get('photoUrl');
      const elementUrl = startup.get('elementUrl');
      if (photoUrl) await loadUrl(photoUrl, 'photo');
      if (elementUrl) await loadUrl(elementUrl, 'element');
    } catch (error) {
      $('globalStatus').textContent = `PDFを読み込めませんでした: ${error}`;
    }
  })();
})();
