// API de integración (solo lectura) para que otras aplicaciones lean locales y
// planos de sala sin pasar por la exportación a PDF. Montada en /api/v1.
// Documentación: docs/API-planos.md
//
// Autenticación: cabecera `X-API-Key: <clave>` (o `Authorization: Bearer <clave>`).
// Las claves NUNCA se guardan en claro: en la tabla app_secrets hay una fila por
// clave con key = 'api_key:<etiqueta>' y value = sha256(clave) en hexadecimal.
// Así se pueden dar claves distintas a cada app y revocar una borrando su fila,
// sin tocar el código ni las variables de entorno de Render.

const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const availability = require('./availability');

const router = express.Router();

// --- Claves ------------------------------------------------------------------
let keyCache = { at: 0, keys: [] };
async function loadKeys() {
  if (Date.now() - keyCache.at < 60_000) return keyCache.keys;
  const { rows } = await db.query("SELECT key, value FROM app_secrets WHERE key LIKE 'api_key:%'");
  keyCache = { at: Date.now(), keys: rows.map(r => ({ label: r.key.slice(8), hash: Buffer.from(r.value, 'hex') })) };
  return keyCache.keys;
}

async function requireApiKey(req, res, next) {
  try {
    const auth = req.get('authorization') || '';
    const provided = req.get('x-api-key') || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (!provided) return res.status(401).json({ error: 'Falta la clave de API (cabecera X-API-Key).' });
    const hash = crypto.createHash('sha256').update(provided.trim()).digest();
    const keys = await loadKeys();
    const match = keys.find(k => k.hash.length === hash.length && crypto.timingSafeEqual(k.hash, hash));
    if (!match) return res.status(401).json({ error: 'Clave de API no válida.' });
    req.apiClient = match.label;
    res.set('Cache-Control', 'no-store');
    next();
  } catch (err) {
    next(err);
  }
}

// --- Formato de salida -------------------------------------------------------
const num = (v) => (v == null ? null : Number(v));

function shapeRestaurant(r) {
  return {
    id: r.id,
    name: r.name,
    address: r.address,
    phone: r.phone,
    email: r.email,
    settings: {
      serviceDurationMinutes: r.default_duration_minutes,
      turnoverBufferMinutes: r.turnover_buffer_minutes,
      slotIntervalMinutes: r.slot_interval_minutes,
      maxPartySize: r.max_party_size,
      maxAdvanceDays: r.max_advance_days,
      minAdvanceMinutes: r.min_advance_minutes,
    },
  };
}

// Carga planos completos (zonas, mesas, combinaciones) con 4 consultas en total,
// sea un plano o todos los de un local.
async function loadPlans({ restaurantId, planIds, includeInactive }) {
  const where = planIds ? 'p.id = ANY($1::int[])' : 'p.restaurant_id = $1';
  const arg = planIds || restaurantId;
  const { rows: plans } = await db.query(
    `SELECT p.* FROM floor_plans p WHERE ${where} ORDER BY p.is_default DESC, p.id`, [arg]);
  if (!plans.length) return [];
  const ids = plans.map(p => p.id);
  const [{ rows: zones }, { rows: tables }, { rows: combos }, { rows: members }] = await Promise.all([
    db.query('SELECT * FROM zones WHERE floor_plan_id = ANY($1::int[]) ORDER BY sort_order, id', [ids]),
    db.query(`SELECT * FROM tables WHERE floor_plan_id = ANY($1::int[]) ${includeInactive ? '' : 'AND active = 1'} ORDER BY id`, [ids]),
    db.query('SELECT * FROM table_combinations WHERE floor_plan_id = ANY($1::int[]) AND active = 1 ORDER BY id', [ids]),
    db.query(`SELECT m.combination_id, m.table_id FROM table_combination_members m
              JOIN table_combinations c ON c.id = m.combination_id WHERE c.floor_plan_id = ANY($1::int[])`, [ids]),
  ]);
  const zoneName = new Map(zones.map(z => [z.id, z.name]));
  const tableById = new Map(tables.map(t => [t.id, t]));
  const membersOf = new Map();
  for (const m of members) {
    if (!membersOf.has(m.combination_id)) membersOf.set(m.combination_id, []);
    membersOf.get(m.combination_id).push(m.table_id);
  }
  return plans.map(p => {
    const pz = zones.filter(z => z.floor_plan_id === p.id);
    const pt = tables.filter(t => t.floor_plan_id === p.id);
    const pc = combos.filter(c => c.floor_plan_id === p.id).map(c => {
      const tIds = (membersOf.get(c.id) || []).filter(id => tableById.has(id)).sort((a, b) => a - b);
      const sumMax = tIds.reduce((s, id) => s + (tableById.get(id).capacity_max || 0), 0);
      return {
        id: c.id,
        name: c.name,
        capacityMin: num(c.capacity_min),
        capacityMax: c.capacity_max != null ? num(c.capacity_max) : sumMax,
        capacityMaxIsExplicit: c.capacity_max != null,
        tableIds: tIds,
        tableNames: tIds.map(id => tableById.get(id).name),
      };
    });
    const activeTables = pt.filter(t => t.active);
    return {
      id: p.id,
      restaurantId: p.restaurant_id,
      name: p.name,
      isDefault: !!p.is_default,
      // Posiciones en % del lienzo (0-100 en cada eje, centro de la mesa), igual que el editor.
      coordinateSystem: { unit: 'percent', origin: 'top-left', reference: 'table-center' },
      totals: {
        zones: pz.length,
        tables: activeTables.length,
        seatsMax: activeTables.reduce((s, t) => s + (t.capacity_max || 0), 0),
        combinations: pc.length,
      },
      zones: pz.map(z => ({ id: z.id, name: z.name, order: z.sort_order })),
      tables: pt.map(t => ({
        id: t.id,
        name: t.name,
        zoneId: t.zone_id,
        zoneName: zoneName.get(t.zone_id) || null,
        capacityMin: t.capacity_min,
        capacityMax: t.capacity_max,
        position: t.pos_x == null || t.pos_y == null ? null : { x: num(t.pos_x), y: num(t.pos_y) },
        active: !!t.active,
      })),
      combinations: pc,
    };
  });
}

// --- Endpoints ---------------------------------------------------------------

// Índice (público): qué hay disponible. No devuelve datos de ningún local.
router.get('/', (req, res) => {
  res.json({
    name: 'API de planos de sala — Grupo Saona',
    version: 'v1',
    auth: 'Cabecera X-API-Key: <clave> (o Authorization: Bearer <clave>)',
    endpoints: [
      'GET /api/v1/restaurants',
      'GET /api/v1/restaurants/{id}?plans=default|all&date=YYYY-MM-DD&includeInactive=1',
      'GET /api/v1/restaurants/{id}/floor-plans',
      'GET /api/v1/floor-plans/{id}?includeInactive=1',
      'GET /api/v1/export?plans=default|all',
    ],
  });
});

// Lista de locales con el resumen de sus planos (sin mesas).
router.get('/restaurants', requireApiKey, async (req, res, next) => {
  try {
    const { rows: rs } = await db.query('SELECT * FROM restaurants ORDER BY name');
    const { rows: plans } = await db.query(`
      SELECT p.id, p.restaurant_id, p.name, p.is_default,
             COUNT(t.id) FILTER (WHERE t.active = 1)::int AS tables,
             COALESCE(SUM(t.capacity_max) FILTER (WHERE t.active = 1), 0)::int AS seats_max
      FROM floor_plans p LEFT JOIN tables t ON t.floor_plan_id = p.id
      GROUP BY p.id ORDER BY p.is_default DESC, p.id`);
    res.json({
      count: rs.length,
      restaurants: rs.map(r => ({
        ...shapeRestaurant(r),
        floorPlans: plans.filter(p => p.restaurant_id === r.id).map(p => ({
          id: p.id, name: p.name, isDefault: !!p.is_default, tables: p.tables, seatsMax: p.seats_max,
        })),
      })),
    });
  } catch (err) { next(err); }
});

async function getRestaurantOr404(id, res) {
  const { rows } = await db.query('SELECT * FROM restaurants WHERE id = $1', [Number(id) || 0]);
  if (!rows.length) { res.status(404).json({ error: 'Local no encontrado.' }); return null; }
  return rows[0];
}

// Un local con sus planos completos. plans=default (por defecto) | all.
// date=YYYY-MM-DD → indica qué plano aplica ese día (agenda de planos) y, con
// plans=default, devuelve ese plano en lugar del marcado por defecto.
router.get('/restaurants/:id', requireApiKey, async (req, res, next) => {
  try {
    const r = await getRestaurantOr404(req.params.id, res);
    if (!r) return;
    const { date } = req.query;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date debe ser YYYY-MM-DD.' });
    const activeId = date ? await availability.resolveFloorPlanId(r.id, date) : null;
    const includeInactive = req.query.includeInactive === '1';
    let plans;
    if (req.query.plans === 'all') {
      plans = await loadPlans({ restaurantId: r.id, includeInactive });
    } else if (activeId) {
      plans = await loadPlans({ planIds: [activeId], includeInactive });
    } else {
      plans = (await loadPlans({ restaurantId: r.id, includeInactive })).filter(p => p.isDefault).slice(0, 1);
    }
    res.json({ ...shapeRestaurant(r), ...(date ? { date, activeFloorPlanId: activeId } : {}), floorPlans: plans });
  } catch (err) { next(err); }
});

// Todos los planos completos de un local (atajo de ?plans=all).
router.get('/restaurants/:id/floor-plans', requireApiKey, async (req, res, next) => {
  try {
    const r = await getRestaurantOr404(req.params.id, res);
    if (!r) return;
    res.json({ restaurantId: r.id, floorPlans: await loadPlans({ restaurantId: r.id, includeInactive: req.query.includeInactive === '1' }) });
  } catch (err) { next(err); }
});

// Un plano concreto.
router.get('/floor-plans/:id', requireApiKey, async (req, res, next) => {
  try {
    const [plan] = await loadPlans({ planIds: [Number(req.params.id) || 0], includeInactive: req.query.includeInactive === '1' });
    if (!plan) return res.status(404).json({ error: 'Plano no encontrado.' });
    res.json(plan);
  } catch (err) { next(err); }
});

// Volcado completo de todos los locales (para sincronizaciones nocturnas).
// plans=default (por defecto, ~1 MB) | all (todos los planos, ~3-4 MB).
router.get('/export', requireApiKey, async (req, res, next) => {
  try {
    const all = req.query.plans === 'all';
    const { rows: rs } = await db.query('SELECT * FROM restaurants ORDER BY name');
    // Todos los planos en una sola carga (4 consultas en total, no 4 por local).
    const { rows: planRows } = await db.query(
      all ? 'SELECT id FROM floor_plans' : 'SELECT DISTINCT ON (restaurant_id) id FROM floor_plans WHERE is_default = 1 ORDER BY restaurant_id, id');
    const plans = await loadPlans({ planIds: planRows.map(p => p.id), includeInactive: req.query.includeInactive === '1' });
    const out = rs.map(r => ({ ...shapeRestaurant(r), floorPlans: plans.filter(p => p.restaurantId === r.id) }));
    res.json({ generatedAt: new Date().toISOString(), count: out.length, restaurants: out });
  } catch (err) { next(err); }
});

// Errores de esta API siempre en JSON.
router.use((err, req, res, _next) => {
  console.error('[api v1]', err);
  res.status(500).json({ error: 'Error interno.' });
});

module.exports = router;
module.exports.loadPlans = loadPlans;
