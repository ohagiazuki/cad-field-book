(() => {
  'use strict';
  pdfjsLib.GlobalWorkerOptions.workerSrc = '../pdfjs/pdf.worker.min.js';
  const pdfOptions = {
    cMapUrl: '../pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '../pdfjs/standard_fonts/'
  };
  const $ = (id) => document.getElementById(id);
  // Field drawings need to remain unobtrusive over dense PDF annotations.
  // The previous 18px text default is now exactly 25% (4.5px), and the
  // previous thin line becomes the new standard with an extra-fine option.
  $('drawFontSize').innerHTML = '<option value="3">極小</option><option value="4.5" selected>標準</option><option value="9">大</option><option value="18">特大</option>';
  $('drawWidth').innerHTML = '<option value="0.75">極細</option><option value="1.5" selected>標準</option><option value="3">太</option><option value="5">極太</option>';
  const MIN_PDF_ZOOM = .25, MAX_PDF_ZOOM = 20;
  const safeRenderDpr = (width, height, scale) => Math.max(.35, Math.min(
    window.devicePixelRatio || 1,
    2.5,
    12000 / Math.max(width, height) / scale,
    Math.sqrt(64000000 / Math.max(1, width * height * scale * scale))
  ));
  const state = {
    element: { doc: null, page: 1, viewer: $('elementViewer'), label: $('elementPage'), zoom: 1, focus: null },
    photo: { doc: null, page: 1, viewer: $('photoViewer'), label: $('photoPage'), zoom: 1, focus: null, matches: null, pageOverview: false, fitPaneAfterRender: false, dockMode: 'free' },
    photoIndex: new Map(), damageNumberDigits: 2, assessmentIndex: new Map(), assessmentRows: [], assessmentDoc: null, assessmentFocusNumbers: [], assessmentFocusSpan: '', currentDamage: null, renderToken: { element: 0, photo: 0 },
    ocrWorker: null, ocrHotspots: new Map(), textDamageNumbers: new Map(), elementSpanNumbers: new Map(), ocrJobs: new Map(), ocrProgress: null, missingDamageNumbers: [], missingPhotoNumbers: [], ignoredMissing: new Set(), manualHotspots: new Map(), hotspotOverrides: new Map(), pendingManualDamage: null,
    drawMode: 'select', previousDrawMode: 'free', drawingSide: 'element', pendingImage: '', annotations: new Map(), photoAnnotations: new Map(), activePhotoAnnotationKey: null, selectedAnnotation: null, annotationCopyArmed: false, hotspotEditMode: false, editingHotspot: null
  };
  const cleanField = value => String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  function fieldRightOf(items, pattern) {
    const label = items.find(item => pattern.test(cleanField(item.str)));
    if (!label) return '';
    const labelText = cleanField(label.str);
    const inline = cleanField(labelText.replace(pattern, '').replace(/^[:：\s]+/, ''));
    if (inline) return inline;
    const lx = Number(label.transform?.[4] || 0), ly = Number(label.transform?.[5] || 0);
    return cleanField(items.filter(item => {
      const text = cleanField(item.str), x = Number(item.transform?.[4] || 0), y = Number(item.transform?.[5] || 0);
      return text && item !== label && x > lx && Math.abs(y - ly) <= 5;
    }).sort((a, b) => Number(a.transform?.[4] || 0) - Number(b.transform?.[4] || 0)).map(item => item.str).join(' '));
  }
  function spanNumberFromItems(items) {
    const direct = fieldRightOf(items, /径間番号|径間/);
    const joined = items.map(item => cleanField(item.str)).join(' ');
    const source = direct || joined.match(/(?:第\s*)?([0-9０-９]+)\s*径間/)?.[1] || '';
    const digits = normalizeDigits(String(source)).match(/\d+/)?.[0];
    return digits ? String(Number(digits)) : '';
  }
  function photoRecordFromItems(items, focus, pageNumber, damageNumber, pageSpanNumber = '') {
    if (!items?.length) return { damageNumber, pageNumber };
    const xs = items.map(item => Number(item.transform?.[4] || 0));
    const ys = items.map(item => Number(item.transform?.[5] || 0));
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const local = items.filter(item => {
      const x = Number(item.transform?.[4] || 0), y = Number(item.transform?.[5] || 0);
      return (focus.column ? x >= midX : x < midX) && (focus.row ? y < midY : y >= midY);
    });
    const labels = {
      photoNumber: /写真番号/, spanNumber: /径間番号|径間/, memberName: /部材名|部材名称/,
      memberNumber: /要素番号|部材番号/, damageType: /損傷の種類|損傷種類/,
      damageLevel: /損傷程度/, memo: /メモ/
    };
    const record = { damageNumber, pageNumber };
    for (const [key, pattern] of Object.entries(labels)) record[key] = fieldRightOf(local, pattern);
    record.spanNumber = record.spanNumber || pageSpanNumber;
    return record;
  }
  const annotationMetadata = () => state.currentDamage ? JSON.parse(JSON.stringify(state.currentDamage)) : null;
  function automaticLeaderText() {
    const info = state.currentDamage;
    if (!info) return '';
    const record = info.records?.[0] || {};
    const member = [record.memberName, record.memberNumber].filter(Boolean).join(' ');
    const damage = [record.damageType, record.damageLevel].filter(Boolean).join(' ');
    return [member, damage, `損傷${String(info.damageNumber || '').padStart(2, '0')}`].filter(Boolean).join(' / ');
  }
  const normalizeDigits = (value) => value.replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xFEE0));
  const formatDamageNumber = value => String(Number(value)).padStart(state.damageNumberDigits, '0');
  const detectDamageNumberDigits = value => {
    const normalized = normalizeDigits(String(value || '')).replace(/[OoＯ〇]/g, '0').replace(/[Il|]/g, '1').replace(/[\s　]+/g, '');
    let width = 0;
    for (const match of normalized.matchAll(/損傷[^0-9]{0,3}(\d{1,4}(?:[、,，・／/]\d{1,4})*)/g)) {
      for (const part of match[1].split(/[、,，・／/]/)) width = Math.max(width, part.length);
    }
    return width;
  };
  const damageNumbers = (value) => {
    const normalized = normalizeDigits(value).replace(/[\s　]+/g, '').replace(/損傷([0-9OoＯ〇Il|gqｇｑ]{1,4})/g, (_, token) =>
      `損傷${token.replace(/[OoＯ〇]/g, '0').replace(/[Il|]/g, '1').replace(/[gqｇｑ]/g, '9')}`);
    const numbers = [];
    for (const match of normalized.matchAll(/損傷[「『\[（(]?((?:0*\d{1,4})(?:[、,，・／/\.．]0*\d{1,4})*)/g)) {
      for (const part of match[1].split(/[、,，・／/\.．]/)) {
        const number = String(Number(part));
        if (number !== '0' && number !== 'NaN') numbers.push(number);
      }
    }
    return numbers;
  };
  const bracketOnlyNumbers = value => {
    const normalized = normalizeDigits(String(value || '')).replace(/[OoＯ〇]/g, '0').replace(/[Il|]/g, '1').replace(/[gqｇｑ]/g, '9').replace(/[\s　]+/g, '');
    const numbers = [];
    for (const match of normalized.matchAll(/[［\[【（(「『]([^］\]】）)」』]{1,18})[］\]】）)」』]/g)) {
      const content = match[1].replace(/^.*?損傷/, '');
      if (!/^[0-9]{1,3}(?:[、,，・／/\.．][0-9]{1,3})*$/.test(content)) continue;
      for (const part of content.split(/[、,，・／/\.．]/)) {
        const number = String(Number(part));
        if (number !== '0' && number !== 'NaN') numbers.push(number);
      }
    }
    return numbers;
  };
  const isBracketedDamage = (value, number) => {
    const text = normalizeDigits(String(value || ''))
      .replace(/損傷[OoＯ〇]/g, '損傷0')
      .replace(/[\s　]+/g, '');
    const target = `損傷0*${Number(number)}`;
    const opening = '[［\\[【（(「『]';
    const closing = '[］\\]】）)」』]';
    // OCR frequently drops one thin bracket stroke. Accept one confirmed side,
    // but still require it to touch this exact damage number so a neighbouring
    // callout on the same OCR line cannot lend its brackets.
    return new RegExp(`${opening}${target}${closing}`).test(text) ||
      new RegExp(`${opening}${target}(?!\\d)`).test(text) ||
      new RegExp(`${target}${closing}`).test(text);
  };
  const bracketedDamageNumbers = value => [...new Set(damageNumbers(value).filter(number => isBracketedDamage(value, number)))];
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
      if (side === 'photo') target.pageOverview = false;
      if (side === 'element') { state.ocrHotspots.clear(); state.textDamageNumbers.clear(); state.elementSpanNumbers.clear(); state.ocrJobs.clear(); }
      $(side === 'element' ? 'elementName' : 'photoName').textContent = file.name;
      if (side === 'photo') await buildPhotoIndex();
      await renderSide(side);
      if (side === 'photo' && state.element.doc) {
        state.ocrHotspots.clear();
        await renderSide('element');
      }
      if (side === 'element') await preloadAllElementPages();
      $('globalStatus').textContent = side === 'photo'
        ? `損傷写真を索引化しました（${state.photoIndex.size}番号）`
        : state.missingDamageNumbers.length
          ? `全${target.doc.numPages}枚の認識完了。未認識番号が${state.missingDamageNumbers.length}件あります`
          : `全${target.doc.numPages}枚の読み込み・画像認識が完了しました（連番の欠落なし）`;
    } catch (error) {
      target.viewer.innerHTML = `<div class="empty">PDFを読み込めませんでした<br>${escapeHtml(String(error))}</div>`;
      $('globalStatus').textContent = 'PDF読み込みエラー';
    }
  }
  async function buildPhotoIndex() {
    state.photoIndex.clear();
    state.damageNumberDigits = 2;
    const doc = state.photo.doc;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      $('globalStatus').textContent = `損傷写真の索引を作成中 ${pageNumber} / ${doc.numPages}`;
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const strings = content.items.map(item => item.str || '');
      state.damageNumberDigits = Math.max(state.damageNumberDigits, detectDamageNumberDigits(strings.join('')));
      const viewport = page.getViewport({ scale: 1 });
      // The span number is a page-level field in inspection-photo ledgers,
      // outside the individual photo quadrants.
      const pageSpanNumber = spanNumberFromItems(content.items);
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
            entries.push({ page: pageNumber, focus, record: photoRecordFromItems(content.items, focus, pageNumber, number, pageSpanNumber) });
            state.photoIndex.set(number, entries);
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  async function loadAssessmentPdf(file) {
    $('assessmentName').textContent = `評価：${file.name}`;
    $('globalStatus').textContent = `${file.name} を読み込んでいます`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    state.assessmentDoc = await pdfjsLib.getDocument({ data: bytes, ...pdfOptions }).promise;
    state.assessmentIndex.clear();
    state.assessmentRows = [];
    for (let pageNumber = 1; pageNumber <= state.assessmentDoc.numPages; pageNumber++) {
      $('globalStatus').textContent = `損傷程度の評価を解析中 ${pageNumber} / ${state.assessmentDoc.numPages}`;
      const page = await state.assessmentDoc.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items;
      const viewport = page.getViewport({ scale: 1 });
      const annotations = await page.getAnnotations({ intent: 'display' }).catch(() => []);
      const formComments = annotations.map(annotation => {
        const name = cleanField(String(annotation.fieldName || annotation.titleObj?.str || annotation.title || ''));
        const raw = annotation.fieldValue ?? annotation.contentsObj?.str ?? annotation.contents ?? '';
        const text = cleanField(Array.isArray(raw) ? raw.join(' ') : String(raw));
        const rect = annotation.rect || [];
        return { name, text, rect, y: rect.length >= 4 ? (Number(rect[1]) + Number(rect[3])) / 2 : NaN };
      }).filter(annotation => annotation.text && (/コメント|備考|所見|comment/i.test(annotation.name) || (annotation.rect.length >= 4 && Math.min(annotation.rect[0], annotation.rect[2]) >= viewport.width * .62)));
      const spanNumber = fieldRightOf(items, /径間番号|径間/);
      const headerItem = items.find(item => /要素番号/.test(cleanField(item.str)));
      const diagnosisHeader = items.find(item => /健全性.*診断|診断結果|診断区分/.test(cleanField(item.str)));
      const commentHeader = items.find(item => /コメント|備考|所見/.test(cleanField(item.str)));
      const diagnosisStartX = diagnosisHeader ? Number(diagnosisHeader.transform?.[4] || 0) - 3 : NaN;
      const commentStartX = commentHeader ? Number(commentHeader.transform?.[4] || 0) - 3 : NaN;
      const headerY = Number(headerItem?.transform?.[5] || viewport.height * .70);
      const dataItems = items.filter(item => {
        const x = Number(item.transform?.[4] || 0), y = Number(item.transform?.[5] || 0);
        return cleanField(item.str) && x >= viewport.width * .055 && x <= viewport.width * .94 && y < headerY - 2 && y > viewport.height * .055;
      });
      const lines = [];
      for (const item of dataItems.sort((a, b) => Number(b.transform?.[5] || 0) - Number(a.transform?.[5] || 0))) {
        const y = Number(item.transform?.[5] || 0);
        let line = lines.find(candidate => Math.abs(candidate.y - y) <= 2.8);
        if (!line) { line = { y, items: [] }; lines.push(line); }
        line.items.push(item);
      }
      const boundaries = [.055, .121, .162, .202, .282, .377, .437, .526, .646, .94].map(ratio => viewport.width * ratio);
      const parsedLines = [];
      for (const line of lines) {
        const columns = Array.from({ length: 9 }, () => []);
        for (const item of line.items) {
          const x = Number(item.transform?.[4] || 0);
          const column = Number.isFinite(commentStartX) && x >= commentStartX ? 8
            : Number.isFinite(diagnosisStartX) && x >= diagnosisStartX ? 7
            : Math.max(0, Math.min(8, boundaries.findIndex((boundary, index) => index > 0 && x < boundary) - 1));
          columns[column].push(item);
        }
        const value = index => cleanField(columns[index].sort((a, b) => Number(a.transform?.[4] || 0) - Number(b.transform?.[4] || 0)).map(item => item.str).join(' '));
        parsedLines.push({ y: line.y, values: Array.from({ length: 9 }, (_, index) => value(index)) });
      }
      const logicalRows = [];
      let currentRow = null;
      const appendCell = (before, after) => cleanField([before, after].filter(Boolean).join(' '));
      for (const line of parsedLines) {
        const hasMemberNumber = /[0-9]/.test(line.values[2] || '');
        if (hasMemberNumber) {
          if (currentRow) logicalRows.push(currentRow);
          currentRow = { values: [...line.values], y: line.y };
        } else if (currentRow) {
          // PDF text extraction returns wrapped table cells as separate text
          // lines. Keep every continuation in its original column, especially
          // diagnosis (7) and comment (8), until the next member row begins.
          for (let index = 0; index < currentRow.values.length; index++) currentRow.values[index] = appendCell(currentRow.values[index], line.values[index]);
        }
      }
      if (currentRow) logicalRows.push(currentRow);
      // Comments entered into PDF form fields are not included in
      // getTextContent(). Attach those widget values to the table row whose
      // vertical range contains the field, or to the nearest row.
      for (const annotation of formComments) {
        if (!logicalRows.length) break;
        const containing = logicalRows.filter(row => annotation.rect.length >= 4 && row.y >= Math.min(annotation.rect[1], annotation.rect[3]) - 3 && row.y <= Math.max(annotation.rect[1], annotation.rect[3]) + 3);
        const target = (containing.length ? containing : logicalRows).reduce((best, row) => Math.abs(row.y - annotation.y) < Math.abs(best.y - annotation.y) ? row : best);
        target.values[8] = appendCell(target.values[8], annotation.text);
      }
      for (const logical of logicalRows) {
        const value = index => logical.values[index] || '';
        const diagnosisAndComment = value(7);
        const separated = diagnosisAndComment.match(/^\s*(IV|III|II|I|Ⅰ|Ⅱ|Ⅲ|Ⅳ|[1-4])\s*[|｜]?\s*(.*)$/i);
        const diagnosis = separated ? separated[1].toUpperCase() : (/損傷/.test(diagnosisAndComment) ? '' : diagnosisAndComment);
        const joinedComment = appendCell(separated ? separated[2] : (/損傷/.test(diagnosisAndComment) ? diagnosisAndComment : ''), value(8));
        const row = { spanNumber, memberName: value(0), memberSymbol: value(1), memberNumber: value(2), damageType: value(3), damagePattern: value(4), classification: value(5), damageLevel: value(6), diagnosis, comment: joinedComment, pageNumber, source: '損傷程度の評価' };
        if (!row.memberNumber || !/[0-9]/.test(row.memberNumber) || !row.damageType) continue;
        row.damageNumbers = [...new Set(damageNumbers(row.comment))];
        state.assessmentRows.push(row);
        for (const number of row.damageNumbers) {
          const entries = state.assessmentIndex.get(number) || [];
          entries.push({ ...row, damageNumber: number });
          state.assessmentIndex.set(number, entries);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    renderAssessmentList();
  }
  function assessmentFor(damageNumber, photoRecord) {
    const candidates = state.assessmentIndex.get(String(damageNumber)) || [];
    return candidates.find(item => item.spanNumber && item.spanNumber === photoRecord.spanNumber && (!item.memberNumber || !photoRecord.memberNumber || item.memberNumber === photoRecord.memberNumber))
      || candidates.find(item => !item.spanNumber || item.spanNumber === photoRecord.spanNumber)
      || candidates[0] || null;
  }
  function renderAssessmentList() {
    const body = $('assessmentListBody');
    if (!body) return;
    body.replaceChildren();
    $('assessmentListCount').textContent = `${state.assessmentRows.length}行`;
    if (!state.assessmentRows.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="10" class="damageListEmpty">損傷程度の評価PDFを読み込むと一覧が表示されます</td>';
      body.appendChild(tr); return;
    }
    for (const row of state.assessmentRows) {
      const tr = document.createElement('tr');
      const focusedNumbers = state.assessmentFocusNumbers || [];
      const numberMatches = (row.damageNumbers || []).some(number => focusedNumbers.includes(String(number)));
      const spanMatches = !state.assessmentFocusSpan || !row.spanNumber || String(row.spanNumber) === String(state.assessmentFocusSpan);
      tr.classList.toggle('assessmentMatched', numberMatches && spanMatches);
      for (const value of [row.spanNumber, row.memberName, row.memberSymbol, row.memberNumber, row.damageType, row.damagePattern, row.classification, row.damageLevel, row.diagnosis, row.comment]) {
        const td = document.createElement('td'); td.textContent = value || ''; tr.appendChild(td);
      }
      tr.addEventListener('click', async () => {
        const numbers = [...new Set(row.damageNumbers || [])];
        if (!numbers.length) {
          $('globalStatus').textContent = 'この評価行のコメントから損傷番号を確認できません';
          return;
        }
        state.assessmentFocusNumbers = numbers.map(String);
        state.assessmentFocusSpan = String(row.spanNumber || '');
        renderAssessmentList();
        await jumpToDamage(numbers, row.spanNumber || null);
      });
      body.appendChild(tr);
    }
  }
  function focusAssessmentRows(numbers, spanNumber = '') {
    state.assessmentFocusNumbers = [...new Set(numbers.map(number => String(Number(number))).filter(number => number !== 'NaN' && number !== '0'))];
    state.assessmentFocusSpan = String(spanNumber || '');
    const pane = $('assessmentListPane');
    if (pane.classList.contains('hiddenPanel')) return;
    renderAssessmentList();
    requestAnimationFrame(() => pane.querySelector('.assessmentMatched')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }
  function visibleElementDamageNumbers() {
    const result = new Set();
    document.querySelectorAll('#elementViewer .hotspot').forEach(hotspot => damageNumbers(hotspot.dataset.label || '').forEach(number => result.add(number)));
    if (state.currentDamage?.elementPage === state.element.page && state.currentDamage.damageNumber) result.add(String(state.currentDamage.damageNumber));
    return result;
  }
  let pendingDrawingRegistration = null;
  function closeDrawingRegistration() {
    pendingDrawingRegistration = null;
    $('drawingInfoDialog').classList.add('hiddenPanel');
  }
  function attachAssessmentToDrawing(item, row) {
    const visible = visibleElementDamageNumbers();
    const matches = (row.damageNumbers || []).filter(number => visible.has(number));
    const current = String(state.currentDamage?.damageNumber || '');
    const damageNumber = matches.includes(current) ? current : (matches[0] || row.damageNumbers?.[0] || current);
    const photoEntries = state.photoIndex.get(String(damageNumber)) || [];
    const sourceRecords = photoEntries.length ? photoEntries.map(entry => entry.record || {}) : [{}];
    item.damageInfo = {
      damageNumber: String(damageNumber || ''), elementPage: state.element.page,
      records: sourceRecords.map(source => ({ ...source,
        damageNumber: String(damageNumber || source.damageNumber || ''), spanNumber: row.spanNumber || source.spanNumber || '',
        memberName: row.memberName || source.memberName || '', memberSymbol: row.memberSymbol || source.memberSymbol || '',
        memberNumber: row.memberNumber || source.memberNumber || '', damageType: row.damageType || source.damageType || '',
        damagePattern: row.damagePattern || source.damagePattern || '', classification: row.classification || source.classification || '', damageLevel: row.damageLevel || source.damageLevel || '', diagnosis: row.diagnosis || source.diagnosis || '', memo: row.comment || source.memo || '', assessmentPage: row.pageNumber
      }))
    };
    closeDrawingRegistration();
    if (!$('damageListPane').classList.contains('hiddenPanel')) renderDamageList();
    $('globalStatus').textContent = `作図に損傷${String(damageNumber).padStart(2, '0')}の評価情報を登録しました`;
  }
  function showDrawingRegistration(item) {
    pendingDrawingRegistration = item;
    const visible = visibleElementDamageNumbers();
    const current = String(state.currentDamage?.damageNumber || '');
    const candidates = state.assessmentRows.filter(row => (row.damageNumbers || []).some(number => visible.has(number)))
      .sort((a, b) => Number(!(a.damageNumbers || []).includes(current)) - Number(!(b.damageNumbers || []).includes(current)) || Number(a.memberNumber) - Number(b.memberNumber));
    const list = $('drawingCandidateList'); list.replaceChildren();
    if (!candidates.length) {
      const empty = document.createElement('div'); empty.className = 'drawingCandidateEmpty';
      empty.textContent = state.assessmentRows.length ? 'このページの損傷番号に一致する評価データがありません' : '損傷程度の評価PDFが読み込まれていません';
      list.appendChild(empty);
    }
    for (const row of candidates) {
      const button = document.createElement('button'); button.className = 'drawingCandidate';
      const matching = (row.damageNumbers || []).filter(number => visible.has(number));
      button.innerHTML = `<strong>損傷${escapeHtml(matching.map(number => number.padStart(2, '0')).join('・'))}　${escapeHtml(row.memberName)} ${escapeHtml(row.memberSymbol)} ${escapeHtml(row.memberNumber)}</strong><span>${escapeHtml(row.damageType)}${row.damagePattern ? `　パターン ${escapeHtml(row.damagePattern)}` : ''}${row.classification ? `　分類 ${escapeHtml(row.classification)}` : ''}${row.damageLevel ? `　程度 ${escapeHtml(row.damageLevel)}` : ''}${row.diagnosis ? `　診断 ${escapeHtml(row.diagnosis)}` : ''}</span><small>${escapeHtml(row.comment)}</small>`;
      button.addEventListener('click', () => attachAssessmentToDrawing(item, row));
      list.appendChild(button);
    }
    $('drawingInfoDialog').classList.remove('hiddenPanel');
  }
  async function loadPastData(files) {
    const pdfs = [...files].filter(file => /\.pdf$/i.test(file.name));
    const element = pdfs.find(file => /部材.*要素.*番号図|要素番号図/.test(file.name));
    const assessment = pdfs.find(file => /損傷.*(?:程度|評価)/.test(file.name) && !/写真/.test(file.name));
    const photo = pdfs.find(file => /損傷.*写真/.test(file.name));
    const missing = [!element && '部材要素番号図', !assessment && '損傷程度の評価', !photo && '損傷写真'].filter(Boolean);
    if (missing.length) {
      $('globalStatus').textContent = `不足ファイル：${missing.join('・')}（3種類を同時に選択してください）`;
      return;
    }
    try {
      await loadPdf(photo, 'photo');
      await loadAssessmentPdf(assessment);
      await loadPdf(element, 'element');
      $('globalStatus').textContent = `過年度データ3種類を読み込みました（評価${state.assessmentIndex.size}番号）`;
    } catch (error) {
      $('globalStatus').textContent = `過年度データの読み込みに失敗しました：${error}`;
    }
  }
  async function renderSide(side) {
    const target = state[side];
    if (!target.doc) return;
    if (side === 'photo' && target.matches?.length) {
      if (target.pageOverview) await renderPhotoOverviewPages();
      else await renderPhotoMatches();
      return;
    }
    if (side === 'photo') target.viewer.classList.remove('matchedPhotos', 'zoomed');
    target.page = Math.max(1, Math.min(target.doc.numPages, target.page));
    const token = ++state.renderToken[side];
    const page = await target.doc.getPage(target.page);
    const base = page.getViewport({ scale: 1 });
    const crop = side === 'photo' && target.focus && !target.pageOverview
      ? photoRecordCrop(base, target.focus)
      : { x: 0, y: 0, width: base.width, height: base.height };
    const available = Math.max(320, target.viewer.clientWidth - 18);
    const availableHeight = Math.max(180, target.viewer.clientHeight - 18);
    const cssScale = (side === 'photo' && target.pageOverview
      ? Math.min(available / crop.width, availableHeight / crop.height)
      : available / crop.width) * target.zoom;
    const dpr = safeRenderDpr(crop.width, crop.height, cssScale);
    const viewport = page.getViewport({ scale: cssScale * dpr });
    const wrap = document.createElement('div');
    wrap.className = 'pageWrap';
    wrap.dataset.page = String(target.page);
    wrap.style.width = `${crop.width * cssScale}px`;
    wrap.style.height = `${crop.height * cssScale}px`;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(crop.width * cssScale * dpr);
    canvas.height = Math.ceil(crop.height * cssScale * dpr);
    wrap.appendChild(canvas);
    if (side === 'photo' && target.focus) {
      const factor = cssScale * dpr;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [1, 0, 0, 1, -crop.x * factor, -crop.y * factor] }).promise;
      const trimmed = trimCanvasWhitespace(canvas, dpr);
      wrap.style.width = `${trimmed.width}px`;
      wrap.style.height = `${trimmed.height}px`;
    } else {
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
    if (token !== state.renderToken[side]) return;
    // Keep the old page visible while the new canvas is rendered. Replacing
    // the DOM earlier temporarily resets scrolling to the top-left.
    target.viewer.replaceChildren(wrap);
    target.label.textContent = `${target.page} / ${target.doc.numPages}`;
    $(side + 'ZoomLabel').textContent = `${Math.round(target.zoom * 100)}%`;
      if (side === 'element') {
        addDrawingLayer(wrap, target.page);
        paintManualHotspots(target.page, wrap);
        // Hotspot/OCR work can be slow and must not delay cursor-anchored zoom.
        addDamageHotspots(page, wrap, cssScale, target.page).catch(error => {
          console.warn('damage hotspot detection failed', error);
        });
      } else addDrawingLayer(wrap, `page:${target.page}`, 'photo');
  }
  function captureElementView() {
    const viewer = $('elementViewer');
    const oldWrap = viewer.querySelector('.pageWrap');
    return oldWrap ? {
      page: state.element.page,
      x: (viewer.scrollLeft + viewer.clientWidth / 2 - oldWrap.offsetLeft) / Math.max(1, oldWrap.offsetWidth),
      y: (viewer.scrollTop + viewer.clientHeight / 2 - oldWrap.offsetTop) / Math.max(1, oldWrap.offsetHeight)
    } : null;
  }
  async function restoreElementView(anchor) {
    if (!anchor || anchor.page !== state.element.page) return;
    await new Promise(resolve => requestAnimationFrame(resolve));
    const viewer = $('elementViewer');
    const newWrap = viewer.querySelector('.pageWrap');
    if (!newWrap) return;
    viewer.scrollLeft = Math.max(0, newWrap.offsetLeft + newWrap.offsetWidth * anchor.x - viewer.clientWidth / 2);
    viewer.scrollTop = Math.max(0, newWrap.offsetTop + newWrap.offsetHeight * anchor.y - viewer.clientHeight / 2);
  }
  async function renderElementPreservingView() {
    const anchor = captureElementView();
    await renderSide('element');
    await restoreElementView(anchor);
  }
  function photoRecordCrop(base, focus) {
    // The upper record begins below the page-level bridge information table;
    // the lower record has no preceding header. Keep their bounds separate so
    // a header rule is not mistaken for part of the photo table.
    const topRatio = focus.row ? .55 : .275;
    const heightRatio = focus.row ? .315 : .295;
    return { x: focus.column * base.width / 2, y: base.height * topRatio, width: base.width / 2, height: base.height * heightRatio };
  }
  function trimCanvasWhitespace(canvas, dpr) {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const width = canvas.width, height = canvas.height;
    const pixels = context.getImageData(0, 0, width, height).data;
    const step = Math.max(1, Math.floor(Math.max(width, height) / 1400));
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const index = (y * width + x) * 4;
        if (pixels[index + 3] < 20 || (pixels[index] > 247 && pixels[index + 1] > 247 && pixels[index + 2] > 247)) continue;
        if (x < left) left = x; if (x > right) right = x;
        if (y < top) top = y; if (y > bottom) bottom = y;
      }
    }
    if (right < left || bottom < top) return { width: width / dpr, height: height / dpr };
    const padding = Math.ceil(2 * dpr);
    left = Math.max(0, left - padding); top = Math.max(0, top - padding);
    right = Math.min(width - 1, right + padding); bottom = Math.min(height - 1, bottom + padding);
    const cropWidth = right - left + 1, cropHeight = bottom - top + 1;
    const copy = document.createElement('canvas'); copy.width = cropWidth; copy.height = cropHeight;
    copy.getContext('2d').drawImage(canvas, left, top, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    canvas.width = cropWidth; canvas.height = cropHeight;
    canvas.getContext('2d').drawImage(copy, 0, 0);
    return { width: cropWidth / dpr, height: cropHeight / dpr, left: left / dpr, top: top / dpr };
  }
  async function renderPhotoMatches() {
    const target = state.photo;
    const token = ++state.renderToken.photo;
    // Use the pane width—not the viewer's scrollbar-dependent width—as the
    // persistent per-photo scale. Switching between one and multiple records
    // must change only the vertical window length.
    const horizontal = false;
    const available = Math.max(120, ($('photoPane').clientWidth - 20 - (horizontal ? 6 * (target.matches.length - 1) : 0)) / (horizontal ? target.matches.length : 1));
    const fragment = document.createDocumentFragment();
    const referencePage = await target.doc.getPage(target.matches[0].page);
    const referenceBase = referencePage.getViewport({ scale: 1 });
    const referenceCropWidth = referenceBase.width / 2;
    // The manually chosen pane width defines the photo scale. Do not reduce
    // that scale because the pane is currently short; its height is fitted to
    // the number of stacked records after rendering.
    const commonScale = available / referenceCropWidth * target.zoom;
    const dpr = safeRenderDpr(referenceCropWidth, referenceBase.height * .315, commonScale);
    for (const match of target.matches) {
      const page = await target.doc.getPage(match.page);
      const base = page.getViewport({ scale: 1 });
      const crop = photoRecordCrop(base, match.focus);
      const cssScale = commonScale;
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
      const trimmed = trimCanvasWhitespace(canvas, dpr);
      // Trimming the record removes PDF margins, but it also makes the result
      // narrower than the window and leaves grey bands on both sides. Scale
      // the trimmed record back to the full available width while preserving
      // its aspect ratio (and the user's current zoom).
      const fittedWidth = available * target.zoom;
      const fittedScale = fittedWidth / Math.max(1, trimmed.width);
      wrap.style.width = `${fittedWidth}px`;
      wrap.style.height = `${trimmed.height * fittedScale}px`;
      wrap.dataset.photoPage = String(match.page);
      wrap.dataset.photoViewX = String((crop.x + (trimmed.left || 0) / cssScale) / base.width * 1000);
      wrap.dataset.photoViewY = String((crop.y + (trimmed.top || 0) / cssScale) / base.height * 1000);
      wrap.dataset.photoViewWidth = String(trimmed.width / cssScale / base.width * 1000);
      wrap.dataset.photoViewHeight = String(trimmed.height / cssScale / base.height * 1000);
      addDrawingLayer(wrap, `record:${match.page}:${match.focus.column}:${match.focus.row}`, 'photo');
    }
    target.viewer.classList.add('matchedPhotos');
    target.viewer.classList.toggle('zoomed', target.zoom > 1.001);
    target.viewer.replaceChildren(fragment);
    target.label.textContent = `${target.matches.length}件`;
    $('photoZoomLabel').textContent = `${Math.round(target.zoom * 100)}%`;
    restoreVisibleAnnotationSelection('photo');
    target.keepPaneHeight = false;
    fitPhotoPaneHeightToMatches();
  }
  function fitPhotoPaneHeightToMatches() {
    const pane = $('photoPane'), viewer = $('photoViewer');
    if (pane.classList.contains('maximized') || pane.classList.contains('hiddenPanel') || state.photo.dockMode !== 'free') return;
    const wraps = [...viewer.querySelectorAll('.photoMatch')];
    if (!wraps.length) return;
    const horizontal = false;
    const contentHeight = (horizontal
      ? Math.max(...wraps.map(wrap => wrap.getBoundingClientRect().height))
      : wraps.reduce((sum, wrap) => sum + wrap.getBoundingClientRect().height, 0) + Math.max(0, wraps.length - 1) * 6) + 6;
    const chromeHeight = pane.getBoundingClientRect().height - viewer.getBoundingClientRect().height;
    const area = $('elementViewer').getBoundingClientRect();
    const desired = Math.max(280, Math.min(area.height - 12, Math.ceil(chromeHeight + contentHeight)));
    if (Math.abs(pane.getBoundingClientRect().height - desired) < 3) return;
    // Preserve the manually selected width. Only the vertical dimension is
    // fitted to the stacked photo records.
    pane.dataset.autoHeight = 'true';
    pane.style.height = `${desired}px`;
    if (state.photo.dockMode !== 'free') requestAnimationFrame(applyPhotoDockLayout);
  }
  async function renderPhotoOverviewPages() {
    const target = state.photo;
    const token = ++state.renderToken.photo;
    const pageNumbers = [...new Set(target.matches.map(match => match.page))].sort((a, b) => a - b);
    const pages = await Promise.all(pageNumbers.map(number => target.doc.getPage(number)));
    const bases = pages.map(page => page.getViewport({ scale: 1 }));
    const gap = 8, availableWidth = Math.max(120, target.viewer.clientWidth - 20);
    const availableHeight = Math.max(100, target.viewer.clientHeight - 16 - gap * Math.max(0, pages.length - 1));
    const widest = Math.max(...bases.map(base => base.width));
    const totalHeight = bases.reduce((sum, base) => sum + base.height, 0);
    const commonScale = Math.min(availableWidth / widest, availableHeight / totalHeight) * target.zoom;
    const dpr = safeRenderDpr(widest, Math.max(...bases.map(base => base.height)), commonScale);
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index], base = bases[index], factor = commonScale * dpr;
      const viewport = page.getViewport({ scale: factor });
      const wrap = document.createElement('div'); wrap.className = 'pageWrap photoMatch';
      wrap.style.width = `${base.width * commonScale}px`; wrap.style.height = `${base.height * commonScale}px`;
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      wrap.appendChild(canvas); fragment.appendChild(wrap);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      if (token !== state.renderToken.photo) return;
      addDrawingLayer(wrap, `overview:${pageNumbers[index]}`, 'photo');
    }
    target.viewer.classList.add('matchedPhotos');
    target.viewer.classList.toggle('zoomed', target.zoom > 1.001);
    target.viewer.replaceChildren(fragment);
    target.label.textContent = `${pageNumbers.length}ページ`;
    $('photoZoomLabel').textContent = `${Math.round(target.zoom * 100)}%`;
    restoreVisibleAnnotationSelection('photo');
  }
  function annotationList(pageNumber, side = 'element') {
    const store = side === 'photo' ? state.photoAnnotations : state.annotations;
    if (!store.has(pageNumber)) store.set(pageNumber, []);
    return store.get(pageNumber);
  }
  const annotationId = () => globalThis.crypto?.randomUUID?.() || `a${Date.now()}${Math.random().toString(16).slice(2)}`;
  function annotationCenter(item) {
    const points = item.points?.length ? item.points : [
      { x: item.x1 || 0, y: item.y1 || 0 },
      { x: Number.isFinite(item.x2) ? item.x2 : item.x1 || 0, y: Number.isFinite(item.y2) ? item.y2 : item.y1 || 0 }
    ];
    return { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length };
  }
  function translateAnnotation(item, dx, dy) {
    for (const suffix of ['1', '2', '3']) {
      if (Number.isFinite(item[`x${suffix}`])) item[`x${suffix}`] += dx;
      if (Number.isFinite(item[`y${suffix}`])) item[`y${suffix}`] += dy;
    }
    if (item.points) item.points = item.points.map(point => ({ x: point.x + dx, y: point.y + dy }));
  }
  function transformAnnotation(item, anchor, scaleX, scaleY, dx = 0, dy = 0) {
    for (const suffix of ['1', '2', '3']) {
      const xKey = `x${suffix}`, yKey = `y${suffix}`;
      if (Number.isFinite(item[xKey])) item[xKey] = anchor.x + (item[xKey] - anchor.x) * scaleX + dx;
      if (Number.isFinite(item[yKey])) item[yKey] = anchor.y + (item[yKey] - anchor.y) * scaleY + dy;
    }
    if (item.points) item.points = item.points.map(point => ({ x: anchor.x + (point.x - anchor.x) * scaleX + dx, y: anchor.y + (point.y - anchor.y) * scaleY + dy }));
    const sizeFactor = Math.sqrt(Math.max(.0025, Math.abs(scaleX * scaleY)));
    if (item.type === 'text' || item.type === 'boxedNumber' || item.type === 'leader') item.fontSize = Math.max(3, Math.min(96, (item.fontSize || 18) * sizeFactor));
    item.width = Math.max(.5, Math.min(20, (item.width || 3) * sizeFactor));
  }
  function scaleAnnotations(items, factor) {
    const centers = items.map(annotationCenter);
    const center = { x: centers.reduce((sum, p) => sum + p.x, 0) / centers.length, y: centers.reduce((sum, p) => sum + p.y, 0) / centers.length };
    for (const item of items) {
      for (const suffix of ['1', '2', '3']) {
        if (Number.isFinite(item[`x${suffix}`])) item[`x${suffix}`] = center.x + (item[`x${suffix}`] - center.x) * factor;
        if (Number.isFinite(item[`y${suffix}`])) item[`y${suffix}`] = center.y + (item[`y${suffix}`] - center.y) * factor;
      }
      if (item.points) item.points = item.points.map(point => ({ x: center.x + (point.x - center.x) * factor, y: center.y + (point.y - center.y) * factor }));
      if (item.type === 'text' || item.type === 'boxedNumber' || item.type === 'leader') item.fontSize = Math.max(8, Math.min(96, (item.fontSize || 18) * factor));
      item.width = Math.max(.75, Math.min(20, (item.width || 3) * factor));
    }
  }
  function removeMirroredPhotoAnnotation(key, id) {
    const match = String(key).match(/^record:(\d+):/); if (!match) return;
    const overview = annotationList(`overview:${match[1]}`, 'photo');
    for (let index = overview.length - 1; index >= 0; index--) {
      if (overview[index].sourceAnnotationId === id) overview.splice(index, 1);
    }
  }
  function showAnnotationMiniMenu(event, side, key, index, node, selections = null) {
    document.querySelectorAll('.selectedAnnotation').forEach(item => item.classList.remove('selectedAnnotation'));
    state.selectedAnnotation = { side, key, index, wrap: node.closest('.pageWrap'), selections: selections || [{ side, key, index, wrap: node.closest('.pageWrap') }] };
    const svg = node.ownerSVGElement;
    const selectedNodes = state.selectedAnnotation.selections.map(selection => svg.querySelector(`[data-annotation-index="${selection.index}"]`)).filter(Boolean);
    selectedNodes.forEach(item => item.classList.add('selectedAnnotation'));
    addSelectionControls(svg, selectedNodes, state.selectedAnnotation.selections);
    state.annotationCopyArmed = false;
    const menu = $('annotationMiniMenu'); menu.classList.remove('hiddenPanel');
    $('annotationSelectionCount').textContent = `${state.selectedAnnotation.selections.length}個`;
    const width = 300, height = 42;
    menu.style.left = `${Math.max(4, Math.min(innerWidth - width - 4, event.clientX + 32))}px`;
    menu.style.top = `${Math.max(4, Math.min(innerHeight - height - 4, event.clientY + 36))}px`;
  }
  function addSelectionControls(svg, selectedNodes, selections) {
    svg.querySelector('.selectionControls')?.remove();
    if (!selectedNodes.length) return;
    const boxes = selectedNodes.map(node => node.getBBox()), padding = 8;
    const bounds = { left: Math.min(...boxes.map(box => box.x)) - padding, top: Math.min(...boxes.map(box => box.y)) - padding, right: Math.max(...boxes.map(box => box.x + box.width)) + padding, bottom: Math.max(...boxes.map(box => box.y + box.height)) + padding };
    bounds.width = Math.max(1, bounds.right - bounds.left); bounds.height = Math.max(1, bounds.bottom - bounds.top);
    const controls = svgNode('g'); controls.classList.add('selectionControls');
    const box = svgNode('rect', { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height, class: 'selectionBox' }); controls.appendChild(box);
    const positions = { nw: [bounds.left, bounds.top], n: [(bounds.left + bounds.right) / 2, bounds.top], ne: [bounds.right, bounds.top], e: [bounds.right, (bounds.top + bounds.bottom) / 2], se: [bounds.right, bounds.bottom], s: [(bounds.left + bounds.right) / 2, bounds.bottom], sw: [bounds.left, bounds.bottom], w: [bounds.left, (bounds.top + bounds.bottom) / 2] };
    for (const [handle, [x, y]] of Object.entries(positions)) controls.appendChild(svgNode('circle', { cx: x, cy: y, r: 3.5, class: 'selectionHandle', 'data-handle': handle }));
    svg.appendChild(controls);
    const svgPoint = event => { const rect = svg.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width * 1000, y: (event.clientY - rect.top) / rect.height * 1000 }; };
    const beginTransform = event => {
      event.preventDefault(); event.stopPropagation();
      const handle = event.target.dataset.handle || 'move', start = svgPoint(event);
      const originals = selections.map(selection => { const item = annotationList(selection.key, selection.side)[selection.index]; return item ? JSON.parse(JSON.stringify(item)) : null; });
      const pointerId = event.pointerId; controls.setPointerCapture(pointerId);
      let current = { anchor: { x: 0, y: 0 }, sx: 1, sy: 1, dx: 0, dy: 0 };
      const calculate = pointer => {
        if (handle === 'move') return { anchor: { x: 0, y: 0 }, sx: 1, sy: 1, dx: pointer.x - start.x, dy: pointer.y - start.y };
        const west = handle.includes('w'), east = handle.includes('e'), north = handle.includes('n'), south = handle.includes('s');
        const anchor = { x: west ? bounds.right : bounds.left, y: north ? bounds.bottom : bounds.top }; let sx = 1, sy = 1;
        if (west) sx = Math.max(.05, (bounds.right - Math.min(pointer.x, bounds.right - 12)) / bounds.width);
        if (east) sx = Math.max(.05, (Math.max(pointer.x, bounds.left + 12) - bounds.left) / bounds.width);
        if (north) sy = Math.max(.05, (bounds.bottom - Math.min(pointer.y, bounds.bottom - 12)) / bounds.height);
        if (south) sy = Math.max(.05, (Math.max(pointer.y, bounds.top + 12) - bounds.top) / bounds.height);
        return { anchor, sx, sy, dx: 0, dy: 0 };
      };
      const transformText = value => `translate(${value.dx} ${value.dy}) translate(${value.anchor.x} ${value.anchor.y}) scale(${value.sx} ${value.sy}) translate(${-value.anchor.x} ${-value.anchor.y})`;
      const move = moveEvent => { if (moveEvent.pointerId !== pointerId) return; current = calculate(svgPoint(moveEvent)); selectedNodes.forEach(item => item.setAttribute('transform', transformText(current))); controls.setAttribute('transform', transformText(current)); moveEvent.preventDefault(); };
      const finish = upEvent => {
        if (upEvent.pointerId !== pointerId) return;
        controls.removeEventListener('pointermove', move); controls.removeEventListener('pointerup', finish); controls.removeEventListener('pointercancel', finish);
        selections.forEach((selection, selectionIndex) => {
          const item = annotationList(selection.key, selection.side)[selection.index], original = originals[selectionIndex]; if (!item || !original) return;
          removeMirroredPhotoAnnotation(selection.key, item.id); Object.keys(item).forEach(key => delete item[key]); Object.assign(item, original);
          transformAnnotation(item, current.anchor, current.sx, current.sy, current.dx, current.dy);
          if (selection.side === 'photo') mirrorPhotoRecordAnnotation(selection.wrap, selection.key, item);
        });
        $('annotationMiniMenu').classList.add('hiddenPanel'); state.selectedAnnotation = null; renderSide(selections[0].side);
        if (selections[0].side === 'element' && !$('damageListPane').classList.contains('hiddenPanel')) renderDamageList();
        $('globalStatus').textContent = `${selections.length}個の作図を${handle === 'move' ? '移動' : 'サイズ変更'}しました`;
        upEvent.preventDefault(); upEvent.stopPropagation();
      };
      controls.addEventListener('pointermove', move); controls.addEventListener('pointerup', finish); controls.addEventListener('pointercancel', finish);
    };
    box.addEventListener('pointerdown', beginTransform); controls.querySelectorAll('.selectionHandle').forEach(handle => handle.addEventListener('pointerdown', beginTransform));
  }
  function restoreVisibleAnnotationSelection(side) {
    const selected = state.selectedAnnotation;
    if (!selected || state.annotationCopyArmed || selected.side !== side) return;
    requestAnimationFrame(() => {
      if (state.selectedAnnotation !== selected) return;
      const allSelections = selected.selections || [selected];
      const svg = [...state[side].viewer.querySelectorAll('.annotationLayer')].find(layer =>
        layer.dataset.annotationSide === side && allSelections.some(selection => String(selection.key) === layer.dataset.annotationKey));
      if (!svg) return;
      const matching = allSelections.filter(selection => String(selection.key) === svg.dataset.annotationKey);
      const restored = matching.map(selection => ({ ...selection, wrap: svg.closest('.pageWrap') }));
      const nodes = restored.map(selection => svg.querySelector(`[data-annotation-index="${selection.index}"]`)).filter(Boolean);
      if (!nodes.length) return;
      selected.wrap = svg.closest('.pageWrap'); selected.selections = restored;
      nodes.forEach(node => node.classList.add('selectedAnnotation'));
      addSelectionControls(svg, nodes, restored);
    });
  }
  function mirrorPhotoRecordAnnotation(wrap, key, item) {
    if (!String(key).startsWith('record:') || !wrap.dataset.photoPage) return;
    const x = Number(wrap.dataset.photoViewX), y = Number(wrap.dataset.photoViewY);
    const width = Number(wrap.dataset.photoViewWidth), height = Number(wrap.dataset.photoViewHeight);
    if (![x, y, width, height].every(Number.isFinite)) return;
    const copy = { ...item, id: annotationId(), sourceRecordKey: key, sourceAnnotationId: item.id };
    const mapPoint = point => ({ x: x + point.x / 1000 * width, y: y + point.y / 1000 * height });
    for (const suffix of ['1', '2', '3']) {
      if (Number.isFinite(item[`x${suffix}`])) copy[`x${suffix}`] = x + item[`x${suffix}`] / 1000 * width;
      if (Number.isFinite(item[`y${suffix}`])) copy[`y${suffix}`] = y + item[`y${suffix}`] / 1000 * height;
    }
    if (item.points) copy.points = item.points.map(mapPoint);
    annotationList(`overview:${wrap.dataset.photoPage}`, 'photo').push(copy);
  }
  function svgNode(name, attributes = {}) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  }
  function drawAnnotation(svg, item, displayFontScale = 1) {
    let node;
    if (item.type === 'image') {
      node = svgNode('image', { x: Math.min(item.x1, item.x2), y: Math.min(item.y1, item.y2), width: Math.abs(item.x2 - item.x1), height: Math.abs(item.y2 - item.y1), href: item.imageData, preserveAspectRatio: 'xMidYMid meet' });
    } else if (item.type === 'boxedNumber') {
      const fontSize = (item.fontSize || 18) * displayFontScale;
      const width = Math.max(fontSize * 1.8, String(item.text || '').length * fontSize * .72 + fontSize);
      const height = fontSize * 1.65;
      node = svgNode('g');
      node.appendChild(svgNode('rect', { x: item.x1 - width / 2, y: item.y1 - height / 2, width, height, rx: 2 }));
      const label = svgNode('text', { x: item.x1, y: item.y1 + fontSize * .34, 'text-anchor': 'middle' });
      label.textContent = item.text; label.style.fill = item.color || '#e53935'; label.style.fontSize = `${fontSize}px`;
      node.appendChild(label);
    } else if (item.type === 'rect') {
      node = svgNode('rect', { x: Math.min(item.x1, item.x2), y: Math.min(item.y1, item.y2), width: Math.abs(item.x2 - item.x1), height: Math.abs(item.y2 - item.y1) });
    } else if (item.type === 'ellipse') {
      node = svgNode('ellipse', { cx: (item.x1 + item.x2) / 2, cy: (item.y1 + item.y2) / 2, rx: Math.abs(item.x2 - item.x1) / 2, ry: Math.abs(item.y2 - item.y1) / 2 });
    } else if (item.type === 'text') {
      node = svgNode('text', { x: item.x1, y: item.y1 });
      node.textContent = item.text;
    } else if (item.type === 'free') {
      node = svgNode('path', { d: (item.points || []).map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ') });
    } else if (item.type === 'leader') {
      const tail = item.x3 ?? (item.x2 + (item.x2 >= item.x1 ? 120 : -120));
      node = svgNode('polyline', { points: `${item.x1},${item.y1} ${item.x2},${item.y2} ${tail},${item.y2}`, 'marker-start': 'url(#inspectionArrow)' });
      if (item.text) {
        const label = svgNode('text', { x: Math.min(item.x2, tail), y: item.y2 - 8 });
        label.textContent = item.text;
        label.style.fill = item.color || '#e53935';
        label.style.fontSize = `${(item.fontSize || 18) * displayFontScale}px`;
        svg.appendChild(label);
      }
    } else {
      node = svgNode('line', { x1: item.x1, y1: item.y1, x2: item.x2, y2: item.y2 });
      if (item.type === 'arrow') node.setAttribute('marker-end', 'url(#inspectionArrow)');
    }
    const color = item.color || '#e53935';
    node.style.stroke = color;
    node.style.strokeWidth = String(item.width || 3);
    if (item.dash) node.style.strokeDasharray = item.dash;
    if (item.type === 'text') { node.style.fill = color; node.style.fontSize = `${(item.fontSize || 18) * displayFontScale}px`; }
    svg.appendChild(node);
    return node;
  }
  function addDrawingLayer(wrap, pageNumber, side = 'element') {
    const svg = svgNode('svg', { viewBox: '0 0 1000 1000', preserveAspectRatio: 'none' });
    svg.classList.add('annotationLayer');
    svg.dataset.annotationKey = String(pageNumber); svg.dataset.annotationSide = side;
    if (!['select', 'pan'].includes(state.drawMode) && state.drawingSide === side) svg.classList.add('drawing');
    if (state.drawMode === 'select' && state.drawingSide === side && !$('commonDrawTools').classList.contains('hiddenPanel')) svg.classList.add('selecting');
    const defs = svgNode('defs');
    const marker = svgNode('marker', { id: 'inspectionArrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' });
    marker.appendChild(svgNode('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'context-stroke', stroke: 'none' }));
    defs.appendChild(marker); svg.appendChild(defs);
    annotationList(pageNumber, side).forEach((item, index) => {
      // Photo-number callouts need to remain legible over full-resolution
      // inspection photographs. Apply this once to existing saved drawings as
      // well as newly-created ones, without changing ordinary text or the
      // element-diagram side.
      if (side === 'photo' && item.type === 'boxedNumber' && item.photoNumberScaleApplied !== 9) {
        // v356 already enlarged some photo numbers to 3x. The requested size
        // is now three times that visible size, i.e. 9x the common drawing
        // default. Migrate both old and previously-enlarged annotations once.
        const appliedScale = item.photoNumberScaleApplied || (item.photoNumberTripleSize ? 3 : 1);
        item.fontSize = Math.min(144, (item.fontSize || Number($('drawFontSize').value) || 4.5) * (9 / appliedScale));
        item.photoNumberTripleSize = true;
        item.photoNumberScaleApplied = 9;
      }
      item.id ||= annotationId();
      const node = drawAnnotation(svg, item, side === 'photo' ? 1 / Math.max(.05, state.photo.zoom) : 1);
      node.classList.add('selectableAnnotation');
      node.dataset.annotationIndex = String(index);
      node.addEventListener('click', event => {
        if (state.drawMode !== 'select' || state.drawingSide !== side) return;
        event.stopPropagation(); showAnnotationMiniMenu(event, side, pageNumber, index, node);
      });
    });
    let start = null;
    let preview = null;
    let freePoints = null;
    let rangeSelecting = false;
    const drawingStyle = () => ({ color: $('drawColor').value, width: Number($('drawWidth').value), fontSize: Number($('drawFontSize').value), dash: $('drawDash').value });
    const point = event => {
      const rect = svg.getBoundingClientRect();
      return { x: (event.clientX - rect.left) / rect.width * 1000, y: (event.clientY - rect.top) / rect.height * 1000 };
    };
    svg.addEventListener('pointerdown', async event => {
      if (state.drawMode === 'select') {
        const selected = state.selectedAnnotation;
        if (state.annotationCopyArmed && selected?.side === side) {
          const selections = selected.selections || [selected];
          const sourceItems = selections.map(selection => annotationList(selection.key, selection.side)[selection.index]).filter(Boolean);
          if (sourceItems.length) {
            const destination = point(event);
            const centers = sourceItems.map(annotationCenter);
            const center = { x: centers.reduce((sum, p) => sum + p.x, 0) / centers.length, y: centers.reduce((sum, p) => sum + p.y, 0) / centers.length };
            const targetItems = annotationList(pageNumber, side);
            for (const source of sourceItems) {
              const copy = JSON.parse(JSON.stringify(source)); copy.id = annotationId();
              translateAnnotation(copy, destination.x - center.x, destination.y - center.y);
              targetItems.push(copy);
              if (side === 'photo') mirrorPhotoRecordAnnotation(wrap, pageNumber, copy);
            }
            state.annotationCopyArmed = false; state.selectedAnnotation = null;
            $('annotationMiniMenu').classList.add('hiddenPanel'); renderSide(side);
            $('globalStatus').textContent = `${sourceItems.length}個の作図を指定位置へコピーしました`;
            event.preventDefault();
          }
        } else if (!event.target.closest('.selectableAnnotation') && state.drawingSide === side) {
          start = point(event); rangeSelecting = true;
          preview = svgNode('rect', { x: start.x, y: start.y, width: 0, height: 0 });
          preview.classList.add('selectionMarquee'); svg.appendChild(preview);
          svg.setPointerCapture(event.pointerId); event.preventDefault();
        }
        return;
      }
      if (state.drawingSide !== side) return;
      if (side === 'photo') state.activePhotoAnnotationKey = pageNumber;
      const p = point(event);
      if (state.drawMode === 'boxedNumber') {
        event.preventDefault();
        const value = await requestBoxedNumber();
        if (value) {
          const style = drawingStyle();
          // On photographs, commit the 300% font size at creation time. This
          // avoids depending on a later redraw to enlarge the number.
          if (side === 'photo') style.fontSize *= 9;
          const item = { id: annotationId(), type: 'boxedNumber', x1: p.x, y1: p.y, text: value, ...style, photoNumberTripleSize: side === 'photo', photoNumberScaleApplied: side === 'photo' ? 9 : undefined, damageInfo: annotationMetadata() };
          annotationList(pageNumber, side).push(item);
          if (side === 'photo') mirrorPhotoRecordAnnotation(wrap, pageNumber, item);
          renderSide(side);
          if (side === 'element' && !$('damageListPane').classList.contains('hiddenPanel')) renderDamageList();
          if (side === 'element') showDrawingRegistration(item);
        }
        return;
      }
      if (state.drawMode === 'text') {
        const value = prompt('文字を入力してください', '');
        if (value) {
          const item = { id: annotationId(), type: 'text', x1: p.x, y1: p.y, text: value, ...drawingStyle(), damageInfo: annotationMetadata() };
          annotationList(pageNumber, side).push(item);
          if (side === 'photo') mirrorPhotoRecordAnnotation(wrap, pageNumber, item);
          renderSide(side);
          if (side === 'element' && !$('damageListPane').classList.contains('hiddenPanel')) renderDamageList();
          if (side === 'element') showDrawingRegistration(item);
        }
        return;
      }
      start = p;
      freePoints = state.drawMode === 'free' ? [p] : null;
      const previewType = ['screenCopy', 'image'].includes(state.drawMode) ? 'rect' : state.drawMode;
      preview = drawAnnotation(svg, { type: previewType, x1: p.x, y1: p.y, x2: p.x, y2: p.y, points: freePoints, ...drawingStyle() }, side === 'photo' ? 1 / Math.max(.05, state.photo.zoom) : 1);
      svg.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    svg.addEventListener('pointermove', event => {
      if (!start || !preview) return;
      const p = point(event);
      if (rangeSelecting) {
        preview.setAttribute('x', Math.min(start.x, p.x)); preview.setAttribute('y', Math.min(start.y, p.y));
        preview.setAttribute('width', Math.abs(p.x - start.x)); preview.setAttribute('height', Math.abs(p.y - start.y));
      } else if (state.drawMode === 'free') {
        freePoints.push(p);
        preview.setAttribute('d', freePoints.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '));
      } else if (state.drawMode === 'leader') {
        const tail = p.x + (p.x >= start.x ? 120 : -120);
        preview.setAttribute('points', `${start.x},${start.y} ${p.x},${p.y} ${tail},${p.y}`);
      } else if (state.drawMode === 'rect' || state.drawMode === 'screenCopy' || state.drawMode === 'image') {
        preview.setAttribute('x', Math.min(start.x, p.x)); preview.setAttribute('y', Math.min(start.y, p.y));
        preview.setAttribute('width', Math.abs(p.x - start.x)); preview.setAttribute('height', Math.abs(p.y - start.y));
      } else if (state.drawMode === 'ellipse') {
        // Same two-corner bounding-box operation as CAD野帳: press at one
        // corner and drag to the opposite corner.
        preview.setAttribute('cx', (start.x + p.x) / 2); preview.setAttribute('cy', (start.y + p.y) / 2);
        preview.setAttribute('rx', Math.abs(p.x - start.x) / 2); preview.setAttribute('ry', Math.abs(p.y - start.y) / 2);
      } else { preview.setAttribute('x2', p.x); preview.setAttribute('y2', p.y); }
      event.preventDefault();
    });
    svg.addEventListener('pointerup', event => {
      if (!start) return;
      const p = point(event);
      if (rangeSelecting) {
        const left = Math.min(start.x, p.x), right = Math.max(start.x, p.x), top = Math.min(start.y, p.y), bottom = Math.max(start.y, p.y);
        const chosen = [...svg.querySelectorAll('.selectableAnnotation')].filter(node => {
          const box = node.getBBox(); return box.x + box.width >= left && box.x <= right && box.y + box.height >= top && box.y <= bottom;
        });
        preview.remove(); start = null; preview = null; rangeSelecting = false;
        if (chosen.length) {
          const selections = chosen.map(node => ({ side, key: pageNumber, index: Number(node.dataset.annotationIndex), wrap }));
          showAnnotationMiniMenu(event, side, pageNumber, selections[0].index, chosen[0], selections);
        }
        return;
      }
      const item = { id: annotationId(), type: state.drawMode, x1: start.x, y1: start.y, x2: p.x, y2: p.y, ...drawingStyle(), damageInfo: annotationMetadata() };
      if (state.drawMode === 'free') item.points = freePoints?.length > 1 ? freePoints : [start, p];
      if (state.drawMode === 'leader') {
        item.x3 = p.x + (p.x >= start.x ? 120 : -120);
        // Keep the tip at pointer-down, use pointer-up as the corner and add
        // the horizontal shelf in one gesture. Damage information is filled
        // automatically; free text remains available through the text tool.
        item.text = automaticLeaderText();
      }
      if (state.drawMode === 'screenCopy' && side === 'element') {
        start = null; preview?.remove(); preview = null; freePoints = null;
        copyElementScreenArea(wrap, item.x1, item.y1, item.x2, item.y2);
        return;
      }
      if (state.drawMode === 'image') item.imageData = state.pendingImage;
      annotationList(pageNumber, side).push(item);
      if (side === 'photo') mirrorPhotoRecordAnnotation(wrap, pageNumber, item);
      start = null; preview = null; freePoints = null;
      renderSide(side);
      if (side === 'element' && !$('damageListPane').classList.contains('hiddenPanel')) renderDamageList();
      if (side === 'element') showDrawingRegistration(item);
    });
    wrap.appendChild(svg);
    // Zooming redraws the PDF and replaces its SVG layer. Restore the active
    // selection on the new layer instead of making the user select it again.
    const selected = state.selectedAnnotation;
    if (selected && !state.annotationCopyArmed && selected.side === side) {
      const matching = (selected.selections || [selected]).filter(selection => String(selection.key) === String(pageNumber));
      if (matching.length) requestAnimationFrame(() => {
        if (state.selectedAnnotation !== selected || !svg.isConnected) return;
        const restored = matching.map(selection => ({ ...selection, wrap }));
        const nodes = restored.map(selection => svg.querySelector(`[data-annotation-index="${selection.index}"]`)).filter(Boolean);
        if (!nodes.length) return;
        selected.wrap = wrap; selected.selections = restored;
        nodes.forEach(node => node.classList.add('selectedAnnotation'));
        addSelectionControls(svg, nodes, restored);
      });
    }
  }
  async function addDamageHotspots(page, wrap, cssScale, pageNumber = state.element.page) {
    const content = await page.getTextContent();
    state.elementSpanNumbers.set(pageNumber, spanNumberFromItems(content.items));
    const items = content.items;
    const baseViewport = page.getViewport({ scale: cssScale });
    const found = new Set();
    const pageNumbers = new Set();
    for (let i = 0; i < items.length; i++) {
      const windowItems = items.slice(i, i + 8);
      const ownNumbers = damageNumbers(items[i].str || '');
      // Do not assign a complete label found later in the look-ahead window
      // to the current item's coordinates. Joining is only for labels that
      // are genuinely split across separate PDF text items.
      if (!ownNumbers.length && windowItems.some(item => damageNumbers(item.str || '').length)) continue;
      const numbers = [...new Set(ownNumbers.length
        ? ownNumbers
        : damageNumbers(windowItems.map(item => item.str || '').join('')))];
      for (const number of numbers) {
        if (numbers.length > 1 && number !== numbers[0]) continue;
        const key = `${number}:${i}`;
        if (found.has(key)) continue;
        found.add(key);
        pageNumbers.add(number);
        const anchorOffset = ownNumbers.length ? 0 : windowItems.findIndex(item => {
          const text = normalizeDigits(String(item.str || '')).replace(/[\s　]/g, '');
          return damageNumbers(text).includes(number) || text.includes(formatDamageNumber(number));
        });
        if (anchorOffset < 0) continue;
        const anchor = items[i + anchorOffset] || items[i];
        const transform = pdfjsLib.Util.transform(baseViewport.transform, anchor.transform);
        const fontHeight = Math.max(12, Math.hypot(transform[2], transform[3]));
        const anchorText = normalizeDigits(String(anchor.str || ''));
        const labelIndex = anchorText.indexOf('損傷');
        const labelLength = Math.min(anchorText.length - Math.max(0, labelIndex), `損傷${formatDamageNumber(number)}`.length + 2);
        const textLength = Math.max(1, anchorText.length);
        const labelOffset = labelIndex > 0 ? (anchor.width || 0) * labelIndex / textLength * cssScale : 0;
        const button = document.createElement('button');
        button.className = 'hotspot';
        button.dataset.label = numbers.map(value => `損傷${formatDamageNumber(value)}`).join('・');
        button.dataset.numbers = numbers.join(',');
        if (numbers.length > 1) button.dataset.grouped = 'true';
        button.title = `${button.dataset.label} の写真を縦並び表示`;
        const compactDisplay = wrap.clientWidth < 520;
        const measuredVisualWidth = labelIndex >= 0 ? (anchor.width || 28) * labelLength / textLength * cssScale : (anchor.width || 28) * cssScale;
        const visualWidth = compactDisplay ? Math.max(12, measuredVisualWidth) : Math.max(20, measuredVisualWidth);
        const visualHeight = compactDisplay ? Math.max(6, fontHeight) : Math.max(10, fontHeight);
        const tapWidth = Math.max(32, visualWidth + 8);
        const tapHeight = Math.max(24, visualHeight + 8);
        // PDF text coordinates point to the baseline. Keep the generous tap
        // target, but centre the visible outline on the actual glyph box.
        button.style.left = `${transform[4] + labelOffset - (tapWidth - visualWidth) / 2}px`;
        button.style.top = `${transform[5] - visualHeight - (tapHeight - visualHeight) / 2}px`;
        button.style.width = `${tapWidth}px`;
        button.style.height = `${tapHeight}px`;
        const outline = document.createElement('span');
        outline.className = 'hotspot-outline';
        outline.style.width = `${visualWidth}px`;
        outline.style.height = `${visualHeight}px`;
        button.appendChild(outline);
        if (!enableHotspotDrag(button, wrap, `text:${number}:${i}`)) continue;
        button.addEventListener('click', event => activateHotspotAtPointer(event, button));
        wrap.appendChild(button);
      }
    }
    state.textDamageNumbers.set(pageNumber, pageNumbers);
    if (state.ocrHotspots.has(pageNumber)) {
      paintCachedOcrHotspots(pageNumber, wrap);
    } else if (found.size === 0) {
      await addOcrDamageHotspots(page, wrap, pageNumber);
    } else {
      $('globalStatus').textContent = `${found.size}件の損傷番号を認識しました`;
    }
    // Text hotspots are rendered asynchronously after the page appears.
    // Rebuild the missing-number list now so already visible orange frames do
    // not remain incorrectly listed as unrecognized.
    if (!state.ocrProgress) auditRecognizedDamageNumbers();
  }
  async function ensureOcrWorker() {
    if (state.ocrWorker) return state.ocrWorker;
    $('globalStatus').textContent = '図形化された損傷番号の画像認識を準備中…';
    if (!window.Tesseract?.createWorker) throw new Error('OCRライブラリを読み込めませんでした');
    const baseUrl = new URL('../tesseract/', location.href);
    try {
      // Use the JavaScript WASM loader and a direct worker URL. Edge can reject
      // a blob worker that imports a raw .wasm URL even though Chromium-based
      // browsers sometimes allow the same configuration to proceed.
      const worker = await Tesseract.createWorker('jpn', 1, {
        workerPath: new URL('worker.min.js', baseUrl).href,
        langPath: new URL('lang/', baseUrl).href,
        corePath: new URL('tesseract-core-lstm.wasm.js', baseUrl).href,
        workerBlobURL: false,
        errorHandler: error => console.error('OCR worker error', error),
        logger: message => {
          if (message.status === 'recognizing text') {
            const progress = state.ocrProgress;
            $('globalStatus').textContent = progress
              ? `全${progress.total}枚中 ${progress.page}枚を画像認識中 ${Math.round((message.progress || 0) * 100)}%`
              : `損傷番号を画像認識中 ${Math.round((message.progress || 0) * 100)}%`;
          }
        }
      });
      await worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
        user_defined_dpi: '220'
      });
      state.ocrWorker = worker;
      return worker;
    } catch (error) {
      state.ocrWorker = null;
      throw error;
    }
  }
  function showDamageChoice(numbers, anchor) {
    document.querySelector('.damage-choice')?.remove();
    const chooser = document.createElement('div');
    chooser.className = 'damage-choice';
    for (const number of numbers) {
      const option = document.createElement('button');
      option.textContent = `損傷${formatDamageNumber(number)}`;
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
  function closeHotspotEditor() {
    state.editingHotspot?.classList.remove('editTarget');
    state.editingHotspot = null;
    $('hotspotEditor').classList.add('hiddenPanel');
  }
  function openHotspotEditor(hotspot) {
    state.editingHotspot?.classList.remove('editTarget');
    state.editingHotspot = hotspot; hotspot.classList.add('editTarget');
    $('hotspotNumberInput').value = (hotspot.dataset.numbers || '').split(',').filter(Boolean).map(number => String(number).padStart(2, '0')).join(',');
    $('hotspotEditor').classList.remove('hiddenPanel');
    $('hotspotNumberInput').focus(); $('hotspotNumberInput').select();
  }
  function hotspotEditorNumbers() {
    return [...new Set((normalizeDigits($('hotspotNumberInput').value).match(/\d+/g) || [])
      .map(value => String(Number(value))).filter(value => value !== 'NaN'))];
  }
  async function saveHotspotNumberEdit() {
    const hotspot = state.editingHotspot, numbers = hotspotEditorNumbers();
    if (!hotspot || !numbers.length) { $('globalStatus').textContent = '損傷番号を入力してください'; return; }
    const key = hotspot.dataset.overrideKey; if (!key) return;
    state.hotspotOverrides.set(key, { ...(state.hotspotOverrides.get(key) || {}), numbers, deleted: false });
    closeHotspotEditor(); await renderSide('element'); auditRecognizedDamageNumbers();
    $('globalStatus').textContent = `${numbers.map(number => `損傷${formatDamageNumber(number)}`).join('・')}に修正しました`;
  }
  async function deleteEditedHotspot() {
    const hotspot = state.editingHotspot; if (!hotspot) return;
    const label = hotspot.dataset.label || 'この損傷番号';
    if (!window.confirm(`${label}のオレンジ枠を削除しますか？`)) return;
    const key = hotspot.dataset.overrideKey; if (!key) return;
    state.hotspotOverrides.set(key, { ...(state.hotspotOverrides.get(key) || {}), deleted: true });
    closeHotspotEditor(); await renderSide('element'); auditRecognizedDamageNumbers();
    $('globalStatus').textContent = `${label}のオレンジ枠を削除しました`;
  }
  function activateHotspotAtPointer(event, anchor) {
    // During manual missing-number placement, let the click bubble to the
    // viewer so it can offer merging with this existing hotspot.
    if (state.pendingManualDamage) return;
    event.stopPropagation();
    if (anchor.dataset.justDragged === 'true') { anchor.dataset.justDragged = 'false'; return; }
    if (state.hotspotEditMode) { openHotspotEditor(anchor); return; }
    const groupedNumbers = (anchor.dataset.numbers || '').split(',').filter(Boolean);
    if (anchor.dataset.grouped === 'true' && groupedNumbers.length > 1) {
      jumpToDamage(groupedNumbers);
      return;
    }
    const candidates = [...anchor.parentElement.querySelectorAll('.hotspot')].filter(item => {
      const rect = item.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    }).map(item => {
      const outline = item.querySelector('.hotspot-outline')?.getBoundingClientRect() || item.getBoundingClientRect();
      return { item, distance: Math.hypot(event.clientX - (outline.left + outline.width / 2), event.clientY - (outline.top + outline.height / 2)) };
    }).sort((a, b) => a.distance - b.distance);
    const nearestDistance = candidates[0]?.distance ?? 0;
    const close = candidates.filter(candidate => candidate.distance <= nearestDistance + 5);
    const numbers = [...new Set(close.flatMap(candidate => damageNumbers(candidate.item.dataset.label || '')))];
    if (numbers.length > 1) showDamageChoice(numbers, candidates[0].item);
    else if (numbers.length === 1) jumpToDamage(numbers[0]);
  }
  function enableHotspotDrag(button, wrap, localKey) {
    const key = `${wrap.dataset.page || state.element.page}:${localKey}`;
    button.dataset.overrideKey = key;
    const saved = state.hotspotOverrides.get(key);
    if (saved?.deleted) return false;
    if (saved) {
      if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      button.style.left = `${saved.left * wrap.clientWidth}px`;
      button.style.top = `${saved.top * wrap.clientHeight}px`;
      }
      if (saved.numbers?.length) {
        button.dataset.numbers = saved.numbers.join(',');
        button.dataset.label = saved.numbers.map(number => `損傷${formatDamageNumber(number)}`).join('・');
        button.dataset.grouped = saved.numbers.length > 1 ? 'true' : 'false';
      }
    }
    let drag = null;
    button.addEventListener('pointerdown', event => {
      drag = { x: event.clientX, y: event.clientY, left: button.offsetLeft, top: button.offsetTop, moved: false };
      button.setPointerCapture(event.pointerId); event.stopPropagation();
    });
    button.addEventListener('pointermove', event => {
      if (!drag) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true; button.classList.add('dragging');
      button.style.left = `${Math.max(0, Math.min(wrap.clientWidth - button.offsetWidth, drag.left + dx))}px`;
      button.style.top = `${Math.max(0, Math.min(wrap.clientHeight - button.offsetHeight, drag.top + dy))}px`;
      event.preventDefault(); event.stopPropagation();
    });
    const finish = event => {
      if (!drag) return;
      if (drag.moved) {
        state.hotspotOverrides.set(key, { ...(state.hotspotOverrides.get(key) || {}), left: button.offsetLeft / wrap.clientWidth, top: button.offsetTop / wrap.clientHeight });
        button.dataset.justDragged = 'true';
        $('globalStatus').textContent = `${button.dataset.label}の枠位置を調整しました`;
      }
      button.classList.remove('dragging'); drag = null; event.stopPropagation();
    };
    button.addEventListener('pointerup', finish); button.addEventListener('pointercancel', finish);
    return true;
  }
  function addHotspot(wrap, numberOrNumbers, box, sourceWidth, sourceHeight, isManual = false) {
    const numbers = Array.isArray(numberOrNumbers) ? numberOrNumbers : [numberOrNumbers];
    const button = document.createElement('button');
    button.className = 'hotspot';
    button.dataset.label = numbers.map(number => `損傷${formatDamageNumber(number)}`).join('・');
    button.dataset.numbers = numbers.join(',');
    if (numbers.length > 1) button.dataset.grouped = 'true';
    button.title = numbers.length > 1 ? `${button.dataset.label} から選択` : `${button.dataset.label} の写真を表示`;
    // OCR sometimes returns the whole annotation line. Derive the visible width
    // from the character height so the outline covers only "損傷00", while the
    // invisible button remains large enough to tap comfortably.
    const measuredHeight = box.height * wrap.clientHeight / sourceHeight;
    const compactDisplay = wrap.clientWidth < 520;
    const visualHeight = compactDisplay ? Math.min(12, Math.max(6, measuredHeight)) : Math.min(18, Math.max(12, measuredHeight));
    const visualWidth = numbers.length > 1
      ? (compactDisplay ? Math.min(58, Math.max(24, visualHeight * (2.7 + 1.35 * (numbers.length - 1)))) : Math.min(96, Math.max(48, visualHeight * (2.7 + 1.35 * (numbers.length - 1)))))
      : (compactDisplay ? Math.min(30, Math.max(14, visualHeight * 2.7)) : Math.min(48, Math.max(30, visualHeight * 2.7)));
    const tapWidth = Math.max(32, visualWidth + 6);
    const tapHeight = Math.max(24, visualHeight + 5);
    const displayLeft = box.left * wrap.clientWidth / sourceWidth;
    const displayWidth = box.width * wrap.clientWidth / sourceWidth;
    // OCR often returns "損傷03 ...説明文..." as one long word. In that
    // case the damage label is at the beginning, not at the word centre.
    const centerX = displayWidth > visualWidth * 1.7
      ? displayLeft + visualWidth / 2
      : displayLeft + displayWidth / 2;
    const centerY = (box.top + box.height / 2) * wrap.clientHeight / sourceHeight;
    if (!isManual) {
      const pageNumber = Number(wrap.dataset.page || state.element.page);
      const mergedHere = (state.manualHotspots.get(pageNumber) || []).some(item => {
        const mergedNumbers = item.numbers || [item.number];
        return mergedNumbers.some(number => numbers.includes(String(number))) &&
          Math.hypot(item.x / 1000 * wrap.clientWidth - centerX, item.y / 1000 * wrap.clientHeight - centerY) < 40;
      });
      if (mergedHere) return;
    }
    const label = numbers.map(number => `損傷${formatDamageNumber(number)}`).join('・');
    const duplicate = [...wrap.querySelectorAll('.hotspot')].some(existing => {
      if (existing.dataset.label !== label) return false;
      const existingCenterX = existing.offsetLeft + existing.offsetWidth / 2;
      const existingCenterY = existing.offsetTop + existing.offsetHeight / 2;
      return Math.hypot(existingCenterX - centerX, existingCenterY - centerY) < 24;
    });
    if (duplicate) return;
    button.style.left = `${centerX - tapWidth / 2}px`;
    button.style.top = `${centerY - tapHeight / 2}px`;
    button.style.width = `${tapWidth}px`;
    button.style.height = `${tapHeight}px`;
    const outline = document.createElement('span');
    outline.className = 'hotspot-outline';
    outline.style.width = `${visualWidth}px`;
    outline.style.height = `${visualHeight}px`;
    button.appendChild(outline);
    const sourceCenterX = Math.round((box.left + box.width / 2) / sourceWidth * 1000);
    const sourceCenterY = Math.round((box.top + box.height / 2) / sourceHeight * 1000);
    if (!enableHotspotDrag(button, wrap, `detected:${label}:${sourceCenterX}:${sourceCenterY}`)) return;
    button.addEventListener('click', event => activateHotspotAtPointer(event, button));
    wrap.appendChild(button);
  }
  async function addOcrDamageHotspots(page, wrap, pageKey = state.element.page) {
    if (state.ocrHotspots.has(pageKey)) return paintCachedOcrHotspots(pageKey, wrap);
    const running = state.ocrJobs.get(pageKey);
    if (running) {
      await running;
      return paintCachedOcrHotspots(pageKey, wrap);
    }
    const job = runOcrDamageHotspots(page, wrap, pageKey);
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
  function paintManualHotspots(pageNumber, wrap) {
    for (const hotspot of state.manualHotspots.get(pageNumber) || []) {
      addHotspot(wrap, hotspot.numbers || [hotspot.number], { left: hotspot.x - 28, top: hotspot.y - 16, width: 56, height: 32 }, 1000, 1000, true);
    }
  }
  async function runOcrDamageHotspots(page, wrap, pageKey = state.element.page) {
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
      const damageWordAnchors = [];
      const appendJapaneseHits = (tsv, coordinateScale = 1, offsetX = 0, offsetY = 0) => {
        const rows = String(tsv || '').split(/\r?\n/).slice(1).map(line => line.split('\t')).filter(parts => parts.length >= 12 && parts[0] === '5');
        const lines = new Map();
        for (const parts of rows) {
          const key = `${parts[2]}:${parts[3]}:${parts[4]}`;
          const item = { left: Number(parts[6]) * coordinateScale + offsetX, top: Number(parts[7]) * coordinateScale + offsetY, width: Number(parts[8]) * coordinateScale, height: Number(parts[9]) * coordinateScale, text: parts.slice(11).join('\t') };
          if (!lines.has(key)) lines.set(key, []);
          lines.get(key).push(item);
        }
        for (const words of lines.values()) {
          const text = words.map(word => word.text).join('');
          const anchorWords = words.filter(word => normalizeDigits(word.text).replace(/[\s　]+/g, '').includes('損傷'));
          for (const anchor of anchorWords) damageWordAnchors.push(anchor);
          const numbers = [...new Set([...damageNumbers(text), ...bracketOnlyNumbers(text)].map(resolveDamageNumber))]
            .filter(number => !state.photoIndex.size || state.photoIndex.has(number));
          if (!numbers.length) continue;
          const normalizedLine = normalizeDigits(text).replace(/[\s　]+/g, '').replace(/[OoＯ〇]/g, '0').replace(/[Il|]/g, '1');
          const commaGrouped = /損傷[^損傷]{0,8}\d{1,3}[、,，・／/\.．]\d{1,3}/.test(normalizedLine) ||
            /[［\[【（(「『]\d{1,3}[、,，・／/\.．]\d{1,3}[］\]】）)」』]/.test(normalizedLine);
          const wordMatchesNumber = (word, number) => {
            const padded = formatDamageNumber(number);
            const normalized = normalizeDigits(word.text).replace(/[\s　]+/g, '');
            const ocrNormalized = normalized.replace(/[OoＯ〇]/g, '0').replace(/[Il|]/g, '1').replace(/[gqｇｑ]/g, '9');
            const numericToken = ocrNormalized.replace(/[^0-9]/g, '');
            const numericParts = [...ocrNormalized.matchAll(/\d{1,4}/g)].map(match => String(Number(match[0])));
            return damageNumbers(normalized).map(resolveDamageNumber).includes(number) ||
              ocrNormalized.includes(`損傷${padded}`) || ocrNormalized === padded ||
              numericParts.includes(number) ||
              (numericToken.length > 0 && numericToken.length <= 4 && String(Number(numericToken)) === number);
          };
          if (numbers.length > 1 && commaGrouped) {
            const matchedWords = words.filter(word => numbers.some(number => wordMatchesNumber(word, number)));
            if (matchedWords.length) {
              const left = Math.min(...matchedWords.map(word => word.left));
              const top = Math.min(...matchedWords.map(word => word.top));
              const right = Math.max(...matchedWords.map(word => word.left + word.width));
              const bottom = Math.max(...matchedWords.map(word => word.top + word.height));
              hits.push({ number: numbers[0], numbers, explicitGroup: true, source: isBracketedDamage(text, numbers[0]) ? 'bracketed' : 'label', box: { left, top, width: right - left, height: bottom - top } });
            }
            continue;
          }
          for (const number of numbers) {
          const padded = formatDamageNumber(number);
          const matchedWords = words.filter(word => wordMatchesNumber(word, number));
          // Tesseract may combine horizontally adjacent callouts into one
          // logical line. Never borrow the first word's position for another
          // damage number; an uncertain label is safer in the manual-review list.
          if (!matchedWords.length) continue;
          const source = matchedWords;
          const left = Math.min(...source.map(word => word.left));
          const top = Math.min(...source.map(word => word.top));
          const right = Math.max(...source.map(word => word.left + word.width));
          const bottom = Math.max(...source.map(word => word.top + word.height));
          hits.push({ number, source: isBracketedDamage(text, number) ? 'bracketed' : 'label', box: { left, top, width: right - left, height: bottom - top } });
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
      // High-resolution local retry anchored by the already recognized word
      // "損傷". This reads only the short number area beside that word, so
      // dense neighbouring callouts do not need another full-page OCR pass.
      {
        const uniqueAnchors = damageWordAnchors.filter((anchor, index, list) => list.findIndex(other =>
          Math.hypot(anchor.left - other.left, anchor.top - other.top) < Math.max(8, anchor.height)) === index);
        const isCovered = anchor => hits.some(hit => {
          const ax = anchor.left + anchor.width / 2, ay = anchor.top + anchor.height / 2;
          const hx = hit.box.left + hit.box.width / 2, hy = hit.box.top + hit.box.height / 2;
          return Math.abs(ay - hy) < Math.max(anchor.height, hit.box.height) * 1.2 &&
            Math.abs(ax - hx) < Math.max(anchor.width * 2.5, anchor.height * 10);
        });
        const orphanAnchors = uniqueAnchors.filter(anchor => !isCovered(anchor)).slice(0, 10);
        await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE });
        for (const anchor of orphanAnchors) {
          const h = Math.max(10, anchor.height);
          const cropLeft = Math.max(0, Math.floor(anchor.left - h * .8));
          const cropTop = Math.max(0, Math.floor(anchor.top - h * .45));
          const cropWidth = Math.min(canvas.width - cropLeft, Math.ceil(Math.max(anchor.width + h * 7, h * 12)));
          const cropHeight = Math.min(canvas.height - cropTop, Math.ceil(h * 1.9));
          if (cropWidth < 20 || cropHeight < 10) continue;
          const local = document.createElement('canvas'); local.width = cropWidth; local.height = cropHeight;
          const localContext = local.getContext('2d'); const localPixels = localContext.createImageData(cropWidth, cropHeight);
          for (let y = 0; y < cropHeight; y++) for (let x = 0; x < cropWidth; x++) {
            const sourceIndex = ((cropTop + y) * canvas.width + cropLeft + x) * 4, targetIndex = (y * cropWidth + x) * 4;
            const r = originalPixels[sourceIndex], g = originalPixels[sourceIndex + 1], b = originalPixels[sourceIndex + 2];
            const value = r > 90 && r > g * 1.12 && r > b * 1.12 ? 0 : 255;
            localPixels.data[targetIndex] = value; localPixels.data[targetIndex + 1] = value; localPixels.data[targetIndex + 2] = value; localPixels.data[targetIndex + 3] = 255;
          }
          localContext.putImageData(localPixels, 0, 0);
          const scale = 4, high = document.createElement('canvas'); high.width = cropWidth * scale; high.height = cropHeight * scale;
          const highContext = high.getContext('2d'); highContext.imageSmoothingEnabled = false; highContext.drawImage(local, 0, 0, high.width, high.height);
          const localResult = await worker.recognize(high, {}, { tsv: true });
          const rows = String(localResult.data.tsv || '').split(/\r?\n/).slice(1).map(line => line.split('\t')).filter(parts => parts.length >= 12 && parts[0] === '5');
          for (const parts of rows) {
            const raw = normalizeDigits(parts.slice(11).join('\t')).replace(/[OoＯ〇]/g, '0').replace(/[Il|]/g, '1').replace(/[gqｇｑ]/g, '9').replace(/\D/g, '');
            if (!/^\d{1,3}$/.test(raw)) continue;
            const number = resolveDamageNumber(raw);
            if (!number || number === '0' || (state.photoIndex.size && !state.photoIndex.has(number))) continue;
            if (hits.some(hit => (hit.numbers || [hit.number]).includes(number))) continue;
            hits.push({ number, source: 'anchor-hires', box: {
              left: cropLeft + Number(parts[6]) / scale, top: cropTop + Number(parts[7]) / scale,
              width: Number(parts[8]) / scale, height: Number(parts[9]) / scale
            } });
          }
        }
        await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
      }
      // Some inspection PDFs convert every red annotation to vector outlines.
      // Japanese OCR may then miss the word "損傷" even though its two digits
      // remain clear. A digits-only pass supplies tap targets for those labels.
      {
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
          const numericLines = new Map();
          for (const parts of numericRows) {
            const key = `${parts[2]}:${parts[3]}:${parts[4]}`;
            if (!numericLines.has(key)) numericLines.set(key, []);
            numericLines.get(key).push(parts);
          }
          const candidates = [];
          for (const line of numericLines.values()) {
            const sorted = line.sort((a, b) => Number(a[6]) - Number(b[6]));
            const joined = sorted.map(parts => normalizeDigits(parts.slice(11).join('\t')).replace(/\D/g, '')).join('');
            if (/^\d{1,3}$/.test(joined)) {
              const left = Math.min(...sorted.map(parts => Number(parts[6]))), top = Math.min(...sorted.map(parts => Number(parts[7])));
              const right = Math.max(...sorted.map(parts => Number(parts[6]) + Number(parts[8]))), bottom = Math.max(...sorted.map(parts => Number(parts[7]) + Number(parts[9])));
              candidates.push({ raw: joined, left, top, width: right - left, height: bottom - top });
            }
          }
          for (const parts of numericRows) candidates.push({ raw: normalizeDigits(parts.slice(11).join('\t')).replace(/[gq]/gi, '9').replace(/\D/g, ''), left: Number(parts[6]), top: Number(parts[7]), width: Number(parts[8]), height: Number(parts[9]) });
          // Dense callouts can be returned as one long token such as 111219.
          // Split it with the known damage numbers from the photo ledger and
          // retain an approximate sub-box for sequence validation (11/12/19).
          const splitCandidates = [];
          for (const candidate of candidates) {
            if (candidate.raw.length <= 3 || candidate.raw.length > 18 || !state.photoIndex.size) continue;
            for (const knownNumber of state.photoIndex.keys()) {
              const token = formatDamageNumber(knownNumber);
              if (token.length < 2) continue;
              let from = 0;
              while (from <= candidate.raw.length - token.length) {
                const index = candidate.raw.indexOf(token, from);
                if (index < 0) break;
                const ratioStart = index / candidate.raw.length, ratioSize = token.length / candidate.raw.length;
                const vertical = candidate.height > candidate.width * 1.35;
                splitCandidates.push({
                  raw: token,
                  left: candidate.left + (vertical ? 0 : candidate.width * ratioStart),
                  top: candidate.top + (vertical ? candidate.height * ratioStart : 0),
                  width: vertical ? candidate.width : candidate.width * ratioSize,
                  height: vertical ? candidate.height * ratioSize : candidate.height
                });
                from = index + 1;
              }
            }
          }
          candidates.push(...splitCandidates);
          for (const candidate of candidates) {
            const raw = candidate.raw;
            if (!/^\d{1,3}$/.test(raw)) continue;
            const number = resolveDamageNumber(raw);
            if (number === '0' || known.has(number)) continue;
            if (state.photoIndex.size && !state.photoIndex.has(number)) continue;
            known.add(number);
            const textHeight = Math.max(8, candidate.height);
            hits.push({
              number, source: 'digits',
              box: { left: candidate.left - textHeight * 3.1, top: candidate.top - textHeight * .35, width: candidate.width + textHeight * 4.0, height: candidate.height + textHeight * .7 }
            });
          }
        }
      }
      // Retry only the neighbourhood of a missing sequential number at twice
      // the OCR resolution. This catches tiny labels such as 01/19 without
      // rescanning the whole PDF or confusing a distant genuine 10.
      if (state.photoIndex.size) {
        // Digits-only hits are candidates, not confirmed/visible hotspots.
        // Do not let an invisible "1" candidate suppress the focused retry
        // that is needed to confirm damage 01.
        const present = new Set(hits.filter(hit => hit.source !== 'digits').flatMap(hit => hit.numbers || [hit.number]).map(String));
        const expected = [...state.photoIndex.keys()].map(String).sort((a, b) => Number(a) - Number(b));
        const minimum = expected[0];
        const retry = expected.filter(number => {
          if (present.has(number)) return false;
          const value = Number(number);
          const lower = [...present].map(Number).filter(candidate => candidate < value).sort((a, b) => b - a)[0];
          const upper = [...present].map(Number).filter(candidate => candidate > value).sort((a, b) => a - b)[0];
          return (Number.isFinite(lower) && Number.isFinite(upper) && upper - lower <= 3) ||
            (number === minimum && present.has(String(value + 1)));
        }).slice(0, 6);
        await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
        for (const missing of retry) {
          await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
          const value = Number(missing);
          const confirmedHits = hits.filter(hit => hit.source !== 'digits');
          const lowerNumber = confirmedHits.map(hit => Number(hit.number)).filter(candidate => candidate < value).sort((a, b) => b - a)[0];
          const upperNumber = confirmedHits.map(hit => Number(hit.number)).filter(candidate => candidate > value).sort((a, b) => a - b)[0];
          const before = confirmedHits.find(hit => Number(hit.number) === lowerNumber);
          const after = confirmedHits.find(hit => Number(hit.number) === upperNumber);
          const neighbours = [before, after].filter(Boolean);
          if (!neighbours.length) continue;
          const wanted = formatDamageNumber(missing), reversed = [...wanted].reverse().join('');
          const neighbourPoints = neighbours.map(hit => ({ x: hit.box.left + hit.box.width / 2, y: hit.box.top + hit.box.height / 2 }));
          const averagePoint = neighbourPoints.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
          averagePoint.x /= neighbourPoints.length; averagePoint.y /= neighbourPoints.length;
          // Damage numbers are sequential, but their callouts are not always
          // spatially sequential. Search around each neighbour first, then the
          // midpoint, instead of assuming the missing label lies halfway.
          const searchPoints = [...neighbourPoints, averagePoint].filter((point, index, list) =>
            list.findIndex(other => Math.hypot(point.x - other.x, point.y - other.y) < 8) === index);
          let matches = [];
          let japaneseMatchFound = false;
          for (const point of searchPoints) {
            const cropLeft = Math.max(0, Math.floor(point.x - canvas.width * .12));
            const cropTop = Math.max(0, Math.floor(point.y - canvas.height * .10));
            const cropWidth = Math.min(canvas.width - cropLeft, Math.ceil(canvas.width * .24));
            const cropHeight = Math.min(canvas.height - cropTop, Math.ceil(canvas.height * .20));
            if (cropWidth < 20 || cropHeight < 20) continue;
            const sourceCanvas = document.createElement('canvas'); sourceCanvas.width = cropWidth; sourceCanvas.height = cropHeight;
            const sourceContext = sourceCanvas.getContext('2d'); const cropPixels = sourceContext.createImageData(cropWidth, cropHeight);
            for (let y = 0; y < cropHeight; y++) for (let x = 0; x < cropWidth; x++) {
              const sourceIndex = ((cropTop + y) * canvas.width + cropLeft + x) * 4, targetIndex = (y * cropWidth + x) * 4;
              const r = originalPixels[sourceIndex], g = originalPixels[sourceIndex + 1], b = originalPixels[sourceIndex + 2];
              const colour = r > 95 && r > g * 1.15 && r > b * 1.15 ? 0 : 255;
              cropPixels.data[targetIndex] = colour; cropPixels.data[targetIndex + 1] = colour; cropPixels.data[targetIndex + 2] = colour; cropPixels.data[targetIndex + 3] = 255;
            }
            sourceContext.putImageData(cropPixels, 0, 0);
            const retryCanvas = document.createElement('canvas'); retryCanvas.width = cropWidth * 2; retryCanvas.height = cropHeight * 2;
            const retryContext = retryCanvas.getContext('2d'); retryContext.imageSmoothingEnabled = false; retryContext.drawImage(sourceCanvas, 0, 0, retryCanvas.width, retryCanvas.height);
            const retryResult = await worker.recognize(retryCanvas, {}, { tsv: true });
            const rows = String(retryResult.data.tsv || '').split(/\r?\n/).slice(1).map(line => line.split('\t')).filter(parts => parts.length >= 12 && parts[0] === '5');
            matches.push(...rows.map(parts => ({ raw: normalizeDigits(parts.slice(11).join('\t')).replace(/[gq]/gi, '9').replace(/\D/g, ''), left: Number(parts[6]) / 2 + cropLeft, top: Number(parts[7]) / 2 + cropTop, width: Number(parts[8]) / 2, height: Number(parts[9]) / 2 }))
              .filter(item => item.raw === wanted || String(Number(item.raw)) === missing || item.raw === reversed));
            if (matches.length) break;
            // Digits may be split from the Japanese label. Retry the same
            // small crop with the Japanese model and accept only a complete
            // damage label found inside this crop.
            await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
            const previousHitCount = hits.length;
            const japaneseResult = await worker.recognize(retryCanvas, {}, { tsv: true });
            appendJapaneseHits(japaneseResult.data.tsv, .5, cropLeft, cropTop);
            japaneseMatchFound = hits.slice(previousHitCount).some(hit => (hit.numbers || [hit.number]).includes(missing));
            if (japaneseMatchFound) break;
            await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
          }
          if (japaneseMatchFound) { present.add(missing); continue; }
          if (!matches.length) continue;
          matches.sort((a, b) => Math.min(...searchPoints.map(point => Math.hypot(a.left - point.x, a.top - point.y))) - Math.min(...searchPoints.map(point => Math.hypot(b.left - point.x, b.top - point.y))));
          const match = matches[0];
          // Keep the numeric glyph's real OCR coordinates. addHotspot already
          // expands the visible/tap frame; estimating the missing Japanese
          // prefix here shifted the frame too far to the left.
          hits.push({ number: missing, source: 'label', focusedRetry: true, box: { left: match.left, top: match.top, width: match.width, height: match.height } });
          present.add(missing);
        }
        const unresolved = new Set(retry);
        if (unresolved.size) {
          await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
          const overlapX = Math.floor(canvas.width * .04), overlapY = Math.floor(canvas.height * .04);
          for (let tileY = 0; tileY < 2 && unresolved.size; tileY++) {
            for (let tileX = 0; tileX < 2 && unresolved.size; tileX++) {
              const left = Math.max(0, Math.floor(tileX * canvas.width / 2) - overlapX);
              const top = Math.max(0, Math.floor(tileY * canvas.height / 2) - overlapY);
              const width = Math.min(canvas.width - left, Math.ceil(canvas.width / 2) + overlapX * 2);
              const height = Math.min(canvas.height - top, Math.ceil(canvas.height / 2) + overlapY * 2);
              const sourceCanvas = document.createElement('canvas'); sourceCanvas.width = width; sourceCanvas.height = height;
              const sourceContext = sourceCanvas.getContext('2d'); const tilePixels = sourceContext.createImageData(width, height);
              for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
                const sourceIndex = ((top + y) * canvas.width + left + x) * 4, targetIndex = (y * width + x) * 4;
                const r = originalPixels[sourceIndex], g = originalPixels[sourceIndex + 1], b = originalPixels[sourceIndex + 2];
                const colour = r > 95 && r > g * 1.15 && r > b * 1.15 ? 0 : 255;
                tilePixels.data[targetIndex] = colour; tilePixels.data[targetIndex + 1] = colour; tilePixels.data[targetIndex + 2] = colour; tilePixels.data[targetIndex + 3] = 255;
              }
              sourceContext.putImageData(tilePixels, 0, 0);
              const scale = 1.5, tileCanvas = document.createElement('canvas'); tileCanvas.width = Math.ceil(width * scale); tileCanvas.height = Math.ceil(height * scale);
              const tileContext = tileCanvas.getContext('2d'); tileContext.imageSmoothingEnabled = false; tileContext.drawImage(sourceCanvas, 0, 0, tileCanvas.width, tileCanvas.height);
              const result = await worker.recognize(tileCanvas, {}, { tsv: true });
              const previousHitCount = hits.length;
              appendJapaneseHits(result.data.tsv, 1 / scale, left, top);
              const tileHits = hits.slice(previousHitCount);
              for (const missing of [...unresolved]) {
                if (!tileHits.some(hit => (hit.numbers || [hit.number]).includes(missing))) continue;
                hits = hits.filter(hit => !(hit.focusedRetry && hit.number === missing));
                present.add(missing); unresolved.delete(missing);
              }
            }
          }
        }
        await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
      }
      // Never merge separate OCR hits merely because consecutive numbers are
      // vertically close. Dense callouts often share almost the same baseline.
      // A multi-number hotspot is allowed only when the numbers were read from
      // the same bracketed label (including an actual comma/separator).
      // If OCR reads one label as an existing number (for example 52 as 62),
      // use the spatial order of its confirmed neighbours to repair the duplicate.
      const center = hit => ({ x: hit.box.left + hit.box.width / 2, y: hit.box.top + hit.box.height / 2 });
      const presentNumbers = new Set(hits.map(hit => hit.number));
      // Repair a dropped leading zero / stray trailing stroke only when the
      // shorter number completes a local sequence on this page. For example,
      // 06, 71, 08 becomes 06, 07, 08. Requiring both neighbours, proximity,
      // and the absence of 70/72 avoids changing a genuine damage 71.
      for (const hit of hits) {
        const raw = String(hit.number);
        if (raw.length < 2 || raw.length > 3) continue;
        const original = Number(raw);
        if (presentNumbers.has(String(original - 1)) || presentNumbers.has(String(original + 1))) continue;
        const alternatives = [...new Set(Array.from({ length: raw.length }, (_, index) => String(Number(raw.slice(0, index) + raw.slice(index + 1)))))];
        for (const alternative of alternatives) {
          const value = Number(alternative);
          if (!value || presentNumbers.has(alternative)) continue;
          if (state.photoIndex.size && !state.photoIndex.has(alternative)) continue;
          const before = hits.find(other => other.number === String(value - 1));
          const after = hits.find(other => other.number === String(value + 1));
          if (!before || !after) continue;
          const point = center(hit), a = center(before), b = center(after);
          const nearby = Math.max(Math.hypot(point.x - a.x, point.y - a.y), Math.hypot(point.x - b.x, point.y - b.y)) < canvas.width * .2;
          if (!nearby) continue;
          hit.number = alternative;
          presentNumbers.delete(raw);
          presentNumbers.add(alternative);
          break;
        }
      }
      const byNumber = new Map();
      for (const hit of hits) {
        if (!byNumber.has(hit.number)) byNumber.set(hit.number, []);
        byNumber.get(hit.number).push(hit);
      }
      // OCR occasionally reverses two digits (01 -> 10). When the reversed
      // value appears at two distinct positions, keep one as the genuine value
      // and assign the cluster nearest the missing number's neighbour to it.
      for (const [number, duplicates] of byNumber) {
        const raw = String(number);
        if (raw.length !== 2) continue;
        const reversed = String(Number([...raw].reverse().join('')));
        if (!reversed || reversed === number || presentNumbers.has(reversed)) continue;
        if (state.photoIndex.size && !state.photoIndex.has(reversed)) continue;
        const clusters = duplicates.filter((hit, index, list) => {
          const point = center(hit);
          return list.findIndex(other => {
            const otherPoint = center(other);
            return Math.hypot(point.x - otherPoint.x, point.y - otherPoint.y) < 80;
          }) === index;
        });
        if (clusters.length < 2) continue;
        const value = Number(reversed);
        const neighbours = hits.filter(hit => hit.number === String(value - 1) || hit.number === String(value + 1));
        if (!neighbours.length) continue;
        const distanceToNeighbours = hit => {
          const point = center(hit);
          return Math.min(...neighbours.map(other => { const target = center(other); return Math.hypot(point.x - target.x, point.y - target.y); }));
        };
        const ordered = [...clusters].sort((a, b) => distanceToNeighbours(a) - distanceToNeighbours(b));
        if (ordered.length > 1 && distanceToNeighbours(ordered[0]) > distanceToNeighbours(ordered[1]) * .82) continue;
        const target = center(ordered[0]);
        for (const hit of duplicates) {
          const point = center(hit);
          if (Math.hypot(point.x - target.x, point.y - target.y) < 80) hit.number = reversed;
        }
        presentNumbers.add(reversed);
      }
      for (const [number, duplicates] of []) {
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
      const sourcePriority = hit => hit.source === 'bracketed' ? 0 : (hit.source === 'label' ? 1 : 2);
      for (const hit of [...hits].sort((a, b) => sourcePriority(a) - sourcePriority(b) || area(a) - area(b))) {
        const existing = compact.find(candidate => overlapRatio(candidate, hit) > .55);
        if (existing) {
          if (existing.explicitGroup) continue;
          if (hit.explicitGroup) {
            Object.assign(existing, hit);
            continue;
          }
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
          // Overlap alone does not mean a comma-separated label. Keep the OCR
          // candidate that best fits the page sequence instead of combining
          // unrelated numbers such as damage 25 and 53.
          const currentScore = Math.max(...currentNumbers.map(neighbourScore));
          const hitScore = neighbourScore(hit.number);
          if (hitScore > currentScore) {
            Object.assign(existing, hit);
            delete existing.numbers;
          }
          continue;
        }
        compact.push(hit);
      }
      hits = compact;
      // Restore the v283 recognition range: Japanese labels remain usable even
      // when OCR misses both brackets. Digits-only guesses stay manual-review
      // candidates. Per-number word anchors above still prevent neighbouring
      // callouts from sharing the wrong orange frame.
      const displayHits = hits.filter(hit => hit.source !== 'digits');
      state.ocrHotspots.set(pageKey, { hits: displayHits, candidates: hits, width: canvas.width, height: canvas.height });
      for (const hit of displayHits) addHotspot(wrap, hit.numbers || hit.number, hit.box, canvas.width, canvas.height);
      const recognizedCount = displayHits.reduce((count, hit) => count + (hit.numbers?.length || 1), 0);
      $('globalStatus').textContent = recognizedCount
        ? `${recognizedCount}件の損傷番号を画像認識しました。オレンジ枠をタップしてください`
        : '損傷番号を画像認識できませんでした。右上の番号入力をご利用ください';
    } catch (error) {
      console.error('Damage OCR failed', error);
      state.ocrWorker = null;
      const reason = cleanField(error?.message || error).slice(0, 90);
      $('globalStatus').textContent = `画像認識に失敗しました${reason ? `（${reason}）` : ''}。再読み込み後も失敗する場合は手動設定をご利用ください`;
    }
  }
  async function preloadAllElementPages() {
    const doc = state.element.doc;
    if (!doc) return;
    const total = doc.numPages;
    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      state.ocrProgress = { page: pageNumber, total };
      $('globalStatus').textContent = `全${total}枚中 ${pageNumber}枚を画像認識中`;
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      state.elementSpanNumbers.set(pageNumber, spanNumberFromItems(content.items));
      state.textDamageNumbers.set(pageNumber, new Set(damageNumbers(content.items.map(item => item.str || '').join(''))));
      if (state.ocrHotspots.has(pageNumber)) continue;
      const running = state.ocrJobs.get(pageNumber);
      if (running) { await running; continue; }
      const holder = document.createElement('div');
      const job = runOcrDamageHotspots(page, holder, pageNumber);
      state.ocrJobs.set(pageNumber, job);
      try { await job; } finally { state.ocrJobs.delete(pageNumber); }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    state.ocrProgress = null;
    auditRecognizedDamageNumbers();
    $('globalStatus').textContent = state.missingDamageNumbers.length
      ? `全${total}枚の画像認識完了。未認識の損傷番号が${state.missingDamageNumbers.length}件あります`
      : `全${total}枚の画像認識が完了しました（連番の欠落なし）`;
    await renderSide('element');
  }
  function promoteSequenceOcrCandidates() {
    const expected = [...state.photoIndex.keys()].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!expected.length) return;
    const expectedSet = new Set(expected.map(String));
    const pages = [...state.ocrHotspots.keys()].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const numbersOnPage = pageNumber => {
      const values = new Set([...(state.textDamageNumbers.get(pageNumber) || [])].map(String));
      for (const hit of state.ocrHotspots.get(pageNumber)?.hits || []) {
        for (const number of hit.numbers || [hit.number]) values.add(String(number));
      }
      return values;
    };
    const pageSets = new Map(pages.map(page => [page, numbersOnPage(page)]));
    const firstPage = pages[0], lastPage = pages.at(-1);
    for (const page of pages) {
      const cached = state.ocrHotspots.get(page), present = pageSets.get(page);
      const previous = pageSets.get(page - 1), next = pageSets.get(page + 1);
      const previousMax = previous?.size ? Math.max(...[...previous].map(Number)) : null;
      const nextMin = next?.size ? Math.min(...[...next].map(Number)) : null;
      for (const candidate of cached.candidates || []) {
        if (candidate.source !== 'digits') continue;
        const readNumber = String(candidate.number);
        const possible = expected.filter(value => {
          const number = String(value);
          if (present.has(number)) return false;
          return number === readNumber ||
            (number.length === readNumber.length + 1 && (number.startsWith(readNumber) || number.endsWith(readNumber)));
        }).map(value => {
          let score = 0;
          const hasBefore = present.has(String(value - 1));
          const hasAfter = present.has(String(value + 1));
          const documentBoundary = (value === expected[0] && page === firstPage) || (value === expected.at(-1) && page === lastPage);
          // Never assign a digits-only candidate across a page boundary. A
          // value following page 2's 48 may be page 2 or page 3's 49; only
          // same-page neighbours on both sides (or a document edge) are safe.
          if (!(hasBefore && hasAfter) && !documentBoundary) return { number: String(value), score: -1 };
          if (hasBefore) score += 3;
          if (hasAfter) score += 3;
          if (documentBoundary) score += 3;
          if (String(value) !== readNumber) score -= 1;
          return { number: String(value), score };
        }).filter(item => item.score >= 5).sort((a, b) => b.score - a.score);
        if (!possible.length || (possible[1] && possible[1].score === possible[0].score)) continue;
        const repaired = possible[0].number;
        cached.hits.push({ ...candidate, number: repaired, source: 'sequence' });
        present.add(repaired);
      }
    }
  }
  function auditRecognizedDamageNumbers() {
    promoteSequenceOcrCandidates();
    const pagesByNumber = new Map(), numbersByPage = new Map(), candidatePages = new Map();
    const record = (number, pageNumber) => {
      number = Number(number); pageNumber = Number(pageNumber); if (!Number.isFinite(number)) return;
      if (!pagesByNumber.has(number)) pagesByNumber.set(number, new Set()); pagesByNumber.get(number).add(pageNumber);
      if (!numbersByPage.has(pageNumber)) numbersByPage.set(pageNumber, new Set()); numbersByPage.get(pageNumber).add(number);
    };
    for (const [pageNumber, cached] of state.ocrHotspots) {
      for (const hit of cached.hits || []) for (const number of hit.numbers || [hit.number]) record(number, pageNumber);
      for (const hit of cached.candidates || []) if (hit.source === 'digits') {
        for (const number of hit.numbers || [hit.number]) {
          const key = Number(number); if (!candidatePages.has(key)) candidatePages.set(key, new Set()); candidatePages.get(key).add(Number(pageNumber));
        }
      }
    }
    for (const [pageNumber, numbers] of state.textDamageNumbers) for (const number of numbers) record(number, pageNumber);
    // The current page may finish its asynchronous text/OCR rendering after
    // the preload audit. Treat the orange frames actually visible on screen as
    // authoritative so they can never remain in the unrecognized list.
    document.querySelectorAll('#elementViewer .hotspot').forEach(hotspot => {
      // dataset.numbers is the authoritative list for a grouped hotspot.
      // Re-parsing its display label could drop the number after a separator.
      const storedNumbers = (hotspot.dataset.numbers || '').split(',').filter(Boolean);
      const numbers = storedNumbers.length ? storedNumbers : damageNumbers(hotspot.dataset.label || '');
      for (const number of numbers) record(number, state.element.page);
    });
    // Apply persisted edits to the audit as well as to the visible frames.
    // This prevents a corrected/deleted OCR value from returning to either
    // confirmation list after changing pages.
    for (const [key, edit] of state.hotspotOverrides) {
      if (!edit.deleted && !edit.numbers?.length) continue;
      const separator = key.indexOf(':'), pageNumber = Number(key.slice(0, separator));
      const localKey = key.slice(separator + 1);
      let originalNumbers = [];
      if (localKey.startsWith('text:')) originalNumbers = [localKey.split(':')[1]];
      else if (localKey.startsWith('detected:')) originalNumbers = damageNumbers(localKey.slice('detected:'.length).split(':')[0]);
      for (const original of originalNumbers) {
        pagesByNumber.get(Number(original))?.delete(pageNumber);
        numbersByPage.get(pageNumber)?.delete(Number(original));
      }
      if (!edit.deleted) for (const number of edit.numbers || []) record(number, pageNumber);
    }
    const recognized = [...pagesByNumber.keys()].filter(Number.isFinite).sort((a, b) => a - b);
    const photoNumbers = [...state.photoIndex.keys()].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const expected = photoNumbers.length ? photoNumbers : (recognized.length ? Array.from({ length: recognized.at(-1) - recognized[0] + 1 }, (_, index) => recognized[0] + index) : []);
    const pageGap = new Map();
    for (const [pageNumber, values] of numbersByPage) {
      const sorted = [...values].sort((a, b) => a - b); if (sorted.length < 2) continue;
      for (let number = sorted[0]; number <= sorted.at(-1); number++) if (!values.has(number) && expected.includes(number)) pageGap.set(number, pageNumber);
    }
    const pageRanges = new Map([...numbersByPage].map(([pageNumber, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return [pageNumber, { min: sorted[0], max: sorted.at(-1) }];
    }));
    const expectedItems = state.photoIndex.size
      ? [...new Map([...state.photoIndex].flatMap(([number, entries]) => {
          const spans = [...new Set(entries.map(entry => String(entry.record?.spanNumber || '')))];
          return (spans.length ? spans : ['']).map(spanNumber => [`${spanNumber}:${number}`, { number: Number(number), spanNumber }]);
        })).values()]
      : [...new Set(expected)].map(number => ({ number, spanNumber: '' }));
    const manualItems = [...state.manualHotspots.values()].flat();
    state.missingDamageNumbers = expectedItems.filter(item => {
      const pages = [...(pagesByNumber.get(item.number) || [])];
      const recognizedInSpan = pages.some(pageNumber => !item.spanNumber || String(state.elementSpanNumbers.get(pageNumber) || '') === item.spanNumber);
      const ignoredKey = `${item.spanNumber}:${item.number}`;
      const manuallySet = manualItems.some(manual => (manual.numbers || [manual.number]).some(value => Number(value) === item.number) && (!item.spanNumber || !manual.spanNumber || String(manual.spanNumber) === item.spanNumber));
      return !recognizedInSpan && !state.ignoredMissing.has(ignoredKey) && !state.ignoredMissing.has(item.number) && !manuallySet;
    }).map(item => {
      const number = item.number, targetSpan = item.spanNumber;
      const sameSpan = pageNumber => !targetSpan || String(state.elementSpanNumbers.get(pageNumber) || '') === targetSpan;
      const recognizedInSpan = recognized.filter(value => [...(pagesByNumber.get(value) || [])].some(sameSpan));
      const lower = recognizedInSpan.filter(value => value < number).at(-1), upper = recognizedInSpan.find(value => value > number);
      const lowerPage = lower ? [...pagesByNumber.get(lower)].find(sameSpan) : null, upperPage = upper ? [...pagesByNumber.get(upper)].find(sameSpan) : null;
      // Reject a weak digits-only candidate when it is outside that page's
      // recognized number range. A little margin allows missing numbers at a
      // page boundary (for example 32/33 before recognized 34 on page 4).
      const lowConfidencePages = [...(candidatePages.get(number) || [])].filter(pageNumber => {
        const range = pageRanges.get(pageNumber);
        return sameSpan(pageNumber) && (!range || (number >= range.min - 3 && number <= range.max + 3));
      });
      const neighbourPage = lowerPage && lowerPage === upperPage ? lowerPage : null;
      const boundaryPage = lowerPage && upperPage && lowerPage !== upperPage ? upperPage : (lowerPage || upperPage);
      const spanPages = [...state.elementSpanNumbers].filter(([, span]) => targetSpan && String(span) === targetSpan).map(([page]) => Number(page));
      const page = [pageGap.get(number), neighbourPage, lowConfidencePages.length === 1 ? lowConfidencePages[0] : null, boundaryPage]
        .find(pageNumber => pageNumber && sameSpan(pageNumber)) || (spanPages.length === 1 ? spanPages[0] : null);
      return { number, page, spanNumber: targetSpan };
    });
    // Reverse audit: a label can be recognized correctly on the element
    // diagram even when the photo ledger has no matching record. Keep this
    // separate from OCR misses so field staff know which source needs work.
    const recognizedItems = [...new Map([...pagesByNumber].flatMap(([number, pages]) => [...pages].map(page => {
      const spanNumber = String(state.elementSpanNumbers.get(page) || '');
      return [`${spanNumber}:${number}`, { number, page, spanNumber }];
    }))).values()];
    const photoHasNumber = item => {
      const entries = state.photoIndex.get(String(item.number)) || [];
      if (!entries.length) return false;
      if (!item.spanNumber) return true;
      const knownSpans = entries.map(entry => String(entry.record?.spanNumber || '')).filter(Boolean);
      // Older photo ledgers may not expose a span number. In that case use
      // number-only matching instead of incorrectly marking every label.
      return !knownSpans.length || knownSpans.includes(item.spanNumber);
    };
    state.missingPhotoNumbers = state.photoIndex.size
      ? recognizedItems.filter(item => !photoHasNumber(item)).sort((a, b) => a.page - b.page || a.number - b.number)
      : [];
    const button = $('recognitionResults');
    const reviewCount = state.missingDamageNumbers.length + state.missingPhotoNumbers.length;
    button.classList.toggle('hiddenPanel', !reviewCount);
    button.textContent = `確認 ${reviewCount}`;
    renderRecognitionResults();
    // Audits also run after zoom/redraw. Keep the result count current, but
    // never open the panel implicitly; it opens only from the top button.
  }
  function renderRecognitionResults() {
    const missingElementCount = state.missingDamageNumbers.length, missingPhotoCount = state.missingPhotoNumbers.length;
    $('recognitionResultSummary').textContent = (missingElementCount || missingPhotoCount)
      ? `要素図で未認識：${missingElementCount}件／要素図にはあるが写真なし：${missingPhotoCount}件`
      : '確認が必要な損傷番号はありません。';
    const list = $('recognitionResultList'); list.replaceChildren();
    const addSectionTitle = (title, count) => {
      const heading = document.createElement('div'); heading.className = 'recognitionResultSectionTitle';
      heading.textContent = `${title}（${count}件）`; list.appendChild(heading);
    };
    addSectionTitle('要素図で未認識', missingElementCount);
    if (!missingElementCount) {
      const empty = document.createElement('div'); empty.className = 'recognitionResultEmpty'; empty.textContent = '該当なし'; list.appendChild(empty);
    }
    for (const result of state.missingDamageNumbers) {
      const row = document.createElement('div'); row.className = 'missingResult';
      const label = document.createElement('span'); label.className = 'missingResultLabel';
      label.textContent = `損傷${String(result.number).padStart(2, '0')}${result.spanNumber ? `（${result.spanNumber}径間）` : ''}　${result.page ? `候補：要素図 ${result.page}ページ` : '候補ページ不明'}`;
      const manual = document.createElement('button'); manual.className = 'missingManual'; manual.textContent = '手動設定'; manual.disabled = !result.page;
      manual.addEventListener('click', async () => {
        state.element.page = result.page; state.pendingManualDamage = { number: result.number, page: result.page, spanNumber: result.spanNumber || '' }; state.drawMode = 'select';
        $('manualPlacementLabel').textContent = `設定中：損傷${String(result.number).padStart(2, '0')}`;
        $('manualPlacementBanner').classList.remove('hiddenPanel');
        document.querySelectorAll('[data-draw]').forEach(item => item.classList.remove('active'));
        $('recognitionResultPane').classList.add('hiddenPanel'); await renderSide('element');
        await jumpToDamage(result.number, result.spanNumber || null);
        $('globalStatus').textContent = `損傷${String(result.number).padStart(2, '0')}の位置を図面上でタップしてください`;
      });
      const ignore = document.createElement('button'); ignore.className = 'missingIgnore'; ignore.textContent = '登録なし';
      ignore.addEventListener('click', () => { state.ignoredMissing.add(`${result.spanNumber || ''}:${result.number}`); auditRecognizedDamageNumbers(); });
      row.append(label, manual, ignore); list.appendChild(row);
    }
    addSectionTitle('要素図にはあるが写真なし', missingPhotoCount);
    if (!missingPhotoCount) {
      const empty = document.createElement('div'); empty.className = 'recognitionResultEmpty'; empty.textContent = '該当なし'; list.appendChild(empty);
    }
    for (const result of state.missingPhotoNumbers) {
      const row = document.createElement('div'); row.className = 'missingResult missingPhotoResult';
      const label = document.createElement('span'); label.className = 'missingResultLabel';
      label.textContent = `損傷${String(result.number).padStart(2, '0')}${result.spanNumber ? `（${result.spanNumber}径間）` : ''}　要素図 ${result.page}ページ`;
      const show = document.createElement('button'); show.textContent = 'ページ表示';
      show.addEventListener('click', async () => {
        state.element.page = result.page; $('recognitionResultPane').classList.add('hiddenPanel'); await renderSide('element');
        $('globalStatus').textContent = `写真なし：損傷${String(result.number).padStart(2, '0')}（要素図 ${result.page}ページ）`;
      });
      row.append(label, show); list.appendChild(row);
    }
  }
  function placePhotoPaneInViewer(reset = false) {
    const pane = $('photoPane'), area = $('elementViewer').getBoundingClientRect();
    if (!area.width || !area.height) return;
    pane.style.setProperty('--photo-max-left', `${area.left + 4}px`);
    pane.style.setProperty('--photo-max-top', `${area.top + 4}px`);
    pane.style.setProperty('--photo-max-width', `${Math.max(310, area.width - 8)}px`);
    pane.style.setProperty('--photo-max-height', `${Math.max(270, area.height - 8)}px`);
    if (pane.classList.contains('maximized')) return;
    if (state.photo.dockMode !== 'free') { applyPhotoDockLayout(); return; }
    const width = Math.min(reset ? Math.max(320, area.width * .62) : pane.offsetWidth, area.width - 12);
    const height = Math.min(reset ? Math.max(280, area.height * .72) : pane.offsetHeight, area.height - 12);
    pane.style.width = `${width}px`; pane.style.height = `${height}px`; pane.style.right = 'auto';
    if (reset) { pane.style.left = `${area.right - width - 6}px`; pane.style.top = `${area.top + 6}px`; }
    else {
      pane.style.left = `${Math.max(area.left, Math.min(parseFloat(pane.style.left) || area.left, area.right - pane.offsetWidth))}px`;
      pane.style.top = `${Math.max(area.top, Math.min(parseFloat(pane.style.top) || area.top, area.bottom - pane.offsetHeight))}px`;
    }
  }
  function applyPhotoDockLayout() {
    const pane = $('photoPane'), elementPane = $('elementPane'), main = document.querySelector('main'), divider = $('photoDockDivider');
    elementPane.style.width = '100%'; elementPane.style.height = '100%'; elementPane.style.marginLeft = '0'; elementPane.style.marginTop = '0';
    // Maximized photo view is independent of the left/right split. Clear all
    // dock-only geometry so the divider and the narrowed element pane cannot
    // remain visible behind the maximized window.
    if (pane.classList.contains('maximized')) {
      pane.classList.remove('docked');
      pane.style.removeProperty('max-height'); pane.style.removeProperty('max-width');
      divider.classList.add('hiddenPanel');
      return;
    }
    pane.classList.toggle('docked', state.photo.dockMode !== 'free');
    if (state.photo.dockMode === 'free' || pane.classList.contains('hiddenPanel')) {
      pane.style.removeProperty('max-height'); pane.style.removeProperty('max-width');
      divider.classList.add('hiddenPanel'); return;
    }
    divider.classList.remove('hiddenPanel');
    const area = main.getBoundingClientRect(), gap = 8;
    const paneWidth = Math.min(pane.offsetWidth, Math.max(320, area.width - 320 - gap));
    const paneHeight = area.height - 12;
    pane.style.maxWidth = `${area.width - 12}px`; pane.style.maxHeight = `${paneHeight}px`;
    pane.style.width = `${paneWidth}px`; pane.style.height = `${paneHeight}px`; pane.style.top = `${area.top + 6}px`; pane.style.right = 'auto';
    elementPane.style.width = `${Math.max(300, area.width - paneWidth - gap)}px`;
    if (state.photo.dockMode === 'left') {
      pane.style.left = `${area.left + 6}px`;
      elementPane.style.marginLeft = `${paneWidth + gap}px`;
    } else pane.style.left = `${area.right - paneWidth - 6}px`;
    divider.style.top = `${area.top + 6}px`; divider.style.height = `${paneHeight}px`;
    divider.style.left = `${state.photo.dockMode === 'left' ? area.left + paneWidth + 1 : area.right - paneWidth - 7}px`;
  }
  function showPhotoPanel(render = true) {
    const wasHidden = $('photoPane').classList.contains('hiddenPanel');
    $('photoPane').classList.remove('hiddenPanel');
    requestAnimationFrame(() => placePhotoPaneInViewer(wasHidden));
    if (render) setTimeout(() => renderSide('photo'), 30);
  }
  function hidePhotoPanel() { $('photoPane').classList.add('hiddenPanel'); applyPhotoDockLayout(); }
  async function jumpToDamage(raw, requestedSpan = null) {
    const elementViewBeforePhoto = captureElementView();
    const numbers = (Array.isArray(raw) ? raw : [raw])
      .map(value => String(Number(normalizeDigits(String(value)).replace(/\D/g, ''))))
      .filter(number => number && number !== 'NaN');
    if (!numbers.length) return;
    const number = numbers[0];
    $('damageInput').value = numbers.map(value => value.padStart(2, '0')).join(',');
    document.querySelectorAll('#elementViewer .hotspot').forEach(hotspot => {
      hotspot.classList.toggle('selected', numbers.some(value => damageNumbers(hotspot.dataset.label || '').includes(value)));
    });
    if (!state.photo.doc) { showPhotoPanel(false); $('matchStatus').textContent = '先に損傷写真PDFを選択してください'; await restoreElementView(elementViewBeforePhoto); return; }
    const currentSpan = requestedSpan === null
      ? String(state.elementSpanNumbers.get(state.element.page) || '')
      : normalizeDigits(String(requestedSpan)).replace(/[^0-9A-Za-z_-]/g, '');
    $('photoSpanInput').value = currentSpan;
    focusAssessmentRows(numbers, currentSpan);
    const combinedEntries = numbers.flatMap(value => (state.photoIndex.get(value) || [])
      .filter(entry => !currentSpan || !entry.record?.spanNumber || String(entry.record.spanNumber) === currentSpan)
      .map(entry => ({ ...entry, damageNumber: value })));
    // A single photo record may be indexed under every number in a grouped
    // label such as 27,28. Display that physical record only once.
    const indexedEntries = [...new Map(combinedEntries.map(entry => [`${entry.page}:${entry.focus.column}:${entry.focus.row}`, entry])).values()];
    if (!indexedEntries.length) { showPhotoPanel(false); $('matchStatus').textContent = `${numbers.map(value => `損傷${value.padStart(2, '0')}`).join('・')}が見つかりません`; await restoreElementView(elementViewBeforePhoto); return; }
    const photoNumberValue = entry => {
      const digits = normalizeDigits(String(entry.record?.photoNumber || '')).match(/\d+/)?.[0];
      return digits ? Number(digits) : Number.POSITIVE_INFINITY;
    };
    const entries = [...indexedEntries].sort((a, b) =>
      photoNumberValue(a) - photoNumberValue(b) || a.page - b.page || a.focus.row - b.focus.row || a.focus.column - b.focus.column);
    state.photo.page = entries[0].page;
    state.photo.focus = entries[0].focus;
    state.photo.matches = entries;
    state.photo.pageOverview = false;
    state.photo.fitPaneAfterRender = false;
    $('photoPageView').disabled = false;
    $('photoPageView').textContent = 'ページ全体';
    const pane = $('photoPane');
    pane.classList.toggle('photoCountOne', entries.length === 1);
    pane.classList.toggle('photoCountTwo', entries.length === 2);
    pane.classList.toggle('photoCountMany', entries.length > 2);
    // Keep the user's chosen width. renderPhotoMatches adjusts only height so
    // the stacked records fit without a large blank area below them.
    pane.classList.add('preparing');
    state.currentDamage = {
      damageNumber: number,
      spanNumber: currentSpan,
      elementPage: state.element.page,
      records: entries.map(entry => {
        const entryNumber = entry.damageNumber || number;
        const record = { ...(entry.record || { damageNumber: entryNumber, pageNumber: entry.page }) };
        const assessment = assessmentFor(entryNumber, record);
        if (assessment) {
          for (const key of ['spanNumber', 'memberName', 'memberSymbol', 'memberNumber', 'damageType', 'damagePattern', 'classification', 'damageLevel', 'diagnosis']) if (assessment[key]) record[key] = assessment[key];
          if (assessment.comment) record.memo = assessment.comment;
          record.assessmentPage = assessment.pageNumber;
        }
        return record;
      })
    };
    state.photo.zoom = 1;
    $('matchStatus').textContent = '';
    showPhotoPanel(false);
    try {
      await renderSide('photo');
      placePhotoPaneInViewer(false);
      await restoreElementView(elementViewBeforePhoto);
    } finally {
      pane.classList.remove('preparing');
    }
  }
  function bindPager(side) {
    const move = (delta) => {
      state[side].page += delta;
      state[side].focus = null;
      state[side].matches = null;
      if (side === 'photo') { state.photo.pageOverview = false; $('photoPageView').disabled = true; $('photoPageView').textContent = 'ページ全体'; }
      state[side].zoom = 1;
      renderSide(side);
    };
    $(side + 'Prev').addEventListener('click', () => move(-1));
    $(side + 'Next').addEventListener('click', () => move(1));
  }
  function bindZoom(side) {
    const change = (factor) => {
      state[side].zoom = Math.max(MIN_PDF_ZOOM, Math.min(MAX_PDF_ZOOM, state[side].zoom * factor));
      renderSide(side);
    };
    $(side + 'ZoomOut').addEventListener('click', () => change(1 / 1.25));
    $(side + 'ZoomIn').addEventListener('click', () => change(1.25));
    $(side + 'Fit').addEventListener('click', () => {
      state[side].zoom = 1;
      if (side === 'photo') { state.photo.focus = null; state.photo.matches = null; state.photo.pageOverview = false; $('photoPageView').disabled = true; $('photoPageView').textContent = 'ページ全体'; }
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
    let panStart = null;
    viewer.addEventListener('pointerdown', event => {
      const temporaryPan = event.button === 1;
      if (!temporaryPan && !(state.drawMode === 'pan' && state.drawingSide === side)) return;
      panStart = { x: event.clientX, y: event.clientY, left: viewer.scrollLeft, top: viewer.scrollTop, pointerId: event.pointerId };
      viewer.setPointerCapture(event.pointerId); viewer.classList.add('panning');
      event.preventDefault(); event.stopPropagation();
    }, true);
    viewer.addEventListener('pointermove', event => {
      if (!panStart || event.pointerId !== panStart.pointerId) return;
      viewer.scrollLeft = panStart.left - (event.clientX - panStart.x);
      viewer.scrollTop = panStart.top - (event.clientY - panStart.y);
      event.preventDefault(); event.stopPropagation();
    }, true);
    const finishPan = event => {
      if (!panStart || event.pointerId !== panStart.pointerId) return;
      panStart = null; viewer.classList.remove('panning');
      if (viewer.hasPointerCapture(event.pointerId)) viewer.releasePointerCapture(event.pointerId);
      event.preventDefault(); event.stopPropagation();
    };
    viewer.addEventListener('pointerup', finishPan, true);
    viewer.addEventListener('pointercancel', finishPan, true);
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
      const viewerRect = viewer.getBoundingClientRect();
      return {
        index,
        viewerX: clientX - viewerRect.left,
        viewerY: clientY - viewerRect.top,
        xRatio: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
        yRatio: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
      };
    };
    const restoreAnchor = async anchor => {
      if (!anchor) return;
      const page = viewer.querySelectorAll('.pageWrap')[anchor.index];
      if (!page) return;
      // Restore by content coordinates rather than viewport deltas. The page
      // is horizontally centred while it is narrower than the viewer, so its
      // screen rect changes discontinuously as zoom crosses that boundary.
      const contentX = page.offsetLeft + page.offsetWidth * anchor.xRatio;
      const contentY = page.offsetTop + page.offsetHeight * anchor.yRatio;
      viewer.scrollLeft = Math.max(0, contentX - anchor.viewerX);
      viewer.scrollTop = Math.max(0, contentY - anchor.viewerY);
      // Canvas, margins and scroll bounds may settle on separate frames.
      // Measure the real point under the cursor and remove any residual drift.
      for (let pass = 0; pass < 3; pass++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const currentPage = viewer.querySelectorAll('.pageWrap')[anchor.index];
        if (!currentPage) break;
        const rect = currentPage.getBoundingClientRect();
        const viewerRect = viewer.getBoundingClientRect();
        const wantedX = viewerRect.left + anchor.viewerX;
        const wantedY = viewerRect.top + anchor.viewerY;
        const actualX = rect.left + rect.width * anchor.xRatio;
        const actualY = rect.top + rect.height * anchor.yRatio;
        viewer.scrollLeft += actualX - wantedX;
        viewer.scrollTop += actualY - wantedY;
      }
    };
    const afterLayout = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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
      const nextZoom = Math.max(MIN_PDF_ZOOM, Math.min(MAX_PDF_ZOOM, pinchStartZoom * distance(event.touches) / pinchStartDistance));
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
      await afterLayout();
      await restoreAnchor(pinchAnchor);
      pinchAnchor = null;
    };
    viewer.addEventListener('touchend', finishPinch, { passive: true });
    viewer.addEventListener('touchcancel', finishPinch, { passive: true });
    viewer.addEventListener('wheel', event => {
      if (!target.doc) return;
      event.preventDefault();
      const anchor = captureAnchor(event.clientX, event.clientY);
      const factor = Math.exp(-event.deltaY * .0015);
      target.zoom = Math.max(MIN_PDF_ZOOM, Math.min(MAX_PDF_ZOOM, target.zoom * factor));
      $(side + 'ZoomLabel').textContent = `${Math.round(target.zoom * 100)}%`;
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(async () => {
        await renderSide(side);
        await afterLayout();
        await restoreAnchor(anchor);
      }, 90);
    }, { passive: false });
    viewer.addEventListener('dblclick', async event => {
      if (!target.doc) return;
      const anchor = captureAnchor(event.clientX, event.clientY);
      target.zoom = target.zoom > 1.05 ? 1 : 2.5;
      await renderSide(side);
      await afterLayout();
      await restoreAnchor(anchor);
      event.preventDefault();
    });
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
  async function copyElementScreenArea(wrap, x1, y1, x2, y2) {
    const canvas = wrap.querySelector('canvas');
    if (!canvas || Math.abs(x2 - x1) < 3 || Math.abs(y2 - y1) < 3) return;
    const sx = Math.floor(Math.min(x1, x2) / 1000 * canvas.width), sy = Math.floor(Math.min(y1, y2) / 1000 * canvas.height);
    const sw = Math.max(1, Math.floor(Math.abs(x2 - x1) / 1000 * canvas.width)), sh = Math.max(1, Math.floor(Math.abs(y2 - y1) / 1000 * canvas.height));
    const output = document.createElement('canvas'); output.width = sw; output.height = sh;
    output.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    const annotation = wrap.querySelector('.annotationLayer');
    if (annotation) {
      const svgBlob = new Blob([new XMLSerializer().serializeToString(annotation)], { type: 'image/svg+xml' });
      const svgUrl = URL.createObjectURL(svgBlob);
      await new Promise(resolve => {
        const image = new Image();
        image.onload = () => { output.getContext('2d').drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh); URL.revokeObjectURL(svgUrl); resolve(); };
        image.onerror = () => { URL.revokeObjectURL(svgUrl); resolve(); };
        image.src = svgUrl;
      });
    }
    const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('clipboard unavailable');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      $('globalStatus').textContent = '囲んだ範囲を画像としてコピーしました';
    } catch (_) {
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = '点検画面_部分スクショ.png'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      $('globalStatus').textContent = 'コピー非対応のため、囲んだ範囲をPNG保存しました';
    }
  }
  let boxedNumberResolver = null;
  function closeNumberKeypad(value = '') {
    $('numberKeypad').classList.add('hiddenPanel');
    const resolve = boxedNumberResolver; boxedNumberResolver = null;
    if (resolve) resolve(value);
  }
  function requestBoxedNumber() {
    if (boxedNumberResolver) closeNumberKeypad('');
    $('boxedNumberInput').value = '';
    $('numberKeypad').classList.remove('hiddenPanel');
    return new Promise(resolve => { boxedNumberResolver = resolve; });
  }
  function csvCell(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
  const inspectionComment = value => String(value || '').replace(/損傷\s*[0-9０-９]+(?:\s*[,，、・]\s*[0-9０-９]+)*/g, '損傷〇〇');
  function damageListRows() {
    const rows = [];
    let drawingSequence = 0;
    for (const [elementPage, drawings] of state.annotations) {
      for (const drawing of drawings) {
        const info = drawing.damageInfo;
        if (!info) continue;
        drawingSequence++;
        drawing.drawingId ||= String(drawingSequence).padStart(3, '0');
        drawing.inspectionPhotos ||= [];
        while (drawing.inspectionPhotos.length < 4) drawing.inspectionPhotos.push({ number: '', memo: '' });
        const records = info.records?.length ? info.records : [{}];
        for (const record of records) {
          rows.push({
            drawingId: drawing.drawingId,
            elementPage, damageNumber: info.damageNumber || record.damageNumber || '',
            spanNumber: record.spanNumber || '',
            memberName: record.memberName || '', memberSymbol: record.memberSymbol || '', memberNumber: record.memberNumber || '',
            damageType: record.damageType || '', damagePattern: record.damagePattern || '', classification: record.classification || '',
            damageLevel: record.damageLevel || '', diagnosis: record.diagnosis || '', memo: inspectionComment(record.memo),
            photos: drawing.inspectionPhotos, drawing, record, info
          });
        }
      }
    }
    return rows.sort((a, b) =>
      String(a.spanNumber).localeCompare(String(b.spanNumber), 'ja', { numeric: true }) ||
      Number(a.damageNumber) - Number(b.damageNumber) || String(a.drawingId).localeCompare(String(b.drawingId), 'ja', { numeric: true }));
  }
  function updateInspectionResultCell(row, field, entered, photoIndex = null, photoField = '') {
    const value = field === 'memo' ? inspectionComment(entered) : entered.trim();
    if (photoIndex !== null) row.photos[photoIndex][photoField] = value;
    else if (field === 'damageNumber') { row.info.damageNumber = value; row.record.damageNumber = value; }
    else { row.record[field] = value; }
    $('globalStatus').textContent = '点検結果を修正しました';
  }
  function makeResultCellEditable(td, save) {
    td.classList.add('editableResultCell'); td.contentEditable = 'plaintext-only'; td.spellcheck = false; td.title = 'タップして修正';
    td.addEventListener('click', event => event.stopPropagation());
    td.addEventListener('input', () => fitInspectionResultCell(td));
    td.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); td.blur(); } });
    td.addEventListener('blur', () => save(cleanField(td.textContent)));
  }
  function fitInspectionResultCell(td) {
    if (td.querySelector('input')) return;
    td.style.fontSize = '11px';
    for (let size = 10; td.scrollWidth > td.clientWidth && size >= 7; size--) td.style.fontSize = `${size}px`;
    td.title = cleanField(td.textContent) || 'タップして修正';
  }
  function renderDamageList() {
    const rows = damageListRows();
    $('damageListCount').textContent = `${rows.length}件`;
    const body = $('damageListBody'); body.replaceChildren();
    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="20" class="damageListEmpty">損傷番号をタップしてから作図すると、ここに追加されます</td>';
      body.appendChild(tr); return;
    }
    for (const row of rows) {
      const tr = document.createElement('tr');
      const fields = ['drawingId', 'damageNumber', 'spanNumber', 'memberName', 'memberSymbol', 'memberNumber', 'damageType', 'damagePattern', 'classification', 'damageLevel', 'diagnosis', 'memo'];
      for (const field of fields) {
        const td = document.createElement('td'); td.textContent = row[field] || '';
        if (field !== 'drawingId') makeResultCellEditable(td, value => updateInspectionResultCell(row, field, value));
        tr.appendChild(td);
      }
      row.photos.slice(0, 4).forEach((photo, photoIndex) => {
        for (const photoField of ['number', 'memo']) {
          const td = document.createElement('td');
          if (photoField === 'number') {
            const input = document.createElement('input');
            input.className = 'inspectionPhotoNumberInput'; input.type = 'text'; input.inputMode = 'numeric';
            input.pattern = '[0-9]*'; input.value = photo.number || ''; input.placeholder = '番号';
            input.addEventListener('click', event => event.stopPropagation());
            input.addEventListener('input', () => { input.value = normalizeDigits(input.value).replace(/[^0-9]/g, ''); });
            input.addEventListener('change', () => updateInspectionResultCell(row, '', input.value, photoIndex, 'number'));
            input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); } });
            td.appendChild(input);
          } else {
            td.textContent = photo.memo || '';
            makeResultCellEditable(td, value => updateInspectionResultCell(row, '', value, photoIndex, 'memo'));
          }
          tr.appendChild(td);
        }
      });
      tr.addEventListener('click', async () => {
        state.element.page = row.elementPage;
        await renderSide('element');
        if (row.damageNumber) await jumpToDamage(row.damageNumber, row.spanNumber || null);
      });
      body.appendChild(tr);
    }
    requestAnimationFrame(() => body.querySelectorAll('td').forEach(fitInspectionResultCell));
  }
  function placeDamageListInViewer(reset = false) {
    const pane = $('damageListPane'), viewer = $('elementViewer');
    const area = viewer.getBoundingClientRect();
    if (!area.width || !area.height) return;
    const width = Math.min(reset ? area.width - 16 : pane.offsetWidth, area.width - 16, 1050);
    const height = Math.min(reset ? Math.max(170, area.height * .42) : pane.offsetHeight, area.height - 16, 390);
    pane.style.width = `${Math.max(280, width)}px`; pane.style.height = `${Math.max(150, height)}px`;
    if (reset) { pane.style.left = `${area.left + 8}px`; pane.style.top = `${area.top + 8}px`; }
    else {
      pane.style.left = `${Math.max(area.left, Math.min(parseFloat(pane.style.left) || area.left + 8, area.right - pane.offsetWidth))}px`;
      pane.style.top = `${Math.max(area.top, Math.min(parseFloat(pane.style.top) || area.top + 8, area.bottom - pane.offsetHeight))}px`;
    }
  }
  const refitAfterTopPanelChange = () => requestAnimationFrame(async () => {
    await renderElementPreservingView();
    if (!$('photoPane').classList.contains('hiddenPanel')) placePhotoPaneInViewer(false);
  });
  function showDamageList() {
    renderDamageList();
    const pane = $('damageListPane'); pane.classList.add('topDocked'); pane.classList.remove('hiddenPanel');
    pane.style.removeProperty('left'); pane.style.removeProperty('top'); pane.style.removeProperty('width');
    refitAfterTopPanelChange();
  }
  function hideDamageList() { $('damageListPane').classList.add('hiddenPanel'); refitAfterTopPanelChange(); }
  function exportDrawingCsv() {
    const header = ['作図ID','損傷ID','径間番号','部材名称','記号','要素番号','損傷の種類','損傷パターン','分類','損傷程度の評価','健全性の診断結果','コメント','写真1番号','写真1メモ','写真2番号','写真2メモ','写真3番号','写真3メモ','写真4番号','写真4メモ'];
    const rows = [header];
    for (const row of damageListRows()) rows.push([
      row.drawingId, row.damageNumber, row.spanNumber, row.memberName, row.memberSymbol, row.memberNumber,
      row.damageType, row.damagePattern, row.classification, row.damageLevel, row.diagnosis, row.memo,
      row.photos[0].number, row.photos[0].memo, row.photos[1].number, row.photos[1].memo,
      row.photos[2].number, row.photos[2].memo, row.photos[3].number, row.photos[3].memo
    ]);
    if (rows.length === 1) { $('globalStatus').textContent = '損傷情報を付与した作図がありません'; return; }
    const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = '点検結果一覧表.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('globalStatus').textContent = '作図に付与した損傷情報をCSV保存しました';
  }
  $('pastDataFiles').addEventListener('change', e => e.target.files.length && loadPastData(e.target.files));
  const jumpFromPhotoInputs = () => jumpToDamage($('damageInput').value, $('photoSpanInput').value);
  $('damageJump').addEventListener('click', jumpFromPhotoInputs);
  $('damageInput').addEventListener('keydown', e => { if (e.key === 'Enter') jumpFromPhotoInputs(); });
  $('photoSpanInput').addEventListener('keydown', e => { if (e.key === 'Enter') jumpFromPhotoInputs(); });
  $('drawingCsv').addEventListener('click', exportDrawingCsv);
  $('damageListCsv').addEventListener('click', exportDrawingCsv);
  $('topDamageList').addEventListener('click', showDamageList);
  $('damageListClose').addEventListener('click', hideDamageList);
  $('recognitionResults').addEventListener('click', () => { renderRecognitionResults(); $('recognitionResultPane').classList.remove('hiddenPanel'); });
  $('recognitionResultClose').addEventListener('click', () => $('recognitionResultPane').classList.add('hiddenPanel'));
  $('addHotspot').addEventListener('click', () => {
    $('addHotspotSpan').value = String(state.elementSpanNumbers.get(state.element.page) || $('photoSpanInput').value || '');
    $('addHotspotNumber').value = '';
    $('hotspotAddDialog').classList.remove('hiddenPanel');
    $('addHotspotNumber').focus();
  });
  $('addHotspotCancel').addEventListener('click', () => $('hotspotAddDialog').classList.add('hiddenPanel'));
  $('addHotspotStart').addEventListener('click', () => {
    const spanNumber = normalizeDigits($('addHotspotSpan').value).replace(/[^0-9A-Za-z_-]/g, '');
    const numbers = [...new Set((normalizeDigits($('addHotspotNumber').value).match(/\d+/g) || [])
      .map(value => String(Number(value))).filter(value => value !== 'NaN'))];
    if (!spanNumber || !numbers.length) {
      $('globalStatus').textContent = '径間番号と損傷番号を入力してください';
      return;
    }
    state.pendingManualDamage = { number: numbers[0], numbers, page: state.element.page, spanNumber };
    state.drawMode = 'select';
    $('manualPlacementLabel').textContent = `設定中：${spanNumber}径間・${numbers.map(number => `損傷${formatDamageNumber(number)}`).join('・')}`;
    $('hotspotAddDialog').classList.add('hiddenPanel');
    $('manualPlacementBanner').classList.remove('hiddenPanel');
    $('globalStatus').textContent = '要素番号図上でオレンジ枠を置く位置をタップしてください';
  });
  $('hotspotEditMode').addEventListener('click', event => {
    state.hotspotEditMode = !state.hotspotEditMode;
    event.currentTarget.setAttribute('aria-pressed', String(state.hotspotEditMode));
    event.currentTarget.textContent = state.hotspotEditMode ? '枠編集：入' : '枠編集';
    if (!state.hotspotEditMode) closeHotspotEditor();
    $('globalStatus').textContent = state.hotspotEditMode
      ? '編集するオレンジ枠をタップしてください。枠はそのままドラッグ移動できます'
      : 'オレンジ枠の編集を終了しました';
  });
  $('hotspotEditorClose').addEventListener('click', closeHotspotEditor);
  $('hotspotNumberSave').addEventListener('click', saveHotspotNumberEdit);
  $('hotspotDelete').addEventListener('click', deleteEditedHotspot);
  $('hotspotNumberInput').addEventListener('keydown', event => { if (event.key === 'Enter') saveHotspotNumberEdit(); });
  $('manualPlacementCancel').addEventListener('click', () => {
    state.pendingManualDamage = null;
    $('manualPlacementBanner').classList.add('hiddenPanel');
    $('globalStatus').textContent = '損傷番号の手動設定をキャンセルしました';
  });
  $('elementViewer').addEventListener('click', async event => {
    const pending = state.pendingManualDamage;
    if (!pending) return;
    const wrap = event.target.closest('.pageWrap'); if (!wrap) return;
    const placementPage = state.element.page;
    const rect = wrap.getBoundingClientRect();
    const selectedHotspot = event.target.closest('.hotspot');
    let x = (event.clientX - rect.left) / rect.width * 1000, y = (event.clientY - rect.top) / rect.height * 1000;
    let numbers = (pending.numbers || [pending.number]).map(String);
    if (selectedHotspot) {
      const existing = (selectedHotspot.dataset.numbers || '').split(',').filter(Boolean);
      const existingLabel = existing.map(number => `損傷${formatDamageNumber(number)}`).join('・');
      if (existing.length && window.confirm(`${existingLabel}と損傷${formatDamageNumber(pending.number)}を同じオレンジ枠に合わせますか？`)) {
        numbers = [...new Set([...existing, String(pending.number)])].sort((a, b) => Number(a) - Number(b));
        x = (selectedHotspot.offsetLeft + selectedHotspot.offsetWidth / 2) / rect.width * 1000;
        y = (selectedHotspot.offsetTop + selectedHotspot.offsetHeight / 2) / rect.height * 1000;
      }
    }
    const point = { number: numbers[0], numbers, spanNumber: pending.spanNumber || state.elementSpanNumbers.get(placementPage) || '', x, y };
    const entries = (state.manualHotspots.get(placementPage) || []).filter(item => !(item.numbers || [item.number]).some(number => numbers.includes(String(number))));
    entries.push(point); state.manualHotspots.set(placementPage, entries);
    state.pendingManualDamage = null; $('manualPlacementBanner').classList.add('hiddenPanel'); auditRecognizedDamageNumbers(); await renderSide('element');
    $('globalStatus').textContent = `${numbers.map(number => `損傷${formatDamageNumber(number)}`).join('・')}を手動設定しました`;
  });
  let damageListDrag = null;
  $('damageListPane').querySelector('.damageListHeader').addEventListener('pointerdown', event => {
    if (event.target.closest('button') || $('damageListPane').classList.contains('topDocked')) return;
    const pane = $('damageListPane'); const rect = pane.getBoundingClientRect();
    damageListDrag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
  });
  $('damageListPane').querySelector('.damageListHeader').addEventListener('pointermove', event => {
    if (!damageListDrag) return;
    const pane = $('damageListPane'), area = $('elementViewer').getBoundingClientRect();
    const left = Math.max(area.left, Math.min(area.right - pane.offsetWidth, damageListDrag.left + event.clientX - damageListDrag.x));
    const top = Math.max(area.top, Math.min(area.bottom - pane.offsetHeight, damageListDrag.top + event.clientY - damageListDrag.y));
    pane.style.left = `${left}px`; pane.style.top = `${top}px`; event.preventDefault();
  });
  const finishDamageListDrag = () => { damageListDrag = null; };
  $('damageListPane').querySelector('.damageListHeader').addEventListener('pointerup', finishDamageListDrag);
  $('damageListPane').querySelector('.damageListHeader').addEventListener('pointercancel', finishDamageListDrag);
  let damageListResize = null;
  $('damageListResize').addEventListener('pointerdown', event => {
    const rect = $('damageListPane').getBoundingClientRect();
    damageListResize = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation();
  });
  $('damageListResize').addEventListener('pointermove', event => {
    if (!damageListResize) return;
    const pane = $('damageListPane'), area = $('elementViewer').getBoundingClientRect();
    if (pane.classList.contains('topDocked')) {
      pane.style.height = `${Math.max(72, Math.min(innerHeight * .45, damageListResize.height + event.clientY - damageListResize.y))}px`;
      pane.style.flexBasis = pane.style.height;
      event.preventDefault(); return;
    }
    pane.style.width = `${Math.max(280, Math.min(area.right - pane.offsetLeft, damageListResize.width + event.clientX - damageListResize.x))}px`;
    pane.style.height = `${Math.max(150, Math.min(area.bottom - pane.offsetTop, damageListResize.height + event.clientY - damageListResize.y))}px`;
    event.preventDefault();
  });
  const finishDamageListResize = () => { if (damageListResize) refitAfterTopPanelChange(); damageListResize = null; };
  $('damageListResize').addEventListener('pointerup', finishDamageListResize);
  $('damageListResize').addEventListener('pointercancel', finishDamageListResize);
  window.addEventListener('resize', () => {
    if (!$('damageListPane').classList.contains('hiddenPanel') && !$('damageListPane').classList.contains('topDocked')) placeDamageListInViewer(false);
    if (!$('photoPane').classList.contains('hiddenPanel')) placePhotoPaneInViewer(false);
  });
  const mainWorkArea = document.querySelector('main');
  document.body.insertBefore($('assessmentListPane'), mainWorkArea);
  document.body.insertBefore($('damageListPane'), mainWorkArea);
  $('assessmentListPane').classList.add('topDocked');
  $('damageListPane').classList.add('topDocked');
  const bindTopPanelHeight = (pane, handle) => {
    let resize = null;
    handle.addEventListener('pointerdown', event => {
      const rect = pane.getBoundingClientRect(); resize = { y: event.clientY, height: rect.height, pointerId: event.pointerId };
      handle.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation();
    });
    handle.addEventListener('pointermove', event => {
      if (!resize || event.pointerId !== resize.pointerId) return;
      const height = Math.max(72, Math.min(innerHeight * .45, resize.height + event.clientY - resize.y));
      pane.style.height = `${height}px`; pane.style.flexBasis = `${height}px`; event.preventDefault();
    });
    const finish = event => { if (resize && event.pointerId === resize.pointerId) { resize = null; refitAfterTopPanelChange(); } };
    handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
  };
  bindTopPanelHeight($('assessmentListPane'), $('assessmentListResize'));
  $('showAssessmentList').addEventListener('click', () => { renderAssessmentList(); $('assessmentListPane').classList.remove('hiddenPanel'); refitAfterTopPanelChange(); });
  $('assessmentListClose').addEventListener('click', () => { $('assessmentListPane').classList.add('hiddenPanel'); refitAfterTopPanelChange(); });
  $('drawingInfoClose').addEventListener('click', closeDrawingRegistration);
  $('drawingInfoNone').addEventListener('click', () => {
    if (pendingDrawingRegistration) pendingDrawingRegistration.damageInfo = null;
    closeDrawingRegistration();
    if (!$('damageListPane').classList.contains('hiddenPanel')) renderDamageList();
    $('globalStatus').textContent = '作図を情報なしで登録しました';
  });
  document.querySelectorAll('[data-draw-color]').forEach(button => button.addEventListener('click', () => {
    $('drawColor').value = button.dataset.drawColor;
    document.querySelectorAll('[data-draw-color]').forEach(item => item.classList.toggle('active', item === button));
  }));
  $('insertImageButton').addEventListener('click', () => $('insertImageFile').click());
  $('insertImageFile').addEventListener('change', event => {
    const file = event.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.pendingImage = String(reader.result || ''); state.drawMode = 'image';
      document.querySelectorAll('[data-draw]').forEach(item => item.classList.remove('active'));
      $('insertImageButton').classList.add('active');
      const viewer = state.drawingSide === 'photo' ? $('photoViewer') : $('elementViewer');
      const layer = viewer.querySelector('.annotationLayer'); if (layer) layer.classList.add('drawing');
      $('globalStatus').textContent = '画像を配置する範囲をドラッグしてください';
    };
    reader.readAsDataURL(file); event.target.value = '';
  });
  document.querySelectorAll('[data-number-key]').forEach(button => button.addEventListener('click', () => {
    const input = $('boxedNumberInput'); const key = button.dataset.numberKey;
    if (key === 'back') input.value = input.value.slice(0, -1);
    else if (input.value.length < 16) input.value += key;
  }));
  $('numberKeypadCancel').addEventListener('click', () => closeNumberKeypad(''));
  $('numberKeypadOk').addEventListener('click', () => {
    const value = $('boxedNumberInput').value.replace(/－+/g, '－').replace(/^－|－$/g, '');
    if (value) closeNumberKeypad(value);
  });
  $('elementColorToggle').addEventListener('click', event => {
    const modes = ['color', 'monochrome', 'faded'];
    const current = event.currentTarget.dataset.displayMode || 'color';
    const next = modes[(modes.indexOf(current) + 1) % modes.length];
    event.currentTarget.dataset.displayMode = next;
    state.element.viewer.classList.toggle('monochrome', next === 'monochrome');
    state.element.viewer.classList.toggle('fadedPdf', next === 'faded');
    const labels = { color: '表示：カラー', monochrome: '表示：モノクロ', faded: '表示：薄いグレー' };
    const statuses = { color: '元PDFをカラー表示にしました', monochrome: '元PDFをモノクロ表示にしました', faded: '元PDFを薄いグレーで表示しています' };
    event.currentTarget.textContent = labels[next];
    $('globalStatus').textContent = statuses[next];
  });
  $('topPhotoToggle').addEventListener('click', showPhotoPanel);
  $('photoClose').addEventListener('click', hidePhotoPanel);
  $('photoPageView').addEventListener('click', async event => {
    if (!state.photo.matches?.length) return;
    state.photo.pageOverview = !state.photo.pageOverview;
    state.photo.zoom = 1;
    state.photo.page = state.photo.matches[0].page;
    state.photo.focus = state.photo.pageOverview ? null : state.photo.matches[0].focus;
    event.currentTarget.textContent = state.photo.pageOverview ? '該当写真へ戻る' : 'ページ全体';
    $('matchStatus').textContent = '';
    await renderSide('photo');
  });
  $('photoMaximize').addEventListener('click', async event => {
    const maximized = $('photoPane').classList.toggle('maximized');
    applyPhotoDockLayout();
    // Wait until the element pane has regained the full work-area width,
    // then calculate the maximized photo bounds from that final layout.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    placePhotoPaneInViewer(false);
    event.currentTarget.setAttribute('aria-pressed', String(maximized));
    event.currentTarget.textContent = maximized ? '元サイズ' : '最大化';
    await renderElementPreservingView();
    await renderSide('photo');
  });
  $('photoDockMode').addEventListener('click', async event => {
    const modes = ['free', 'right', 'left'];
    state.photo.dockMode = modes[(modes.indexOf(state.photo.dockMode) + 1) % modes.length];
    event.currentTarget.textContent = ({ free: '位置：フリー', right: '位置：右', left: '位置：左' })[state.photo.dockMode];
    applyPhotoDockLayout();
    await renderElementPreservingView();
    await renderSide('photo');
  });
  let photoDividerDrag = null;
  $('photoDockDivider').addEventListener('pointerdown', event => {
    if (state.photo.dockMode === 'free') return;
    photoDividerDrag = { pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add('dragging');
    event.preventDefault();
  });
  $('photoDockDivider').addEventListener('pointermove', event => {
    if (!photoDividerDrag) return;
    const area = document.querySelector('main').getBoundingClientRect();
    const width = state.photo.dockMode === 'left' ? event.clientX - area.left : area.right - event.clientX;
    $('photoPane').style.width = `${Math.max(320, Math.min(area.width - 320, width))}px`;
    applyPhotoDockLayout();
    event.preventDefault();
  });
  const finishPhotoDividerDrag = async event => {
    if (!photoDividerDrag) return;
    photoDividerDrag = null; event.currentTarget.classList.remove('dragging');
    await renderElementPreservingView(); await renderSide('photo');
  };
  $('photoDockDivider').addEventListener('pointerup', finishPhotoDividerDrag);
  $('photoDockDivider').addEventListener('pointercancel', finishPhotoDividerDrag);
  let photoDrag = null;
  $('photoPane').querySelector('.paneHeader').addEventListener('pointerdown', event => {
    if (!$('photoPane').classList.contains('floating') || state.photo.dockMode !== 'free' || event.target.closest('button, label, input')) return;
    const rect = $('photoPane').getBoundingClientRect();
    photoDrag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  });
  $('photoPane').querySelector('.paneHeader').addEventListener('pointermove', event => {
    if (!photoDrag) return;
    const pane = $('photoPane'), area = $('elementViewer').getBoundingClientRect();
    pane.style.left = `${Math.max(area.left, Math.min(area.right - pane.offsetWidth, photoDrag.left + event.clientX - photoDrag.x))}px`;
    pane.style.top = `${Math.max(area.top, Math.min(area.bottom - pane.offsetHeight, photoDrag.top + event.clientY - photoDrag.y))}px`;
    pane.style.right = 'auto';
  });
  $('photoPane').querySelector('.paneHeader').addEventListener('pointerup', () => { photoDrag = null; });
  let photoResizeTimer = 0;
  let lastPhotoPaneSize = '';
  const photoResizeObserver = new ResizeObserver(entries => {
    const rect = entries[0]?.contentRect;
    if (!rect || $('photoPane').classList.contains('hiddenPanel') || !state.photo.doc) return;
    if ($('photoPane').dataset.autoHeight === 'true') {
      delete $('photoPane').dataset.autoHeight;
      lastPhotoPaneSize = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
      return;
    }
    const sizeKey = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
    if (sizeKey === lastPhotoPaneSize) return;
    lastPhotoPaneSize = sizeKey;
    clearTimeout(photoResizeTimer);
    // Refit after the user pauses resizing so canvas rendering does not fight
    // the resize handle. The current photo zoom is retained.
    state.photo.keepPaneHeight = true;
    photoResizeTimer = setTimeout(() => {
      if (state.photo.dockMode !== 'free') { applyPhotoDockLayout(); renderElementPreservingView(); }
      renderSide('photo');
    }, 120);
  });
  photoResizeObserver.observe($('photoPane'));
  function setDrawingSide(side) {
    state.drawingSide = side;
    $('drawTargetElement').classList.toggle('active', side === 'element');
    $('drawTargetPhoto').classList.toggle('active', side === 'photo');
    document.querySelectorAll('#elementViewer .annotationLayer').forEach(layer => layer.classList.toggle('drawing', side === 'element' && !['select', 'pan'].includes(state.drawMode)));
    document.querySelectorAll('#photoViewer .annotationLayer').forEach(layer => layer.classList.toggle('drawing', side === 'photo' && !['select', 'pan'].includes(state.drawMode)));
    document.querySelectorAll('#elementViewer .annotationLayer').forEach(layer => layer.classList.toggle('selecting', side === 'element' && state.drawMode === 'select' && !$('commonDrawTools').classList.contains('hiddenPanel')));
    document.querySelectorAll('#photoViewer .annotationLayer').forEach(layer => layer.classList.toggle('selecting', side === 'photo' && state.drawMode === 'select' && !$('commonDrawTools').classList.contains('hiddenPanel')));
    $('globalStatus').textContent = `作図先：${side === 'photo' ? '損傷写真' : '要素番号図'}`;
  }
  $('drawTargetElement').addEventListener('click', () => setDrawingSide('element'));
  $('drawTargetPhoto').addEventListener('click', () => {
    if ($('photoPane').classList.contains('hiddenPanel')) $('topPhotoToggle').click();
    setDrawingSide('photo');
  });
  $('elementViewer').addEventListener('pointerdown', () => setDrawingSide('element'), true);
  $('photoViewer').addEventListener('pointerdown', () => setDrawingSide('photo'), true);
  $('annotationCopy').addEventListener('click', () => {
    if (!state.selectedAnnotation) return;
    state.annotationCopyArmed = true;
    $('annotationMiniMenu').classList.add('hiddenPanel');
    document.querySelectorAll('.selectionControls').forEach(item => item.remove());
    $('globalStatus').textContent = 'コピーの貼り付け位置を図面上でタップしてください';
  });
  const resizeSelectedAnnotations = async factor => {
    const selected = state.selectedAnnotation; if (!selected) return;
    const selections = selected.selections || [selected];
    const items = selections.map(selection => annotationList(selection.key, selection.side)[selection.index]).filter(Boolean);
    if (!items.length) return;
    for (const item of items) removeMirroredPhotoAnnotation(selected.key, item.id);
    scaleAnnotations(items, factor);
    if (selected.side === 'photo') for (const item of items) mirrorPhotoRecordAnnotation(selected.wrap, selected.key, item);
    await renderSide(selected.side);
    const svg = [...document.querySelectorAll('.annotationLayer')].find(layer => layer.dataset.annotationSide === selected.side && layer.dataset.annotationKey === String(selected.key));
    if (svg) {
      const restored = selections.map(selection => ({ ...selection, wrap: svg.closest('.pageWrap') }));
      const nodes = restored.map(selection => svg.querySelector(`[data-annotation-index="${selection.index}"]`)).filter(Boolean);
      state.selectedAnnotation = { ...selected, wrap: svg.closest('.pageWrap'), selections: restored };
      nodes.forEach(node => node.classList.add('selectedAnnotation'));
      addSelectionControls(svg, nodes, restored);
    }
    $('globalStatus').textContent = `${items.length}個の作図を${factor > 1 ? '拡大' : '縮小'}しました（続けて変更できます）`;
  };
  $('annotationShrink').addEventListener('click', () => resizeSelectedAnnotations(.8));
  $('annotationGrow').addEventListener('click', () => resizeSelectedAnnotations(1.25));
  $('annotationDelete').addEventListener('click', () => {
    const selected = state.selectedAnnotation; if (!selected) return;
    const selections = selected.selections || [selected];
    const grouped = new Map();
    for (const selection of selections) {
      const groupKey = `${selection.side}|${selection.key}`;
      if (!grouped.has(groupKey)) grouped.set(groupKey, { ...selection, indexes: [] });
      grouped.get(groupKey).indexes.push(selection.index);
    }
    for (const group of grouped.values()) {
      const items = annotationList(group.key, group.side);
      for (const index of group.indexes.sort((a, b) => b - a)) {
        const item = items[index]; if (!item) continue;
        removeMirroredPhotoAnnotation(group.key, item.id); items.splice(index, 1);
      }
    }
    $('annotationMiniMenu').classList.add('hiddenPanel'); state.selectedAnnotation = null;
    renderSide(selected.side);
    if (selected.side === 'element' && !$('damageListPane').classList.contains('hiddenPanel')) renderDamageList();
    $('globalStatus').textContent = `${selections.length}個の作図を消去しました`;
  });
  document.addEventListener('pointerdown', event => {
    if (event.target.closest('#annotationMiniMenu, .selectableAnnotation, .selectionControls, .zoomBar')) return;
    if (!state.annotationCopyArmed) {
      $('annotationMiniMenu').classList.add('hiddenPanel');
      state.selectedAnnotation = null;
      document.querySelectorAll('.selectedAnnotation').forEach(item => item.classList.remove('selectedAnnotation'));
      document.querySelectorAll('.selectionControls').forEach(item => item.remove());
    }
  });
  $('topDrawToggle').addEventListener('click', event => {
    const tools = $('commonDrawTools');
    const closing = !tools.classList.contains('hiddenPanel');
    tools.classList.toggle('hiddenPanel', closing);
    event.currentTarget.classList.toggle('active', !closing);
    event.currentTarget.textContent = closing ? '作図' : '作図終了';
    if (closing) {
      state.drawMode = 'select';
      document.querySelectorAll('[data-draw]').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.annotationLayer').forEach(layer => layer.classList.remove('drawing'));
    }
    setTimeout(async () => {
      // Opening the common command row moves the work area downward. Refit
      // the photo pane after that layout settles so it never covers commands.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!$('photoPane').classList.contains('hiddenPanel')) placePhotoPaneInViewer(false);
      await renderElementPreservingView();
      await renderSide('photo');
    }, 30);
  });
  document.querySelectorAll('[data-draw]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.draw === 'undo') {
      const key = state.drawingSide === 'photo'
        ? (state.activePhotoAnnotationKey || [...state.photoAnnotations.keys()].at(-1))
        : state.element.page;
      const items = key ? annotationList(key, state.drawingSide) : [];
      if (items.length) {
        items.pop();
        const match = String(key).match(/^record:(\d+):/);
        if (match) {
          const overview = annotationList(`overview:${match[1]}`, 'photo');
          const mirroredIndex = overview.findLastIndex(item => item.sourceRecordKey === key);
          if (mirroredIndex >= 0) overview.splice(mirroredIndex, 1);
        }
      }
      renderSide(state.drawingSide);
      if (state.drawingSide === 'element' && !$('damageListPane').classList.contains('hiddenPanel')) renderDamageList();
      $('globalStatus').textContent = '最後の作図を戻しました';
      return;
    }
    if (button.dataset.draw === 'pan') {
      state.drawMode = state.drawMode === 'pan' ? (state.previousDrawMode || 'free') : (state.previousDrawMode = state.drawMode, 'pan');
    } else {
      state.drawMode = button.dataset.draw;
      if (state.drawMode !== 'select') state.previousDrawMode = state.drawMode;
    }
    document.querySelectorAll('[data-draw]').forEach(item => item.classList.remove('active'));
    const activeButton = document.querySelector(`[data-draw="${state.drawMode}"]`);
    activeButton?.classList.add('active');
    setDrawingSide(state.drawingSide);
    $('globalStatus').textContent = state.drawMode === 'pan'
      ? '画面移動：図面をドラッグしてください（もう一度押すと作図へ戻ります）'
      : `${state.drawingSide === 'photo' ? '損傷写真' : '要素番号図'} 作図：${activeButton?.getAttribute('aria-label') || activeButton?.textContent || ''}`;
  }));
  $('backButton').addEventListener('click', () => { location.href = '../?mode=draw'; });
  const updateNetworkStatus = () => {
    const online = navigator.onLine;
    $('networkStatus').textContent = online ? 'オンライン' : 'オフライン';
    $('networkStatus').classList.toggle('offline', !online);
  };
  addEventListener('online', updateNetworkStatus); addEventListener('offline', updateNetworkStatus); updateNetworkStatus();
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
