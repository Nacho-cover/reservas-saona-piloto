const express = require('express');
const cors = require('cors');
const path = require('path');
const dayjs = require('dayjs');
const db = require('./db');
const availability = require('./availability');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Helpers -----------------------------------------------------------
function getRestaurant(id) {
  return db.prepare('SELECT * FROM restaurants WHERE id = ?').get(id);
}

function requireRestaurant(req, res, next) {
  const id = Number(req.params.restaurantId || req.query.restaurantId || req.body.restaurantId || 1);
  const r = getRestaurant(id);
  if (!r) return res.status(404).json({ error: 'Restaurante no encontrado' });
  req.restaurant = r;
  next();
}

// --- Public: restaurant info -------------------------------------------
app.get('/api/restaurants/:restaurantId', requireRestaurant, (req, res) => {
  res.json(req.restaurant);
});

// --- Public: availability -----------------------------------------------
// GET /api/availability?restaurantId=1&date=2026-08-15&partySize=4
app.get('/api/availability', requireRestaurant, (req, res) => {
  const { date, partySize } = req.query;
  if (!date || !partySize) return res.status(400).json({ error: 'date y partySize son obligatorios' });
  if (dayjs(date).isBefore(dayjs().subtract(1, 'day'))) {
    return res.status(400).json({ error: 'La fecha ya ha pasado' });
  }
  const slots = availability.getAvailability(req.restaurant, date, Number(partySize));
  res.json({ date, partySize: Number(partySize), slots });
});

// --- Public: real floor plan (per-table status) for a chosen date/time/party ---
// GET /api/table-map?restaurantId=1&date=2026-08-15&time=13:00&partySize=4
app.get('/api/table-map', requireRestaurant, (req, res) => {
  const { date, time, partySize } = req.query;
  if (!date || !time || !partySize) {
    return res.status(400).json({ error: 'date, time y partySize son obligatorios' });
  }
  const restaurant = req.restaurant;
  const startMinutes = availability.toMinutes(time);
  const map = availability.getTableMap(
    restaurant.id, date, startMinutes, restaurant.default_duration_minutes,
    Number(partySize), restaurant.turnover_buffer_minutes
  );
  res.json(map);
});

// --- Reservations: create (web / app / phone via admin) -----------------
app.post('/api/reservations', requireRestaurant, (req, res) => {
  const { customerName, phone, email, partySize, date, time, notes, source, consentAccepted } = req.body;
  if (!customerName || !partySize || !date || !time) {
    return res.status(400).json({ error: 'customerName, partySize, date y time son obligatorios' });
  }
  const restaurant = req.restaurant;
  const bookingSource = source || 'web';

  if (Number(partySize) > restaurant.max_party_size) {
    return res.status(400).json({ error: `Para grupos de más de ${restaurant.max_party_size} personas, contacta directamente con el restaurante.` });
  }

  // Ventana de reserva: antelación máxima/mínima (igual que "Cuándo se puede reservar" en Cover).
  // Solo se aplica a reservas hechas por el propio cliente (web/app); el personal puede anotar
  // por teléfono fuera de esa ventana si hace falta.
  if (bookingSource === 'web' || bookingSource === 'app') {
    const now = dayjs();
    const requestedAt = dayjs(`${date}T${time}`);
    const minAllowed = now.add(restaurant.min_advance_minutes, 'minute');
    const maxAllowed = now.add(restaurant.max_advance_days, 'day');
    if (requestedAt.isBefore(minAllowed)) {
      return res.status(400).json({ error: `Esta reserva requiere al menos ${restaurant.min_advance_minutes} minutos de antelación.` });
    }
    if (requestedAt.isAfter(maxAllowed)) {
      return res.status(400).json({ error: `Solo se puede reservar con un máximo de ${restaurant.max_advance_days} días de antelación.` });
    }
    if (!consentAccepted) {
      return res.status(400).json({ error: 'Debes aceptar las condiciones de tratamiento de datos para reservar.' });
    }
  }

  const duration = restaurant.default_duration_minutes;
  const buffer = restaurant.turnover_buffer_minutes;
  const startMinutes = availability.toMinutes(time);

  // If the customer picked a specific table (or combo) on the visual floor plan, honor
  // that choice — but re-validate it fresh rather than trusting what the client sent,
  // since time may have passed since the floor plan was shown. Admin/phone bookings (and
  // any client that doesn't send tableIds) keep the old auto-assign behavior.
  let tables;
  if (Array.isArray(req.body.tableIds) && req.body.tableIds.length) {
    tables = availability.validateChosenTables(
      restaurant.id, date, req.body.tableIds, startMinutes, duration, Number(partySize), buffer, null
    );
    if (!tables) {
      return res.status(409).json({ error: 'La mesa elegida ya no está disponible. Vuelve a elegir mesa en el plano.' });
    }
  } else {
    tables = availability.findAvailableTable(
      restaurant.id, date, startMinutes, duration, Number(partySize), buffer, null
    );
    if (!tables) {
      return res.status(409).json({ error: 'Ya no hay disponibilidad para esa franja. Elige otra hora.' });
    }
  }
  if (!availability.hasCapacityRoom(restaurant.id, date, startMinutes, Number(partySize), null)) {
    return res.status(409).json({ error: 'Se ha alcanzado el aforo máximo para esa franja horaria. Elige otra hora.' });
  }

  const tx = db.transaction(() => {
    let customer = null;
    if (phone) {
      customer = db.prepare('SELECT * FROM customers WHERE restaurant_id = ? AND phone = ?').get(restaurant.id, phone);
      if (!customer) {
        const info = db.prepare(
          'INSERT INTO customers (restaurant_id, name, phone, email, visits) VALUES (?,?,?,?,1)'
        ).run(restaurant.id, customerName, phone, email || null);
        customer = { id: info.lastInsertRowid };
      } else {
        db.prepare('UPDATE customers SET visits = visits + 1, name = ?, email = COALESCE(?, email) WHERE id = ?')
          .run(customerName, email || null, customer.id);
      }
    }

    const info = db.prepare(`
      INSERT INTO reservations (restaurant_id, customer_id, customer_name, phone, email, party_size, date, time, duration_minutes, status, source, notes, consent_accepted)
      VALUES (?,?,?,?,?,?,?,?,?, 'confirmed', ?, ?, ?)
    `).run(restaurant.id, customer ? customer.id : null, customerName, phone || null, email || null,
           Number(partySize), date, time, duration, bookingSource, notes || null, consentAccepted ? 1 : 0);

    const reservationId = info.lastInsertRowid;
    const insertRT = db.prepare('INSERT INTO reservation_tables (reservation_id, table_id) VALUES (?, ?)');
    for (const t of tables) insertRT.run(reservationId, t.id);

    return reservationId;
  });

  const reservationId = tx();
  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId);
  // El cliente debe saber en qué zona ha quedado su reserva (p. ej. Barra en vez de
  // sala), ya que el sistema asigna la mesa automáticamente sin que él elija.
  const zoneNameById = {};
  db.prepare('SELECT id, name FROM zones WHERE restaurant_id = ?').all(restaurant.id)
    .forEach(z => { zoneNameById[z.id] = z.name; });
  const zoneNames = [...new Set(tables.map(t => zoneNameById[t.zone_id]).filter(Boolean))];
  res.status(201).json({ ...reservation, tables: tables.map(t => t.name), zoneNames });
});

// --- Reservations: list (admin) ------------------------------------------
app.get('/api/reservations', requireRestaurant, (req, res) => {
  const { date } = req.query;
  let rows;
  if (date) {
    rows = db.prepare('SELECT * FROM reservations WHERE restaurant_id = ? AND date = ? ORDER BY time').all(req.restaurant.id, date);
  } else {
    rows = db.prepare('SELECT * FROM reservations WHERE restaurant_id = ? ORDER BY date DESC, time').all(req.restaurant.id);
  }
  const tableStmt = db.prepare(`
    SELECT t.name FROM reservation_tables rt JOIN tables t ON t.id = rt.table_id WHERE rt.reservation_id = ?
  `);
  const withTables = rows.map(r => ({ ...r, tables: tableStmt.all(r.id).map(t => t.name) }));
  res.json(withTables);
});

// --- Reservations: update status (admin) ---------------------------------
app.patch('/api/reservations/:id', (req, res) => {
  const { status, notes } = req.body;
  const allowed = ['confirmed', 'seated', 'completed', 'cancelled', 'no_show'];
  const existing = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Reserva no encontrada' });
  if (status && !allowed.includes(status)) return res.status(400).json({ error: 'Estado no válido' });

  db.prepare('UPDATE reservations SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?')
    .run(status || null, notes ?? null, req.params.id);
  res.json(db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id));
});

// --- Reservations: delete/cancel ------------------------------------------
app.delete('/api/reservations/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Reserva no encontrada' });
  db.prepare("UPDATE reservations SET status = 'cancelled' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// --- Shifts (admin) ---------------------------------------------------------
app.get('/api/shifts', requireRestaurant, (req, res) => {
  res.json(db.prepare('SELECT * FROM shifts WHERE restaurant_id = ? ORDER BY day_of_week, start_time').all(req.restaurant.id));
});

// =========================================================================
// Planos de sala, zonas, mesas y combinaciones (configuración del local)
// =========================================================================
// Un local puede tener varios planos (p. ej. "Plano estándar" y "Plano evento").
// Las reservas ya creadas SIEMPRE referencian mesas por su id (reservation_tables),
// así que crear, renombrar o programar planos nunca altera reservas existentes —
// solo cambia qué mesas/combinaciones se ofrecen para NUEVAS reservas a partir de
// una fecha dada.

// --- Floor plans -----------------------------------------------------------
app.get('/api/floor-plans', requireRestaurant, (req, res) => {
  const plans = db.prepare('SELECT * FROM floor_plans WHERE restaurant_id = ? ORDER BY is_default DESC, name').all(req.restaurant.id);
  const countStmt = db.prepare('SELECT COUNT(*) c FROM tables WHERE floor_plan_id = ? AND active = 1');
  res.json(plans.map(p => ({ ...p, tableCount: countStmt.get(p.id).c })));
});

app.post('/api/floor-plans', requireRestaurant, (req, res) => {
  const { name, cloneFromId } = req.body;
  if (!name) return res.status(400).json({ error: 'name es obligatorio' });
  const restaurant = req.restaurant;

  const tx = db.transaction(() => {
    const info = db.prepare('INSERT INTO floor_plans (restaurant_id, name, is_default) VALUES (?,?,0)').run(restaurant.id, name);
    const newPlanId = info.lastInsertRowid;

    if (cloneFromId) {
      const source = db.prepare('SELECT * FROM floor_plans WHERE id = ? AND restaurant_id = ?').get(cloneFromId, restaurant.id);
      if (!source) throw Object.assign(new Error('El plano de origen no existe'), { status: 400 });

      const zoneIdMap = new Map();
      for (const z of db.prepare('SELECT * FROM zones WHERE floor_plan_id = ?').all(cloneFromId)) {
        const zInfo = db.prepare('INSERT INTO zones (restaurant_id, floor_plan_id, name, sort_order) VALUES (?,?,?,?)')
          .run(restaurant.id, newPlanId, z.name, z.sort_order);
        zoneIdMap.set(z.id, zInfo.lastInsertRowid);
      }
      const tableIdMap = new Map();
      for (const t of db.prepare('SELECT * FROM tables WHERE floor_plan_id = ? AND active = 1').all(cloneFromId)) {
        const tInfo = db.prepare(`
          INSERT INTO tables (restaurant_id, floor_plan_id, zone_id, name, capacity_min, capacity_max, pos_x, pos_y, active)
          VALUES (?,?,?,?,?,?,?,?,1)
        `).run(restaurant.id, newPlanId, t.zone_id ? zoneIdMap.get(t.zone_id) : null, t.name, t.capacity_min, t.capacity_max, t.pos_x, t.pos_y);
        tableIdMap.set(t.id, tInfo.lastInsertRowid);
      }
      for (const c of db.prepare('SELECT * FROM table_combinations WHERE floor_plan_id = ? AND active = 1').all(cloneFromId)) {
        const cInfo = db.prepare('INSERT INTO table_combinations (restaurant_id, floor_plan_id, name, active) VALUES (?,?,?,1)')
          .run(restaurant.id, newPlanId, c.name);
        const members = db.prepare('SELECT table_id FROM table_combination_members WHERE combination_id = ?').all(c.id);
        const insertMember = db.prepare('INSERT INTO table_combination_members (combination_id, table_id) VALUES (?,?)');
        for (const m of members) insertMember.run(cInfo.lastInsertRowid, tableIdMap.get(m.table_id));
      }
    }
    return newPlanId;
  });

  let newPlanId;
  try {
    newPlanId = tx();
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  res.status(201).json(db.prepare('SELECT * FROM floor_plans WHERE id = ?').get(newPlanId));
});

app.patch('/api/floor-plans/:id', (req, res) => {
  const plan = db.prepare('SELECT * FROM floor_plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plano no encontrado' });
  const { name, isDefault } = req.body;

  const tx = db.transaction(() => {
    if (name) db.prepare('UPDATE floor_plans SET name = ? WHERE id = ?').run(name, plan.id);
    if (isDefault) {
      db.prepare('UPDATE floor_plans SET is_default = 0 WHERE restaurant_id = ?').run(plan.restaurant_id);
      db.prepare('UPDATE floor_plans SET is_default = 1 WHERE id = ?').run(plan.id);
    }
  });
  tx();
  res.json(db.prepare('SELECT * FROM floor_plans WHERE id = ?').get(plan.id));
});

// --- Agenda: qué plano aplica cada fecha ------------------------------------
app.get('/api/floor-plan-schedule', requireRestaurant, (req, res) => {
  const { from, to } = req.query;
  let rows;
  if (from && to) {
    rows = db.prepare('SELECT * FROM floor_plan_schedule WHERE restaurant_id = ? AND date BETWEEN ? AND ? ORDER BY date')
      .all(req.restaurant.id, from, to);
  } else {
    rows = db.prepare('SELECT * FROM floor_plan_schedule WHERE restaurant_id = ? ORDER BY date').all(req.restaurant.id);
  }
  res.json(rows);
});

// Asigna (o reasigna) qué plano aplica un día concreto. No modifica ninguna reserva
// ya existente para esa fecha: solo cambia qué mesas se ofrecen para reservas NUEVAS.
app.put('/api/floor-plan-schedule', requireRestaurant, (req, res) => {
  const { date, floorPlanId } = req.body;
  if (!date || !floorPlanId) return res.status(400).json({ error: 'date y floorPlanId son obligatorios' });
  const plan = db.prepare('SELECT * FROM floor_plans WHERE id = ? AND restaurant_id = ?').get(floorPlanId, req.restaurant.id);
  if (!plan) return res.status(400).json({ error: 'Ese plano no existe para este local' });

  db.prepare(`
    INSERT INTO floor_plan_schedule (restaurant_id, date, floor_plan_id) VALUES (?,?,?)
    ON CONFLICT(restaurant_id, date) DO UPDATE SET floor_plan_id = excluded.floor_plan_id
  `).run(req.restaurant.id, date, floorPlanId);

  res.json({ ok: true, date, floorPlanId });
});

// Quita la asignación específica de un día: ese día vuelve a usar el plano por defecto.
app.delete('/api/floor-plan-schedule', requireRestaurant, (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date es obligatorio' });
  db.prepare('DELETE FROM floor_plan_schedule WHERE restaurant_id = ? AND date = ?').run(req.restaurant.id, date);
  res.json({ ok: true });
});

// --- Zonas -------------------------------------------------------------------
app.get('/api/zones', requireRestaurant, (req, res) => {
  const { floorPlanId } = req.query;
  if (!floorPlanId) return res.status(400).json({ error: 'floorPlanId es obligatorio' });
  res.json(db.prepare('SELECT * FROM zones WHERE restaurant_id = ? AND floor_plan_id = ? ORDER BY sort_order, name')
    .all(req.restaurant.id, floorPlanId));
});

app.post('/api/zones', requireRestaurant, (req, res) => {
  const { floorPlanId, name, sortOrder } = req.body;
  if (!floorPlanId || !name) return res.status(400).json({ error: 'floorPlanId y name son obligatorios' });
  const info = db.prepare('INSERT INTO zones (restaurant_id, floor_plan_id, name, sort_order) VALUES (?,?,?,?)')
    .run(req.restaurant.id, floorPlanId, name, sortOrder || 0);
  res.status(201).json(db.prepare('SELECT * FROM zones WHERE id = ?').get(info.lastInsertRowid));
});

app.delete('/api/zones/:id', (req, res) => {
  const tx = db.transaction(() => {
    db.prepare('UPDATE tables SET zone_id = NULL WHERE zone_id = ?').run(req.params.id);
    db.prepare('DELETE FROM zones WHERE id = ?').run(req.params.id);
  });
  tx();
  res.json({ ok: true });
});

// --- Mesas ---------------------------------------------------------------------
app.get('/api/tables', requireRestaurant, (req, res) => {
  const { floorPlanId } = req.query;
  const planId = floorPlanId || availability.resolveFloorPlanId(req.restaurant.id, dayjs().format('YYYY-MM-DD'));
  const zoneStmt = db.prepare('SELECT name FROM zones WHERE id = ?');
  const rows = db.prepare('SELECT * FROM tables WHERE restaurant_id = ? AND floor_plan_id = ? AND active = 1 ORDER BY name')
    .all(req.restaurant.id, planId);
  res.json(rows.map(t => ({ ...t, zoneName: t.zone_id ? (zoneStmt.get(t.zone_id) || {}).name : null })));
});

app.post('/api/tables', requireRestaurant, (req, res) => {
  const { floorPlanId, zoneId, name, capacityMin, capacityMax } = req.body;
  if (!floorPlanId || !name || !capacityMax) {
    return res.status(400).json({ error: 'floorPlanId, name y capacityMax son obligatorios' });
  }
  const info = db.prepare(`
    INSERT INTO tables (restaurant_id, floor_plan_id, zone_id, name, capacity_min, capacity_max, active)
    VALUES (?,?,?,?,?,?,1)
  `).run(req.restaurant.id, floorPlanId, zoneId || null, name, capacityMin || 1, capacityMax);
  res.status(201).json(db.prepare('SELECT * FROM tables WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/tables/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Mesa no encontrada' });
  const { name, zoneId, capacityMin, capacityMax } = req.body;
  db.prepare(`
    UPDATE tables SET name = COALESCE(?, name), zone_id = COALESCE(?, zone_id),
      capacity_min = COALESCE(?, capacity_min), capacity_max = COALESCE(?, capacity_max)
    WHERE id = ?
  `).run(name || null, zoneId || null, capacityMin || null, capacityMax || null, req.params.id);
  res.json(db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id));
});

// Baja lógica: nunca se borra la fila físicamente, para no romper reservas ya
// creadas que la referencian (reservation_tables.table_id).
app.delete('/api/tables/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Mesa no encontrada' });
  db.prepare('UPDATE tables SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Combinaciones de mesas ----------------------------------------------------
app.get('/api/combinations', requireRestaurant, (req, res) => {
  const { floorPlanId } = req.query;
  if (!floorPlanId) return res.status(400).json({ error: 'floorPlanId es obligatorio' });
  const combos = db.prepare('SELECT * FROM table_combinations WHERE restaurant_id = ? AND floor_plan_id = ? AND active = 1')
    .all(req.restaurant.id, floorPlanId);
  const memberStmt = db.prepare(`
    SELECT t.id, t.name, t.capacity_max FROM table_combination_members tcm
    JOIN tables t ON t.id = tcm.table_id WHERE tcm.combination_id = ?
  `);
  res.json(combos.map(c => {
    const tables = memberStmt.all(c.id);
    const sumMax = tables.reduce((s, t) => s + t.capacity_max, 0);
    // capacity_min/capacity_max: aforo fijado a mano (como en Cover), que puede no
    // coincidir con la suma de las mesas — si no se fijó, se sigue calculando como suma.
    return { ...c, tables, combinedMax: c.capacity_max != null ? c.capacity_max : sumMax };
  }));
});

app.post('/api/combinations', requireRestaurant, (req, res) => {
  const { floorPlanId, name, tableIds, capacityMin, capacityMax } = req.body;
  if (!floorPlanId || !name || !Array.isArray(tableIds) || tableIds.length < 2) {
    return res.status(400).json({ error: 'floorPlanId, name y al menos 2 tableIds son obligatorios' });
  }
  const placeholders = tableIds.map(() => '?').join(',');
  const validTables = db.prepare(`SELECT id FROM tables WHERE floor_plan_id = ? AND id IN (${placeholders})`)
    .all(floorPlanId, ...tableIds);
  if (validTables.length !== tableIds.length) {
    return res.status(400).json({ error: 'Todas las mesas de la combinación deben pertenecer al mismo plano' });
  }

  const tx = db.transaction(() => {
    const info = db.prepare('INSERT INTO table_combinations (restaurant_id, floor_plan_id, name, active, capacity_min, capacity_max) VALUES (?,?,?,1,?,?)')
      .run(req.restaurant.id, floorPlanId, name, capacityMin || null, capacityMax || null);
    const insertMember = db.prepare('INSERT INTO table_combination_members (combination_id, table_id) VALUES (?,?)');
    for (const tid of tableIds) insertMember.run(info.lastInsertRowid, tid);
    return info.lastInsertRowid;
  });
  const id = tx();
  res.status(201).json(db.prepare('SELECT * FROM table_combinations WHERE id = ?').get(id));
});

app.delete('/api/combinations/:id', (req, res) => {
  db.prepare('DELETE FROM table_combinations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de reservas escuchando en http://localhost:${PORT}`);
});
