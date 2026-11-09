/**
 * Dashboard Kebutuhan RMPM & Perhitungan ITR — Produksi Makassar
 * Terhubung secara real-time dengan Google Sheets menggunakan Google Visualization JSONP API
 */

const MAIN_SPREADSHEET_ID = '1zNqfqYFt4DTstU2AnHJFrkgtBH7Ee1mOqw79pHvUxfQ';
const PRD_STOCK_SPREADSHEET_ID = '1MSUhOmAV1uG4vunKHQ1CW_NYg_8RHBQJBeGuF44rY-Q';

const MONTHS_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

const MONTHS_SHORT_ID = [
  'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
  'Jul', 'Ags', 'Sep', 'Okt', 'Nov', 'Des'
];

// State aplikasi
const state = {
  masterItems: [],       // 70 baris RMPM dari KEBUTUHAN RMPM
  bomList: [],           // Daftar resep dari sheet BOM
  spkData: {             // Data dari sheet SPK PRODUKSI aktif
    dates: [],           // [{ colIndex, isoDate, label, dayStr }]
    variants: []         // [{ name, quantitiesByCol: { [colIndex]: number } }]
  },
  selectedSpkSheet: 'SPK PRODUKSI',
  selectedSpkColIndex: null,
  selectedSpkIsoDate: '',
  simulatedSpkOverrides: {}, // { [variantName]: number } jika user mengubah angka simulasi SPK
  prdStockMap: {},       // { [kodeSap / bahanBaku]: number }
  wrhStockMap: {},       // { [kodeSap / bahanBaku]: number }
  actualOverrides: {},   // Disimpan di localStorage per tanggal
  computedRows: [],      // Hasil kalkulasi lengkap
  activeFilter: 'all',   // 'all' | 'need_itr' | 'safe' | 'wrh_short'
  categoryFilter: 'ALL', // 'ALL' | 'RM' | 'PM' | 'PP' | 'LV' | 'OTHER'
  searchQuery: '',
  sortField: 'default',
  sortAsc: true,
  spkPanelVisible: true
};

// Utilitas JSONP Google Visualization API (Bebas masalah CORS baik di file:// maupun http://)
let jsonpCounter = 0;
function fetchSheetGviz(spreadsheetId, sheetName, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const callbackName = `__gvizCallback_${Date.now()}_${++jsonpCounter}`;
    const script = document.createElement('script');
    let timer = null;

    function cleanup() {
      if (timer) clearTimeout(timer);
      delete window[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[callbackName] = function (response) {
      cleanup();
      if (!response || response.status === 'error') {
        const msg = response?.errors?.[0]?.detailed_message || 'Gagal memuat sheet';
        reject(new Error(msg));
        return;
      }
      resolve(response.table);
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout saat memuat sheet "${sheetName}"`));
    }, timeoutMs);

    const tqx = `responseHandler:${callbackName}`;
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=${encodeURIComponent(tqx)}&sheet=${encodeURIComponent(sheetName)}&_=${Date.now()}`;
    script.src = url;
    script.onerror = () => {
      cleanup();
      reject(new Error(`Gagal mengakses Google Sheets untuk "${sheetName}"`));
    };
    document.head.appendChild(script);
  });
}

// Konversi tanggal dari sel Google Sheets (serial Excel atau string Date(y,m,d) atau YYYY-MM-DD)
function parseGvizDateCell(cell) {
  if (!cell) return null;
  const v = cell.v;
  const f = (cell.f || '').trim();

  // Jika format f sudah YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(f)) {
    return f;
  }

  // Jika v berupa string "Date(2026,10,8)" (bulan 0-indexed)
  if (typeof v === 'string' && v.startsWith('Date(')) {
    const parts = v.slice(5, -1).split(',').map((n) => parseInt(n.trim(), 10));
    if (parts.length >= 3) {
      const y = parts[0];
      const m = String(parts[1] + 1).padStart(2, '0');
      const d = String(parts[2]).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }

  // Jika v berupa angka serial Excel/Sheets (misal 46335 -> 2026-11-09)
  if (typeof v === 'number' && v > 40000 && v < 60000) {
    const utcDays = Math.round(v - 25569);
    const utcValue = utcDays * 86400 * 1000;
    const dt = new Date(utcValue);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return null;
}

function formatIsoToReadable(isoDate) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate || '-';
  const [y, m, d] = isoDate.split('-').map((n) => parseInt(n, 10));
  return `${String(d).padStart(2, '0')} ${MONTHS_SHORT_ID[m - 1]} ${y}`;
}

function formatIsoToSheetTabName(isoDate, padDay = true) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const [y, m, d] = isoDate.split('-').map((n) => parseInt(n, 10));
  const dayStr = padDay ? String(d).padStart(2, '0') : String(d);
  return `${dayStr} ${MONTHS_ID[m - 1]} ${y}`;
}

function getCellVal(row, idx) {
  if (!row || !row.c || !row.c[idx]) return null;
  return row.c[idx].v;
}

function getCellNum(row, idx) {
  const val = getCellVal(row, idx);
  if (typeof val === 'number' && !isNaN(val)) return val;
  if (typeof val === 'string') {
    const cleaned = val.replace(/\./g, '').replace(',', '.').trim();
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  }
  return 0;
}

function getCellStr(row, idx) {
  if (!row || !row.c || !row.c[idx]) return '';
  const cell = row.c[idx];
  if (cell.v !== null && cell.v !== undefined) return String(cell.v).trim();
  if (cell.f) return String(cell.f).trim();
  return '';
}

function getSapCategory(kodeSap) {
  const code = (kodeSap || '').toUpperCase();
  if (code.startsWith('RM')) return 'RM';
  if (code.startsWith('PM')) return 'PM';
  if (code.startsWith('PP')) return 'PP';
  if (code.startsWith('LV')) return 'LV';
  return 'OTHER';
}

// Rumus CEILING sesuai Google Sheets: CEILING(nilai, kelipatan)
function ceilingToMultiple(value, multiple) {
  if (value <= 0) return 0;
  if (!multiple || multiple <= 0) return value;
  // Hindari floating point precision glitch (misal 12.15 / 0.45)
  const ratio = value / multiple;
  const roundedRatio = Math.ceil(ratio - 1e-9);
  const result = roundedRatio * multiple;
  return Math.round(result * 10000) / 10000;
}

// Format angka lokal Indonesia
function formatNum(num, maxDecimals = 3) {
  if (num === null || num === undefined || isNaN(num)) return '-';
  return new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals
  }).format(num);
}

// Simpan & muat input Aktual dari localStorage
function loadActualOverrides() {
  try {
    const raw = localStorage.getItem('itr_mks_actual_overrides');
    if (raw) state.actualOverrides = JSON.parse(raw);
  } catch (e) {
    state.actualOverrides = {};
  }
}

function saveActualOverride(dateKey, kodeSap, value) {
  const key = `${dateKey}__${kodeSap}`;
  if (value === '' || value === null) {
    delete state.actualOverrides[key];
  } else {
    state.actualOverrides[key] = value;
  }
  try {
    localStorage.setItem('itr_mks_actual_overrides', JSON.stringify(state.actualOverrides));
  } catch (e) {
    // ignore storage errors
  }
}

// Parsing tabel KEBUTUHAN RMPM
function parseKebutuhanRmpmTable(table) {
  const rows = table.rows || [];
  let defaultSpkDate = '2026-11-09';
  let defaultPrdDate = '2026-11-08';
  let defaultWrhDate = '2026-11-08';

  if (rows[0]?.c?.[7]) {
    defaultSpkDate = parseGvizDateCell(rows[0].c[7]) || defaultSpkDate;
  }
  if (rows[1]?.c?.[7]) {
    defaultPrdDate = parseGvizDateCell(rows[1].c[7]) || defaultPrdDate;
  }
  if (rows[2]?.c?.[7]) {
    defaultWrhDate = parseGvizDateCell(rows[2].c[7]) || defaultWrhDate;
  }

  const items = [];
  rows.forEach((row, idx) => {
    const kodeSap = getCellStr(row, 0);
    const bahanBaku = getCellStr(row, 1);
    const satuan = getCellStr(row, 2);

    if (!kodeSap || kodeSap === 'Kode SAP' || !bahanBaku) return;

    items.push({
      rowNumber: idx + 1,
      kodeSap,
      bahanBaku,
      satuan,
      category: getSapCategory(kodeSap),
      sheetTotalKebutuhan: getCellNum(row, 3),
      sheetStokProduksi: getCellNum(row, 4),
      sheetStokGudang: getCellNum(row, 5),
      sheetSelisih: getCellNum(row, 6),
      bulky: getCellNum(row, 7),
      sheetPerluItr: getCellNum(row, 8),
      sheetAktual: getCellVal(row, 9) !== null ? getCellStr(row, 9) : ''
    });
  });

  return { defaultSpkDate, defaultPrdDate, defaultWrhDate, items };
}

// Parsing tabel BOM
function parseBomTable(table) {
  const rows = table.rows || [];
  const bomList = [];

  rows.forEach((row) => {
    const varianKue = getCellStr(row, 0);
    const bahanBaku = getCellStr(row, 1);
    const satuan = getCellStr(row, 2);
    const qtyPerBox = getCellNum(row, 3);

    if (!varianKue || varianKue === 'Varian Kue' || !bahanBaku) return;
    bomList.push({
      varianKue: varianKue.toUpperCase(),
      bahanBaku: bahanBaku.toUpperCase(),
      satuan,
      qtyPerBox
    });
  });

  return bomList;
}

// Parsing tabel Stock_Produksi dan Stok_Gudang (sesuai VLOOKUP: ambil baris pertama yang cocok)
function parseStockTable(table) {
  const rows = table.rows || [];
  const map = {};
  rows.forEach((row) => {
    const kodeSap = getCellStr(row, 0).toUpperCase();
    const bahanBaku = getCellStr(row, 1).toUpperCase();
    const qty = getCellNum(row, 3);
    if (!kodeSap && !bahanBaku) return;
    if (kodeSap === 'KODE SAP' || bahanBaku === 'BAHAN BAKU') return;
    if (bahanBaku && !(bahanBaku in map)) map[bahanBaku] = qty;
    if (kodeSap && !(kodeSap in map)) map[kodeSap] = qty;
  });
  return map;
}

// Parsing tabel SPK PRODUKSI
function parseSpkTable(table) {
  const rows = table.rows || [];
  if (rows.length === 0) return { dates: [], variants: [] };

  const dateRow = rows[0];
  const dates = [];
  const maxCols = dateRow?.c?.length || 0;

  for (let col = 1; col < maxCols; col++) {
    const cell = dateRow.c[col];
    if (!cell || (cell.v === null && !cell.f)) continue;

    const isoDate = parseGvizDateCell(cell);
    const dayStr = (cell.f || String(cell.v || '')).trim();
    if (!isoDate && !/^\d{1,2}$/.test(dayStr)) continue;

    dates.push({
      colIndex: col,
      isoDate: isoDate || `COL_${col}`,
      dayStr: dayStr.padStart(2, '0'),
      label: isoDate
        ? `${formatIsoToReadable(isoDate)} (Tgl ${dayStr.padStart(2, '0')})`
        : `Tanggal ${dayStr.padStart(2, '0')}`
    });
  }

  const variants = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const variantName = getCellStr(row, 0);
    if (!variantName || variantName.toUpperCase() === 'VARIAN KUE' || variantName.toUpperCase() === 'TOTAL') {
      continue;
    }
    const quantitiesByCol = {};
    dates.forEach((d) => {
      quantitiesByCol[d.colIndex] = getCellNum(row, d.colIndex);
    });
    variants.push({
      name: variantName.trim(),
      nameUpper: variantName.trim().toUpperCase(),
      quantitiesByCol
    });
  }

  return { dates, variants };
}

// Ambil stok PRD untuk tanggal tertentu dari spreadsheet eksternal Stock PRD (jika ada tab tanggal tsb)
async function tryFetchExternalPrdStockByDate(isoDate) {
  const hintEl = document.getElementById('prdStockHint');
  const tabNamePadded = formatIsoToSheetTabName(isoDate, true);
  const tabNameUnpadded = formatIsoToSheetTabName(isoDate, false);
  if (!tabNamePadded) return false;

  hintEl.textContent = `Mencari sheet "${tabNamePadded}" di Stock PRD...`;

  for (const candidateTab of [tabNamePadded, tabNameUnpadded]) {
    try {
      const table = await fetchSheetGviz(PRD_STOCK_SPREADSHEET_ID, candidateTab, 7000);
      const rows = table.rows || [];
      const newMap = {};
      let matchCount = 0;

      rows.forEach((row) => {
        // Di sheet Stock PRD eksternal: Kolom D (index 3) = Kode SAP, Kolom E (index 4) = Item, Kolom J (index 9) = Stok Akhir PRD
        const kodeSap = getCellStr(row, 3).toUpperCase();
        const itemName = getCellStr(row, 4).toUpperCase();
        if (!kodeSap || kodeSap === 'KODE SAP') return;
        const stokAkhir = getCellNum(row, 9);
        newMap[kodeSap] = stokAkhir;
        if (itemName) newMap[itemName] = stokAkhir;
        matchCount++;
      });

      if (matchCount > 5) {
        state.prdStockMap = newMap;
        hintEl.textContent = `Terhubung: Sheet "${candidateTab}" (${matchCount} item)`;
        recalculateAndRender();
        return true;
      }
    } catch (err) {
      // Lanjut coba kandidat berikutnya atau fallback
    }
  }

  hintEl.textContent = `Tab "${tabNamePadded}" tidak ditemukan, memakai Stock_Produksi utama`;
  return false;
}

// Hitung ulang seluruh baris Kebutuhan RMPM & Perlu ITR
function recalculateAllRows() {
  const colIdx = state.selectedSpkColIndex;

  // Map target SPK per varian kue (mengutamakan angka simulasi jika sedang diubah user)
  const spkQtyMap = {};
  state.spkData.variants.forEach((v) => {
    const baseQty = colIdx !== null ? (v.quantitiesByCol[colIdx] || 0) : 0;
    const effectiveQty = state.simulatedSpkOverrides.hasOwnProperty(v.nameUpper)
      ? state.simulatedSpkOverrides[v.nameUpper]
      : baseQty;
    spkQtyMap[v.nameUpper] = effectiveQty;
  });

  state.computedRows = state.masterItems.map((item, index) => {
    const keyName = item.bahanBaku.toUpperCase();
    const keySap = item.kodeSap.toUpperCase();

    // Cari semua baris BOM yang cocok dengan Bahan Baku atau Kode SAP
    const matchingBom = state.bomList.filter(
      (b) => b.bahanBaku === keyName || b.bahanBaku === keySap
    );

    let calculatedKebutuhan = 0;
    const bomBreakdown = [];

    matchingBom.forEach((b) => {
      const spkBoxes = spkQtyMap[b.varianKue] || 0;
      const subTotal = b.qtyPerBox * spkBoxes;
      calculatedKebutuhan += subTotal;
      bomBreakdown.push({
        varianKue: b.varianKue,
        qtyPerBox: b.qtyPerBox,
        spkBoxes,
        subTotal
      });
    });

    // Jika item tidak ada di BOM sama sekali (fallback ke nilai sheet)
    const totalKebutuhan = matchingBom.length > 0 ? calculatedKebutuhan : item.sheetTotalKebutuhan;

    // Stok Produksi & Stok Gudang dari VLOOKUP map (atau fallback ke nilai sheet)
    const stokProduksi = state.prdStockMap.hasOwnProperty(keyName)
      ? state.prdStockMap[keyName]
      : state.prdStockMap.hasOwnProperty(keySap)
        ? state.prdStockMap[keySap]
        : item.sheetStokProduksi;

    const stokGudang = state.wrhStockMap.hasOwnProperty(keyName)
      ? state.wrhStockMap[keyName]
      : state.wrhStockMap.hasOwnProperty(keySap)
        ? state.wrhStockMap[keySap]
        : item.sheetStokGudang;

    // Rumus G: Selisih = Stok Produksi - Total Kebutuhan
    const selisih = stokProduksi - totalKebutuhan;

    // Rumus I: IF(Selisih < 0, CEILING(-Selisih, Bulky), 0)
    // Catatan khusus: Pada baris 28 di sheet asli (PM00391 BOX CKT KEJU), sheet mengalikan 2 jika Anda ingin persis atau standar CEILING
    let perluItr = 0;
    if (selisih < -1e-9) {
      perluItr = ceilingToMultiple(-selisih, item.bulky);
    }

    const needItr = perluItr > 0;
    const wrhShort = needItr && stokGudang < perluItr;

    const overrideKey = `${state.selectedSpkIsoDate}__${item.kodeSap}`;
    const aktualVal = state.actualOverrides.hasOwnProperty(overrideKey)
      ? state.actualOverrides[overrideKey]
      : item.sheetAktual;

    return {
      index: index + 1,
      kodeSap: item.kodeSap,
      bahanBaku: item.bahanBaku,
      satuan: item.satuan,
      category: item.category,
      totalKebutuhan,
      stokProduksi,
      stokGudang,
      selisih,
      bulky: item.bulky,
      perluItr,
      aktual: aktualVal,
      needItr,
      wrhShort,
      bomBreakdown
    };
  });
}

// Render KPI Cards & Tab Counts
function renderSummaryAndKpis() {
  const totalItems = state.computedRows.length;
  const needItrItems = state.computedRows.filter((r) => r.needItr);
  const safeItems = state.computedRows.filter((r) => !r.needItr);
  const wrhAlertItems = state.computedRows.filter((r) => r.wrhShort);

  const colIdx = state.selectedSpkColIndex;
  let totalBoxes = 0;
  let activeVariants = 0;
  state.spkData.variants.forEach((v) => {
    const baseQty = colIdx !== null ? (v.quantitiesByCol[colIdx] || 0) : 0;
    const qty = state.simulatedSpkOverrides.hasOwnProperty(v.nameUpper)
      ? state.simulatedSpkOverrides[v.nameUpper]
      : baseQty;
    totalBoxes += qty;
    if (qty > 0) activeVariants++;
  });

  document.getElementById('kpiNeedItrCount').textContent = `${needItrItems.length} Item`;
  const pctNeed = totalItems > 0 ? Math.round((needItrItems.length / totalItems) * 100) : 0;
  document.getElementById('kpiNeedItrSub').textContent = `${pctNeed}% dari ${totalItems} bahan baku perlu ditransfer`;

  document.getElementById('kpiSafeCount').textContent = `${safeItems.length} Item`;
  document.getElementById('kpiSafeSub').textContent = `Stok di lantai produksi mencukupi`;

  document.getElementById('kpiWrhAlertCount').textContent = `${wrhAlertItems.length} Item`;
  document.getElementById('kpiWrhAlertSub').textContent =
    wrhAlertItems.length > 0
      ? `Perhatian: ${wrhAlertItems.length} item stok gudang < Perlu ITR`
      : `Semua stok gudang cukup untuk memenuhi ITR`;

  document.getElementById('kpiSpkTotalBoxes').textContent = `${formatNum(totalBoxes, 0)} Box`;
  document.getElementById('kpiSpkActiveVariants').textContent = `${activeVariants} dari ${state.spkData.variants.length} varian kue diproduksi`;

  // Update badge jumlah pada filter tab
  document.getElementById('countAll').textContent = totalItems;
  document.getElementById('countNeedItr').textContent = needItrItems.length;
  document.getElementById('countSafe').textContent = safeItems.length;
  document.getElementById('countWrhShort').textContent = wrhAlertItems.length;
}

// Render Panel Rincian Target SPK Harian
function renderSpkVariantsPanel() {
  const grid = document.getElementById('spkVariantsGrid');
  const badge = document.getElementById('spkPanelDateBadge');
  const resetBtn = document.getElementById('btnResetSpkSim');

  const selectedDateObj = state.spkData.dates.find((d) => d.colIndex === state.selectedSpkColIndex);
  const hasSim = Object.keys(state.simulatedSpkOverrides).length > 0;

  badge.textContent = selectedDateObj
    ? `${selectedDateObj.label}${hasSim ? ' • Mode Simulasi' : ''}`
    : '-';

  if (hasSim) {
    resetBtn.classList.remove('hidden');
  } else {
    resetBtn.classList.add('hidden');
  }

  grid.innerHTML = '';
  state.spkData.variants.forEach((v) => {
    const baseQty = state.selectedSpkColIndex !== null ? (v.quantitiesByCol[state.selectedSpkColIndex] || 0) : 0;
    const currentQty = state.simulatedSpkOverrides.hasOwnProperty(v.nameUpper)
      ? state.simulatedSpkOverrides[v.nameUpper]
      : baseQty;

    const card = document.createElement('div');
    card.className = `spk-variant-card ${currentQty > 0 ? 'active-spk' : ''}`;
    card.innerHTML = `
      <div class="spk-variant-name">${v.name}</div>
      <div class="spk-variant-input-wrap">
        <input
          type="number"
          min="0"
          step="1"
          class="spk-variant-input"
          data-variant="${v.nameUpper}"
          value="${currentQty}"
          title="Ubah angka Box untuk simulasi perhitungan kebutuhan RMPM"
        />
        <span class="spk-variant-unit">BOX</span>
      </div>
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll('.spk-variant-input').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const variantUpper = e.target.getAttribute('data-variant');
      const val = parseFloat(e.target.value);
      state.simulatedSpkOverrides[variantUpper] = isNaN(val) || val < 0 ? 0 : val;
      recalculateAndRender(false);
    });
  });
}

// Filter & Sort baris untuk tabel
function getFilteredAndSortedRows() {
  let rows = [...state.computedRows];

  if (state.activeFilter === 'need_itr') {
    rows = rows.filter((r) => r.needItr);
  } else if (state.activeFilter === 'safe') {
    rows = rows.filter((r) => !r.needItr);
  } else if (state.activeFilter === 'wrh_short') {
    rows = rows.filter((r) => r.wrhShort);
  }

  if (state.categoryFilter !== 'ALL') {
    rows = rows.filter((r) => r.category === state.categoryFilter);
  }

  if (state.searchQuery.trim() !== '') {
    const q = state.searchQuery.trim().toLowerCase();
    rows = rows.filter(
      (r) =>
        r.kodeSap.toLowerCase().includes(q) ||
        r.bahanBaku.toLowerCase().includes(q)
    );
  }

  if (state.sortField !== 'default') {
    const field = state.sortField;
    const dir = state.sortAsc ? 1 : -1;
    rows.sort((a, b) => {
      const va = a[field];
      const vb = b[field];
      if (typeof va === 'string') {
        return va.localeCompare(vb) * dir;
      }
      return (va - vb) * dir;
    });
  }

  return rows;
}

// Render Tabel Utama RMPM
function renderTable() {
  const tbody = document.getElementById('rmpmTableBody');
  const rows = getFilteredAndSortedRows();

  // Update header cetak
  const prdDateVal = document.getElementById('inputPrdDate').value;
  const wrhDateVal = document.getElementById('inputWrhDate').value;
  document.getElementById('printMetaInfo').textContent =
    `Tanggal SPK: ${formatIsoToReadable(state.selectedSpkIsoDate)} | Tanggal SO PRD: ${formatIsoToReadable(prdDateVal)} | Tanggal SO WRH: ${formatIsoToReadable(wrhDateVal)} | Dicetak: ${new Date().toLocaleString('id-ID')}`;

  if (rows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="12" class="empty-state">Tidak ada item bahan baku yang sesuai dengan filter pencarian.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows
    .map((r, idx) => {
      const selisihClass = r.selisih < -1e-9 ? 'val-negative' : 'val-positive';
      const selisihPrefix = r.selisih > 0 ? '+' : '';

      const itrCellHtml = r.needItr
        ? `<span class="itr-highlight">${formatNum(r.perluItr, 2)}</span>`
        : `<span class="itr-zero">0</span>`;

      let statusHtml = '';
      if (r.wrhShort) {
        statusHtml = `<span class="status-badge status-wrh-warn">Gudang Kurang</span>`;
      } else if (r.needItr) {
        statusHtml = `<span class="status-badge status-need-itr">Perlu ITR</span>`;
      } else {
        statusHtml = `<span class="status-badge status-safe">Stok Aman</span>`;
      }

      return `
        <tr class="${r.needItr ? 'row-need-itr' : ''}">
          <td class="col-no">${idx + 1}</td>
          <td>
            <span class="sap-code sap-${r.category}">${r.kodeSap}</span>
          </td>
          <td>
            <button type="button" class="material-btn" data-sap="${r.kodeSap}" title="Klik untuk melihat rincian resep BOM bahan baku ini">
              <span>${r.bahanBaku}</span>
              <span class="bom-hint">${r.bomBreakdown.length} resep</span>
            </button>
          </td>
          <td><span class="uom-badge">${r.satuan}</span></td>
          <td class="col-num">${formatNum(r.totalKebutuhan, 3)}</td>
          <td class="col-num">${formatNum(r.stokProduksi, 2)}</td>
          <td class="col-num">${formatNum(r.stokGudang, 2)}</td>
          <td class="col-num ${selisihClass}">${selisihPrefix}${formatNum(r.selisih, 2)}</td>
          <td class="col-num">${formatNum(r.bulky, 2)}</td>
          <td class="col-num col-itr-cell">${itrCellHtml}</td>
          <td>
            <input
              type="text"
              class="actual-input"
              data-sap="${r.kodeSap}"
              value="${r.aktual !== undefined && r.aktual !== null ? r.aktual : ''}"
              placeholder="-"
            />
          </td>
          <td>${statusHtml}</td>
        </tr>
      `;
    })
    .join('');

  // Event klik rincian BOM
  tbody.querySelectorAll('.material-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sap = btn.getAttribute('data-sap');
      openBomModal(sap);
    });
  });

  // Event simpan input Aktual
  tbody.querySelectorAll('.actual-input').forEach((inp) => {
    inp.addEventListener('change', (e) => {
      const sap = e.target.getAttribute('data-sap');
      saveActualOverride(state.selectedSpkIsoDate, sap, e.target.value.trim());
    });
  });
}

function recalculateAndRender(renderSpkPanel = true) {
  recalculateAllRows();
  renderSummaryAndKpis();
  if (renderSpkPanel) {
    renderSpkVariantsPanel();
  } else {
    const badge = document.getElementById('spkPanelDateBadge');
    const resetBtn = document.getElementById('btnResetSpkSim');
    const selectedDateObj = state.spkData.dates.find((d) => d.colIndex === state.selectedSpkColIndex);
    const hasSim = Object.keys(state.simulatedSpkOverrides).length > 0;
    badge.textContent = selectedDateObj
      ? `${selectedDateObj.label}${hasSim ? ' • Mode Simulasi' : ''}`
      : '-';
    resetBtn.classList.toggle('hidden', !hasSim);
  }
  renderTable();
}

// Modal Rincian BOM per Bahan Baku
function openBomModal(kodeSap) {
  const row = state.computedRows.find((r) => r.kodeSap === kodeSap);
  if (!row) return;

  document.getElementById('modalSapBadge').textContent = `${row.kodeSap} • ${row.satuan}`;
  document.getElementById('modalMaterialTitle').textContent = row.bahanBaku;
  document.getElementById('modalSubtitle').textContent =
    `Perhitungan Total Kebutuhan pada Tanggal SPK ${formatIsoToReadable(state.selectedSpkIsoDate)}:`;

  const tbody = document.getElementById('modalBomBody');
  if (row.bomBreakdown.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-state">Tidak ada rincian BOM untuk kode ini.</td></tr>`;
  } else {
    tbody.innerHTML = row.bomBreakdown
      .map(
        (b) => `
        <tr>
          <td><strong>${b.varianKue}</strong></td>
          <td class="text-right">${formatNum(b.qtyPerBox, 6)} ${row.satuan}</td>
          <td class="text-right">${formatNum(b.spkBoxes, 0)} Box</td>
          <td class="text-right"><strong>${formatNum(b.subTotal, 3)} ${row.satuan}</strong></td>
        </tr>
      `
      )
      .join('');
  }

  document.getElementById('modalTotalKebutuhan').textContent =
    `${formatNum(row.totalKebutuhan, 3)} ${row.satuan}`;
  document.getElementById('bomModal').classList.remove('hidden');
}

// Populate Dropdown Tanggal SPK
function populateSpkDateDropdown(preferredIsoDate) {
  const select = document.getElementById('selectSpkDate');
  select.innerHTML = '';

  if (state.spkData.dates.length === 0) {
    select.innerHTML = `<option value="">Tidak ada kolom tanggal</option>`;
    state.selectedSpkColIndex = null;
    return;
  }

  let matchedCol = null;
  state.spkData.dates.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = String(d.colIndex);
    opt.textContent = d.label;
    select.appendChild(opt);

    if (preferredIsoDate && d.isoDate === preferredIsoDate) {
      matchedCol = d.colIndex;
    }
  });

  // Jika tanggal default tidak ditemukan, pilih tanggal terakhir yang memiliki jadwal produksi > 0
  if (matchedCol === null) {
    for (let i = state.spkData.dates.length - 1; i >= 0; i--) {
      const col = state.spkData.dates[i].colIndex;
      const sumBoxes = state.spkData.variants.reduce((acc, v) => acc + (v.quantitiesByCol[col] || 0), 0);
      if (sumBoxes > 0) {
        matchedCol = col;
        break;
      }
    }
  }

  if (matchedCol === null) {
    matchedCol = state.spkData.dates[0].colIndex;
  }

  select.value = String(matchedCol);
  state.selectedSpkColIndex = matchedCol;
  const foundDate = state.spkData.dates.find((d) => d.colIndex === matchedCol);
  state.selectedSpkIsoDate = foundDate ? foundDate.isoDate : '';
}

// Export ke CSV
function exportCurrentTableToCsv() {
  const rows = getFilteredAndSortedRows();
  const headers = [
    'No',
    'Kode SAP',
    'Bahan Baku',
    'Satuan',
    'Total Kebutuhan',
    'Stok Produksi',
    'Stok Gudang',
    'Selisih',
    'Bulky',
    'Perlu ITR',
    'Aktual',
    'Status'
  ];

  const csvLines = [
    `"KEBUTUHAN RMPM-PRODUKSI MAKASSAR","","","","","","","","","","",""`,
    `"Tanggal SPK:","${state.selectedSpkIsoDate}","Stock PRD:","${document.getElementById('inputPrdDate').value}","Stock WRH:","${document.getElementById('inputWrhDate').value}","","","","","",""`,
    headers.map((h) => `"${h}"`).join(','),
    ...rows.map((r, i) => {
      const statusText = r.wrhShort ? 'Gudang Kurang' : r.needItr ? 'Perlu ITR' : 'Stok Aman';
      return [
        i + 1,
        `"${r.kodeSap}"`,
        `"${r.bahanBaku.replace(/"/g, '""')}"`,
        `"${r.satuan}"`,
        r.totalKebutuhan.toFixed(3),
        r.stokProduksi.toFixed(2),
        r.stokGudang.toFixed(2),
        r.selisih.toFixed(2),
        r.bulky,
        r.perluItr,
        `"${r.aktual || ''}"`,
        `"${statusText}"`
      ].join(',');
    })
  ];

  const blob = new Blob([csvLines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ITR_RMPM_Makassar_${state.selectedSpkIsoDate || 'Export'}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Set status indikator koneksi
function setSyncStatus(mode, text) {
  const box = document.getElementById('syncStatus');
  const txt = document.getElementById('syncText');
  box.className = `sync-status ${mode}`;
  txt.textContent = text;
}

// Muat seluruh data utama dari Google Sheets
async function loadAllSpreadsheetData(preserveDates = false) {
  try {
    setSyncStatus('syncing', 'Menyinkronkan data Google Sheets...');

    const [rmpmTable, bomTable, spkTable, prdTable, wrhTable] = await Promise.all([
      fetchSheetGviz(MAIN_SPREADSHEET_ID, 'KEBUTUHAN RMPM'),
      fetchSheetGviz(MAIN_SPREADSHEET_ID, 'BOM'),
      fetchSheetGviz(MAIN_SPREADSHEET_ID, state.selectedSpkSheet),
      fetchSheetGviz(MAIN_SPREADSHEET_ID, 'Stock_Produksi'),
      fetchSheetGviz(MAIN_SPREADSHEET_ID, 'Stok_Gudang')
    ]);

    const parsedRmpm = parseKebutuhanRmpmTable(rmpmTable);
    state.masterItems = parsedRmpm.items;
    state.bomList = parseBomTable(bomTable);
    state.spkData = parseSpkTable(spkTable);
    state.prdStockMap = parseStockTable(prdTable);
    state.wrhStockMap = parseStockTable(wrhTable);

    if (!preserveDates) {
      document.getElementById('inputPrdDate').value = parsedRmpm.defaultPrdDate;
      document.getElementById('inputWrhDate').value = parsedRmpm.defaultWrhDate;
      populateSpkDateDropdown(parsedRmpm.defaultSpkDate);
    } else {
      populateSpkDateDropdown(state.selectedSpkIsoDate);
    }

    recalculateAndRender();

    const nowStr = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    setSyncStatus('online', `Terhubung Real-Time • Diperbarui ${nowStr}`);
  } catch (err) {
    console.error(err);
    setSyncStatus('error', `Gagal sinkronisasi: ${err.message}`);
  }
}

// Inisialisasi Event Listeners
function initEventListeners() {
  loadActualOverrides();

  document.getElementById('btnRefresh').addEventListener('click', () => {
    loadAllSpreadsheetData(true);
  });

  // Ganti Sheet Periode SPK
  document.getElementById('selectSpkSheet').addEventListener('change', async (e) => {
    state.selectedSpkSheet = e.target.value;
    state.simulatedSpkOverrides = {};
    try {
      setSyncStatus('syncing', `Memuat ${state.selectedSpkSheet}...`);
      const spkTable = await fetchSheetGviz(MAIN_SPREADSHEET_ID, state.selectedSpkSheet);
      state.spkData = parseSpkTable(spkTable);
      populateSpkDateDropdown(null);
      recalculateAndRender();
      setSyncStatus('online', `Terhubung • Sheet: ${state.selectedSpkSheet}`);
    } catch (err) {
      setSyncStatus('error', `Gagal memuat sheet ${state.selectedSpkSheet}`);
    }
  });

  // Ganti Tanggal SPK
  document.getElementById('selectSpkDate').addEventListener('change', (e) => {
    const colIdx = parseInt(e.target.value, 10);
    state.selectedSpkColIndex = isNaN(colIdx) ? null : colIdx;
    const found = state.spkData.dates.find((d) => d.colIndex === state.selectedSpkColIndex);
    state.selectedSpkIsoDate = found ? found.isoDate : '';
    state.simulatedSpkOverrides = {};
    recalculateAndRender();
  });

  // Ganti Tanggal SO Stock PRD
  document.getElementById('inputPrdDate').addEventListener('change', (e) => {
    const isoDate = e.target.value;
    if (isoDate) {
      tryFetchExternalPrdStockByDate(isoDate);
    }
  });

  // Ganti Tanggal SO Stock WRH
  document.getElementById('inputWrhDate').addEventListener('change', (e) => {
    const isoDate = e.target.value;
    const hintEl = document.getElementById('wrhStockHint');
    hintEl.textContent = `Tanggal SO WRH: ${formatIsoToReadable(isoDate)} (via Stok_Gudang)`;
    renderTable();
  });

  // Tombol Reset Simulasi SPK
  document.getElementById('btnResetSpkSim').addEventListener('click', () => {
    state.simulatedSpkOverrides = {};
    recalculateAndRender();
  });

  // Sembunyikan / Tampilkan Rincian SPK
  document.getElementById('btnToggleSpk').addEventListener('click', (e) => {
    state.spkPanelVisible = !state.spkPanelVisible;
    const grid = document.getElementById('spkVariantsGrid');
    grid.classList.toggle('hidden', !state.spkPanelVisible);
    e.target.textContent = state.spkPanelVisible ? 'Sembunyikan Rincian' : 'Tampilkan Rincian';
  });

  // Filter Tabs
  document.querySelectorAll('.filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.activeFilter = tab.getAttribute('data-filter');
      renderTable();
    });
  });

  // Klik KPI Card untuk langsung memfilter tabel
  document.getElementById('kpiCardNeedItr').addEventListener('click', () => {
    document.querySelector('.filter-tab[data-filter="need_itr"]').click();
  });
  document.getElementById('kpiCardSafe').addEventListener('click', () => {
    document.querySelector('.filter-tab[data-filter="safe"]').click();
  });
  document.getElementById('kpiCardWrhAlert').addEventListener('click', () => {
    document.querySelector('.filter-tab[data-filter="wrh_short"]').click();
  });

  // Filter Kategori SAP
  document.getElementById('categoryFilter').addEventListener('change', (e) => {
    state.categoryFilter = e.target.value;
    renderTable();
  });

  // Pencarian
  document.getElementById('searchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderTable();
  });

  // Sorting Kolom Tabel
  document.querySelectorAll('.data-table thead th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const field = th.getAttribute('data-sort');
      if (state.sortField === field) {
        state.sortAsc = !state.sortAsc;
      } else {
        state.sortField = field;
        state.sortAsc = field === 'kodeSap' || field === 'bahanBaku';
      }
      renderTable();
    });
  });

  // Export CSV & Cetak Form ITR
  document.getElementById('btnExportCsv').addEventListener('click', exportCurrentTableToCsv);
  document.getElementById('btnPrintItr').addEventListener('click', () => {
    window.print();
  });

  // Tutup Modal BOM
  document.getElementById('btnCloseModal').addEventListener('click', () => {
    document.getElementById('bomModal').classList.add('hidden');
  });
  document.getElementById('bomModal').addEventListener('click', (e) => {
    if (e.target.id === 'bomModal') {
      document.getElementById('bomModal').classList.add('hidden');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  loadAllSpreadsheetData(false);
});
