import { INITIAL_BOM_SEED } from './bom_seed.js';

const MAIN_SPREADSHEET_ID = '1zNqfqYFt4DTstU2AnHJFrkgtBH7Ee1mOqw79pHvUxfQ';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS
    }
  });
}

// Pastikan tabel `bom` ada di Cloudflare D1 dan otomatis terisi (auto-seed) jika masih kosong
async function ensureBomTableAndSeed(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS bom (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        varian_kue TEXT NOT NULL,
        bahan_baku TEXT NOT NULL,
        satuan TEXT NOT NULL,
        qty_per_box REAL NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now'))
      )`
    )
    .run();

  const countRow = await db.prepare('SELECT COUNT(*) AS total FROM bom').first();
  const total = countRow ? Number(countRow.total) : 0;

  if (total === 0 && INITIAL_BOM_SEED.length > 0) {
    await insertBomBatch(db, INITIAL_BOM_SEED);
  }
}

// Batch insert ke Cloudflare D1 dalam chunk 50 baris
async function insertBomBatch(db, items) {
  const chunkSize = 50;
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const stmts = chunk.map((item) =>
      db
        .prepare(
          'INSERT INTO bom (varian_kue, bahan_baku, satuan, qty_per_box) VALUES (?1, ?2, ?3, ?4)'
        )
        .bind(
          String(item.varianKue).trim().toUpperCase(),
          String(item.bahanBaku).trim().toUpperCase(),
          String(item.satuan || 'KG').trim().toUpperCase(),
          Number(item.qtyPerBox) || 0
        )
    );
    await db.batch(stmts);
  }
}

// Tarik data BOM langsung dari Google Sheets untuk sinkronisasi ke Cloudflare D1
async function fetchLiveBomFromGoogleSheet() {
  const targetUrl = `https://docs.google.com/spreadsheets/d/${MAIN_SPREADSHEET_ID}/gviz/tq?tqx=out:json&sheet=BOM`;
  const resp = await fetch(targetUrl);
  const text = await resp.text();

  const startIdx = text.indexOf('{');
  const endIdx = text.lastIndexOf('}');
  if (startIdx === -1 || endIdx === -1) {
    throw new Error('Format respons Google Sheets BOM tidak valid');
  }

  const payload = JSON.parse(text.slice(startIdx, endIdx + 1));
  const rows = payload?.table?.rows || [];
  const parsed = [];

  for (const r of rows) {
    const c = r.c || [];
    const varianKue = c[0]?.v ? String(c[0].v).trim().toUpperCase() : '';
    const bahanBaku = c[1]?.v ? String(c[1].v).trim().toUpperCase() : '';
    const satuan = c[2]?.v ? String(c[2].v).trim().toUpperCase() : 'KG';
    const rawQty = c[3]?.v;

    let qtyPerBox = 0;
    if (typeof rawQty === 'number') {
      qtyPerBox = rawQty;
    } else if (typeof rawQty === 'string') {
      qtyPerBox = parseFloat(rawQty.replace(/\./g, '').replace(',', '.')) || 0;
    }

    if (
      varianKue &&
      varianKue !== '-' &&
      varianKue !== 'VARIAN KUE' &&
      bahanBaku &&
      qtyPerBox > 0
    ) {
      parsed.push({ varianKue, bahanBaku, satuan, qtyPerBox });
    }
  }

  return parsed;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 1. GET /api/bom -> Ambil data BOM dari Cloudflare D1 Database
    if (url.pathname === '/api/bom' && request.method === 'GET') {
      if (!env.DB) {
        return jsonResponse({
          ok: true,
          source: 'cloudflare_worker_seed',
          d1Bound: false,
          message: 'Binding D1 (env.DB) belum diaktifkan, menggunakan data BOM Worker.',
          count: INITIAL_BOM_SEED.length,
          rows: INITIAL_BOM_SEED.map((item, idx) => ({ id: idx + 1, ...item }))
        });
      }

      try {
        await ensureBomTableAndSeed(env.DB);
        const { results } = await env.DB.prepare(
          `SELECT
            id,
            varian_kue AS varianKue,
            bahan_baku AS bahanBaku,
            satuan,
            qty_per_box AS qtyPerBox,
            updated_at AS updatedAt
          FROM bom
          ORDER BY varian_kue ASC, bahan_baku ASC`
        ).all();

        return jsonResponse({
          ok: true,
          source: 'cloudflare_d1',
          d1Bound: true,
          count: results.length,
          rows: results
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 2. POST /api/bom/sync -> Tarik ulang BOM dari Google Sheets ke Cloudflare D1 Database
    if (url.pathname === '/api/bom/sync' && request.method === 'POST') {
      try {
        const freshBom = await fetchLiveBomFromGoogleSheet();
        if (freshBom.length === 0) {
          return jsonResponse({ ok: false, error: 'Data BOM dari Google Sheets kosong' }, 400);
        }

        if (env.DB) {
          await ensureBomTableAndSeed(env.DB);
          await env.DB.prepare('DELETE FROM bom').run();
          await insertBomBatch(env.DB, freshBom);

          const { results } = await env.DB.prepare(
            `SELECT
              id,
              varian_kue AS varianKue,
              bahan_baku AS bahanBaku,
              satuan,
              qty_per_box AS qtyPerBox,
              updated_at AS updatedAt
            FROM bom
            ORDER BY varian_kue ASC, bahan_baku ASC`
          ).all();

          return jsonResponse({
            ok: true,
            source: 'cloudflare_d1',
            d1Bound: true,
            syncedCount: results.length,
            rows: results
          });
        }

        return jsonResponse({
          ok: true,
          source: 'google_sheets_direct',
          d1Bound: false,
          syncedCount: freshBom.length,
          rows: freshBom.map((item, idx) => ({ id: idx + 1, ...item }))
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 3. POST /api/bom -> Tambah / Update baris resep BOM di Cloudflare D1
    if (url.pathname === '/api/bom' && request.method === 'POST') {
      if (!env.DB) {
        return jsonResponse(
          { ok: false, error: 'Hubungkan D1 Database (binding: DB) di Cloudflare untuk menyimpan perubahan.' },
          400
        );
      }
      try {
        const body = await request.json();
        const id = body.id ? Number(body.id) : null;
        const varianKue = String(body.varianKue || '').trim().toUpperCase();
        const bahanBaku = String(body.bahanBaku || '').trim().toUpperCase();
        const satuan = String(body.satuan || 'KG').trim().toUpperCase();
        const qtyPerBox = Number(body.qtyPerBox) || 0;

        if (!varianKue || !bahanBaku || qtyPerBox <= 0) {
          return jsonResponse({ ok: false, error: 'Varian Kue, Bahan Baku, dan Qty > 0 wajib diisi.' }, 400);
        }

        await ensureBomTableAndSeed(env.DB);

        if (id) {
          await env.DB.prepare(
            `UPDATE bom
             SET varian_kue = ?1, bahan_baku = ?2, satuan = ?3, qty_per_box = ?4, updated_at = datetime('now')
             WHERE id = ?5`
          )
            .bind(varianKue, bahanBaku, satuan, qtyPerBox, id)
            .run();
        } else {
          await env.DB.prepare(
            `INSERT INTO bom (varian_kue, bahan_baku, satuan, qty_per_box)
             VALUES (?1, ?2, ?3, ?4)`
          )
            .bind(varianKue, bahanBaku, satuan, qtyPerBox)
            .run();
        }

        return jsonResponse({ ok: true });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 4. DELETE /api/bom?id=... -> Hapus baris BOM di Cloudflare D1
    if (url.pathname === '/api/bom' && request.method === 'DELETE') {
      if (!env.DB) {
        return jsonResponse({ ok: false, error: 'Binding D1 (DB) belum aktif.' }, 400);
      }
      try {
        const id = Number(url.searchParams.get('id'));
        if (!id) return jsonResponse({ ok: false, error: 'ID tidak valid' }, 400);
        await env.DB.prepare('DELETE FROM bom WHERE id = ?1').bind(id).run();
        return jsonResponse({ ok: true });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 5. GET, POST, DELETE /api/spk -> Input & Simpan Jadwal SPK Produksi di Cloudflare D1
    if (url.pathname === '/api/spk') {
      if (!env.DB) {
        return jsonResponse({
          ok: true,
          d1Bound: false,
          schedules: {},
          message: 'Binding D1 (DB) belum aktif.'
        });
      }

      try {
        await env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS spk_produksi (
            spk_date TEXT NOT NULL,
            varian_kue TEXT NOT NULL,
            qty_box REAL NOT NULL DEFAULT 0,
            updated_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (spk_date, varian_kue)
          )`
        ).run();

        if (request.method === 'GET') {
          const { results } = await env.DB.prepare(
            `SELECT
              spk_date AS spkDate,
              varian_kue AS varianKue,
              qty_box AS qtyBox,
              updated_at AS updatedAt
            FROM spk_produksi
            ORDER BY spk_date DESC, varian_kue ASC`
          ).all();

          // Kelompokkan per tanggal: { "2026-11-09": { "LAPIS TRIPLE CHOCOLATE": 1260, ... } }
          const schedules = {};
          for (const row of results || []) {
            if (!schedules[row.spkDate]) {
              schedules[row.spkDate] = {};
            }
            schedules[row.spkDate][row.varianKue] = Number(row.qtyBox) || 0;
          }

          return jsonResponse({
            ok: true,
            d1Bound: true,
            schedules,
            rows: results || []
          });
        }

        if (request.method === 'POST') {
          const body = await request.json();
          const spkDate = String(body.spkDate || '').trim();
          const items = Array.isArray(body.items) ? body.items : [];

          if (!/^\d{4}-\d{2}-\d{2}$/.test(spkDate)) {
            return jsonResponse({ ok: false, error: 'Format Tanggal SPK harus YYYY-MM-DD' }, 400);
          }

          const stmts = [
            env.DB.prepare('DELETE FROM spk_produksi WHERE spk_date = ?1').bind(spkDate)
          ];

          for (const item of items) {
            const varianKue = String(item.varianKue || '').trim().toUpperCase();
            const qtyBox = Number(item.qtyBox) || 0;
            if (varianKue && qtyBox >= 0) {
              stmts.push(
                env.DB.prepare(
                  `INSERT INTO spk_produksi (spk_date, varian_kue, qty_box, updated_at)
                   VALUES (?1, ?2, ?3, datetime('now'))`
                ).bind(spkDate, varianKue, qtyBox)
              );
            }
          }

          await env.DB.batch(stmts);
          return jsonResponse({ ok: true, spkDate, savedCount: items.length });
        }

        if (request.method === 'DELETE') {
          const spkDate = String(url.searchParams.get('date') || '').trim();
          if (!spkDate) {
            return jsonResponse({ ok: false, error: 'Parameter date wajib diisi' }, 400);
          }
          await env.DB.prepare('DELETE FROM spk_produksi WHERE spk_date = ?1').bind(spkDate).run();
          return jsonResponse({ ok: true, deletedDate: spkDate });
        }
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 5. GET & POST /api/actuals -> Simpan & muat realisasi Aktual ITR di Cloudflare D1
    if (url.pathname === '/api/actuals' && env.DB) {
      try {
        await env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS itr_actuals (
            spk_date TEXT NOT NULL,
            kode_sap TEXT NOT NULL,
            actual_val TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (spk_date, kode_sap)
          )`
        ).run();

        if (request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT spk_date AS spkDate, kode_sap AS kodeSap, actual_val AS actualVal FROM itr_actuals'
          ).all();
          const map = {};
          for (const r of results || []) {
            map[`${r.spkDate}__${r.kodeSap}`] = r.actualVal;
          }
          return jsonResponse({ ok: true, actuals: map });
        }

        if (request.method === 'POST') {
          const body = await request.json();
          const spkDate = String(body.spkDate || '').trim();
          const kodeSap = String(body.kodeSap || '').trim().toUpperCase();
          const actualVal = String(body.actualVal ?? '').trim();

          if (!spkDate || !kodeSap) {
            return jsonResponse({ ok: false, error: 'spkDate dan kodeSap wajib diisi' }, 400);
          }

          if (actualVal === '') {
            await env.DB.prepare('DELETE FROM itr_actuals WHERE spk_date = ?1 AND kode_sap = ?2')
              .bind(spkDate, kodeSap)
              .run();
          } else {
            await env.DB.prepare(
              `INSERT INTO itr_actuals (spk_date, kode_sap, actual_val, updated_at)
               VALUES (?1, ?2, ?3, datetime('now'))
               ON CONFLICT(spk_date, kode_sap) DO UPDATE SET
                 actual_val = excluded.actual_val,
                 updated_at = datetime('now')`
            )
              .bind(spkDate, kodeSap, actualVal)
              .run();
          }
          return jsonResponse({ ok: true });
        }
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 5. Endpoint proxy opsional ke Google Sheets
    if (url.pathname === '/api/sheet') {
      const sheetId = url.searchParams.get('id') || MAIN_SPREADSHEET_ID;
      const sheetName = url.searchParams.get('sheet') || 'KEBUTUHAN RMPM';
      const targetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;

      const resp = await fetch(targetUrl);
      const text = await resp.text();
      return new Response(text, {
        status: resp.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...CORS_HEADERS,
          'Cache-Control': 'no-store'
        }
      });
    }

    // Layani file statis (index.html, styles.css, app.js)
    return env.ASSETS.fetch(request);
  }
};
