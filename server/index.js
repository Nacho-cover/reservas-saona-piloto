const express = require('express');
const cors = require('cors');
const path = require('path');
const dayjs = require('dayjs');
const db = require('./db');
const availability = require('./availability');
const adminAuth = require('./adminAuth');
const { sendConfirmationEmail } = require('./email');
const { verifySurveyToken, sendSurveyEmail } = require('./survey');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Helpers -----------------------------------------------------------
async function getRestaurant(id) {
  const { rows } = await db.query('SELECT * FROM restaurants WHERE id = $1', [id]);
  return rows[0];
}

async function requireRestaurant(req, res, next) {
  const id = Number(req.params.restaurantId || req.query.restaurantId || req.body.restaurantId || 1);
  const r = await getRestaurant(id);
  if (!r) return res.status(404).json({ error: 'Restaurante no encontrado' });
  req.restaurant = r;
  next();
}

// --- Autenticación del panel de personal (usuario/contraseña compartidos) -----
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const cred = await adminAuth.getCredential();
  if (!cred || !username || !password || username.trim().toLowerCase() !== cred.username.toLowerCase() ||
      !adminAuth.verifyPassword(password, cred.password_hash)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  adminAuth.setSessionCookie(res, adminAuth.createSession());
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  adminAuth.destroySession(adminAuth.parseCookies(req).admin_session);
  adminAuth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ authenticated: adminAuth.isValidSession(adminAuth.parseCookies(req).admin_session) });
});

app.post('/api/admin/change-password', adminAuth.requireAdminAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 6 caracteres.' });
  }
  const cred = await adminAuth.getCredential();
  if (!adminAuth.verifyPassword(currentPassword, cred.password_hash)) {
    return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
  }
  await db.query('UPDATE admin_credentials SET password_hash = $1, updated_at = $2 WHERE id = $3',
    [adminAuth.hashPassword(newPassword), dayjs().format('YYYY-MM-DD HH:mm:ss'), cred.id]);
  res.json({ ok: true });
});

// --- Public: restaurant info -------------------------------------------
app.get('/api/restaurants/:restaurantId', requireRestaurant, (req, res) => {
  res.json(req.restaurant);
});

// --- Public: availability -----------------------------------------------
// GET /api/availability?restaurantId=1&date=2026-08-15&partySize=4
app.get('/api/availability', requireRestaurant, async (req, res) => {
  const { date, partySize } = req.query;
  if (!date || !partySize) return res.status(400).json({ error: 'date y partySize son obligatorios' });
  if (dayjs(date).isBefore(dayjs().subtract(1, 'day'))) {
    return res.status(400).json({ error: 'La fecha ya ha pasado' });
  }
  const slots = await availability.getAvailability(req.restaurant, date, Number(partySize));
  res.json({ date, partySize: Number(partySize), slots });
});

// --- Public: real floor plan (per-table status) for a chosen date/time/party ---
// GET /api/table-map?restaurantId=1&date=2026-08-15&time=13:00&partySize=4
app.get('/api/table-map', requireRestaurant, async (req, res) => {
  const { date, time, partySize, excludeReservationId, durationMinutes } = req.query;
  if (!date || !time || !partySize) {
    return res.status(400).json({ error: 'date, time y partySize son obligatorios' });
  }
  const restaurant = req.restaurant;
  const startMinutes = availability.toMinutes(time);
  const map = await availability.getTableMap(
    restaurant.id, date, startMinutes,
    durationMinutes ? Number(durationMinutes) : restaurant.default_duration_minutes,
    Number(partySize), restaurant.turnover_buffer_minutes,
    excludeReservationId ? Number(excludeReservationId) : null
  );
  res.json(map);
});

// --- Reservations: create (web / app / phone via admin) -----------------
app.post('/api/reservations', requireRestaurant, async (req, res) => {
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
    if (!email) {
      return res.status(400).json({ error: 'Indica un email para poder enviarte la confirmación de la reserva.' });
    }
    if (await availability.isClosed(restaurant.id, date)) {
      return res.status(409).json({ error: 'El restaurante está cerrado ese día. Elige otra fecha.' });
    }
    const requestedMinutes = availability.toMinutes(time);
    const shiftsForDate = await availability.getShiftsForDate(restaurant.id, date);
    const matchingShift = shiftsForDate
      .find(s => requestedMinutes >= availability.toMinutes(s.start_time) && requestedMinutes <= availability.toMinutes(s.end_time));
    const closed = await availability.closedShifts(restaurant.id, date);
    if (matchingShift && closed.has(matchingShift.name)) {
      return res.status(409).json({ error: `El turno de ${matchingShift.name} no admite más reservas ese día. Elige otra hora.` });
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
    tables = await availability.validateChosenTables(
      restaurant.id, date, req.body.tableIds, startMinutes, duration, Number(partySize), buffer, null
    );
    if (!tables) {
      return res.status(409).json({ error: 'La mesa elegida ya no está disponible. Vuelve a elegir mesa en el plano.' });
    }
  } else {
    tables = await availability.findAvailableTable(
      restaurant.id, date, startMinutes, duration, Number(partySize), buffer, null
    );
    if (!tables) {
      return res.status(409).json({ error: 'Ya no hay disponibilidad para esa franja. Elige otra hora.' });
    }
  }
  if (!(await availability.hasCapacityRoom(restaurant.id, date, startMinutes, Number(partySize), null))) {
    return res.status(409).json({ error: 'Se ha alcanzado el aforo máximo para esa franja horaria. Elige otra hora.' });
  }

  const reservationId = await db.withTransaction(async (client) => {
    let customer = null;
    if (phone) {
      const { rows: existingCustomer } = await client.query(
        'SELECT * FROM customers WHERE restaurant_id = $1 AND phone = $2', [restaurant.id, phone]
      );
      if (!existingCustomer.length) {
        const { rows: inserted } = await client.query(
          'INSERT INTO customers (restaurant_id, name, phone, email, visits) VALUES ($1,$2,$3,$4,1) RETURNING id',
          [restaurant.id, customerName, phone, email || null]
        );
        customer = { id: inserted[0].id };
      } else {
        customer = existingCustomer[0];
        await client.query('UPDATE customers SET visits = visits + 1, name = $1, email = COALESCE($2, email) WHERE id = $3',
          [customerName, email || null, customer.id]);
      }
    }

    const { rows: inserted } = await client.query(`
      INSERT INTO reservations (restaurant_id, customer_id, customer_name, phone, email, party_size, date, time, duration_minutes, status, source, notes, consent_accepted)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, 'confirmed', $10, $11, $12) RETURNING id
    `, [restaurant.id, customer ? customer.id : null, customerName, phone || null, email || null,
        Number(partySize), date, time, duration, bookingSource, notes || null, consentAccepted ? 1 : 0]);

    const reservationId = inserted[0].id;
    for (const t of tables) {
      await client.query('INSERT INTO reservation_tables (reservation_id, table_id) VALUES ($1, $2)', [reservationId, t.id]);
    }
    return reservationId;
  });

  const { rows: reservationRows } = await db.query('SELECT * FROM reservations WHERE id = $1', [reservationId]);
  const reservation = reservationRows[0];
  // El cliente debe saber en qué zona ha quedado su reserva (p. ej. Barra en vez de
  // sala), ya que el sistema asigna la mesa automáticamente sin que él elija.
  const { rows: zoneRows } = await db.query('SELECT id, name FROM zones WHERE restaurant_id = $1', [restaurant.id]);
  const zoneNameById = {};
  zoneRows.forEach(z => { zoneNameById[z.id] = z.name; });
  const zoneNames = [...new Set(tables.map(t => zoneNameById[t.zone_id]).filter(Boolean))];

  // No se espera a que termine de enviarse (la reserva ya está confirmada y no debe
  // depender de que el email salga bien o mal) — se manda en paralelo a responder.
  if (bookingSource === 'web' || bookingSource === 'app') {
    sendConfirmationEmail({ restaurant, reservation, zoneNames }).catch(() => {});
  }

  res.status(201).json({ ...reservation, tables: tables.map(t => t.name), zoneNames });
});

// --- Reservations: list (admin) ------------------------------------------
app.get('/api/reservations', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { date } = req.query;
  let rows;
  if (date) {
    ({ rows } = await db.query('SELECT * FROM reservations WHERE restaurant_id = $1 AND date = $2 ORDER BY time', [req.restaurant.id, date]));
  } else {
    ({ rows } = await db.query('SELECT * FROM reservations WHERE restaurant_id = $1 ORDER BY date DESC, time', [req.restaurant.id]));
  }
  if (!rows.length) return res.json([]);
  // Una sola consulta con IN(...) para todas las reservas del día, en vez de una
  // por reserva (con muchas reservas a la vez, el pooler de Supabase tiene un
  // límite de conexiones concurrentes que un Promise.all por fila puede agotar).
  const ids = rows.map(r => r.id);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows: tableRows } = await db.query(`
    SELECT rt.reservation_id, t.name FROM reservation_tables rt JOIN tables t ON t.id = rt.table_id
    WHERE rt.reservation_id IN (${placeholders})
  `, ids);
  const tablesByReservation = {};
  for (const tr of tableRows) {
    (tablesByReservation[tr.reservation_id] = tablesByReservation[tr.reservation_id] || []).push(tr.name);
  }
  res.json(rows.map(r => ({ ...r, tables: tablesByReservation[r.id] || [] })));
});

// Resumen por día (para la vista mensual) — cuántas reservas y comensales hay cada
// día en un rango, sin traer el detalle completo de cada reserva.
app.get('/api/reservations/summary', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from y to son obligatorios' });
  const { rows } = await db.query(`
    SELECT date, COUNT(*)::int AS reservations, SUM(party_size)::int AS covers
    FROM reservations
    WHERE restaurant_id = $1 AND date BETWEEN $2 AND $3 AND status != 'cancelled'
    GROUP BY date
  `, [req.restaurant.id, from, to]);
  res.json(rows);
});

// --- Reservations: update status (admin) ---------------------------------
app.patch('/api/reservations/:id', adminAuth.requireAdminAuth, async (req, res) => {
  const { status, notes, cancelledBy } = req.body;
  const allowed = ['confirmed', 'seated', 'eating', 'dessert', 'paid', 'completed', 'cancelled', 'no_show'];
  const { rows: existingRows } = await db.query('SELECT * FROM reservations WHERE id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Reserva no encontrada' });
  if (status && !allowed.includes(status)) return res.status(400).json({ error: 'Estado no válido' });
  // Al cancelar hace falta saber quién cancela (lo pide el restaurante o lo pide el
  // cliente), ya que cambia lo que hay que hacer después (p. ej. si aplica algún cargo).
  if (status === 'cancelled' && !['restaurant', 'customer'].includes(cancelledBy)) {
    return res.status(400).json({ error: 'Indica quién cancela: el restaurante o el cliente.' });
  }

  // Al pasar a "Pagada" se guarda el momento exacto: la mesa se libera 2 min después
  // de esto (ver availability.tableBusyRanges), no al terminar la duración estándar.
  const paidAt = (status === 'paid' && existing.status !== 'paid') ? dayjs().format('YYYY-MM-DD HH:mm:ss') : null;
  const cancelledByValue = status === 'cancelled' ? cancelledBy : null;

  await db.query(`
    UPDATE reservations
    SET status = COALESCE($1, status), notes = COALESCE($2, notes), paid_at = COALESCE($3, paid_at),
        cancelled_by = COALESCE($4, cancelled_by)
    WHERE id = $5
  `, [status || null, notes ?? null, paidAt, cancelledByValue, req.params.id]);
  const { rows } = await db.query('SELECT * FROM reservations WHERE id = $1', [req.params.id]);
  res.json(rows[0]);
});

// --- Reservations: delete/cancel ------------------------------------------
app.delete('/api/reservations/:id', adminAuth.requireAdminAuth, async (req, res) => {
  const { rows: existingRows } = await db.query('SELECT * FROM reservations WHERE id = $1', [req.params.id]);
  if (!existingRows.length) return res.status(404).json({ error: 'Reserva no encontrada' });
  await db.query("UPDATE reservations SET status = 'cancelled' WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// --- Reservations: move to a different table/combo (admin) -----------------
app.patch('/api/reservations/:id/table', adminAuth.requireAdminAuth, async (req, res) => {
  const { tableIds } = req.body;
  if (!Array.isArray(tableIds) || !tableIds.length) {
    return res.status(400).json({ error: 'Elige una mesa.' });
  }
  const { rows: existingRows } = await db.query('SELECT * FROM reservations WHERE id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Reserva no encontrada' });
  const restaurant = await getRestaurant(existing.restaurant_id);

  // Revalida en el momento del traslado (no se fía de lo que mostró el plano al
  // personal, por si otra reserva ocupó esa mesa mientras tanto) — excluye la propia
  // reserva de la comprobación de choques, igual que hace validateChosenTables al crear.
  const startMinutes = availability.toMinutes(existing.time);
  const tables = await availability.validateChosenTables(
    restaurant.id, existing.date, tableIds, startMinutes, existing.duration_minutes,
    existing.party_size, restaurant.turnover_buffer_minutes, existing.id
  );
  if (!tables) {
    return res.status(409).json({ error: 'Esa mesa ya no está disponible para esta reserva. Elige otra.' });
  }

  await db.withTransaction(async (client) => {
    await client.query('DELETE FROM reservation_tables WHERE reservation_id = $1', [existing.id]);
    for (const t of tables) {
      await client.query('INSERT INTO reservation_tables (reservation_id, table_id) VALUES ($1, $2)', [existing.id, t.id]);
    }
  });

  const { rows: tableRows } = await db.query(
    `SELECT t.name FROM reservation_tables rt JOIN tables t ON t.id = rt.table_id WHERE rt.reservation_id = $1`, [existing.id]
  );
  const { rows: updatedRows } = await db.query('SELECT * FROM reservations WHERE id = $1', [existing.id]);
  res.json({ ...updatedRows[0], tables: tableRows.map(t => t.name) });
});

// --- Shifts / horario semanal (admin) ----------------------------------------
// La plantilla semanal: un turno (p. ej. "Comida") tiene un horario por día de la
// semana. "Todos los días" en el panel simplemente llama a esta ruta 7 veces (una
// por day_of_week), no es un concepto aparte en la base de datos.
app.get('/api/shifts', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM shifts WHERE restaurant_id = $1 ORDER BY day_of_week, start_time', [req.restaurant.id]);
  res.json(rows);
});

// Crea o actualiza el turno de un día de la semana concreto (mismo nombre +
// mismo day_of_week = se actualiza en vez de duplicarse).
app.post('/api/shifts', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { name, dayOfWeek, startTime, endTime, lastSeatingOffsetMinutes } = req.body;
  if (!name || dayOfWeek == null || !startTime || !endTime) {
    return res.status(400).json({ error: 'name, dayOfWeek, startTime y endTime son obligatorios' });
  }
  const { rows: existing } = await db.query(
    'SELECT id FROM shifts WHERE restaurant_id = $1 AND name = $2 AND day_of_week = $3',
    [req.restaurant.id, name, dayOfWeek]
  );
  let row;
  if (existing.length) {
    const { rows } = await db.query(
      'UPDATE shifts SET start_time = $1, end_time = $2, last_seating_offset_minutes = $3 WHERE id = $4 RETURNING *',
      [startTime, endTime, lastSeatingOffsetMinutes || 0, existing[0].id]
    );
    row = rows[0];
  } else {
    const { rows } = await db.query(
      'INSERT INTO shifts (restaurant_id, name, day_of_week, start_time, end_time, last_seating_offset_minutes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.restaurant.id, name, dayOfWeek, startTime, endTime, lastSeatingOffsetMinutes || 0]
    );
    row = rows[0];
  }
  res.status(201).json(row);
});

// Quita ese turno de ese día de la semana por completo (no hay servicio ese día,
// de forma recurrente — distinto de "closures", que es un cierre puntual de fecha).
app.delete('/api/shifts/:id', adminAuth.requireAdminAuth, async (req, res) => {
  await db.query('DELETE FROM shifts WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Excepciones de horario por fecha concreta -------------------------------
// El turno sigue abierto, solo con otro horario ese día (no confundir con un
// cierre — ver "closures" más abajo).
app.get('/api/shift-date-overrides', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from y to son obligatorios' });
  const { rows } = await db.query(
    'SELECT * FROM shift_date_overrides WHERE restaurant_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date, shift_name',
    [req.restaurant.id, from, to]
  );
  res.json(rows);
});

// Body: { dates: ['2026-08-25', ...], shiftName, startTime, endTime } — "Entre dos
// fechas" y "Días específicos" del panel expanden a una lista de fechas en el
// propio navegador antes de llamar aquí; esta ruta solo hace upsert fecha a fecha.
app.post('/api/shift-date-overrides', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { dates, shiftName, startTime, endTime } = req.body;
  if (!Array.isArray(dates) || !dates.length || !shiftName || !startTime || !endTime) {
    return res.status(400).json({ error: 'dates (lista), shiftName, startTime y endTime son obligatorios' });
  }
  const saved = [];
  for (const date of dates) {
    const { rows } = await db.query(`
      INSERT INTO shift_date_overrides (restaurant_id, date, shift_name, start_time, end_time)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (restaurant_id, date, shift_name) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time
      RETURNING *
    `, [req.restaurant.id, date, shiftName, startTime, endTime]);
    saved.push(rows[0]);
  }
  res.status(201).json(saved);
});

app.delete('/api/shift-date-overrides/:id', adminAuth.requireAdminAuth, async (req, res) => {
  await db.query('DELETE FROM shift_date_overrides WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Cierres (día entero o un turno concreto) ---------------------------------
app.get('/api/closures', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date es obligatorio' });
  const { rows } = await db.query('SELECT * FROM closures WHERE restaurant_id = $1 AND date = $2', [req.restaurant.id, date]);
  res.json(rows);
});

app.post('/api/closures', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { date, shift, note } = req.body;
  if (!date) return res.status(400).json({ error: 'date es obligatorio' });
  const { rows } = await db.query('INSERT INTO closures (restaurant_id, date, shift, note) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.restaurant.id, date, shift || null, note || null]);
  res.status(201).json(rows[0]);
});

app.delete('/api/closures/:id', adminAuth.requireAdminAuth, async (req, res) => {
  await db.query('DELETE FROM closures WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
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
app.get('/api/floor-plans', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { rows: plans } = await db.query('SELECT * FROM floor_plans WHERE restaurant_id = $1 ORDER BY is_default DESC, name', [req.restaurant.id]);
  const { rows: counts } = await db.query(
    'SELECT floor_plan_id, COUNT(*)::int AS c FROM tables WHERE restaurant_id = $1 AND active = 1 GROUP BY floor_plan_id',
    [req.restaurant.id]
  );
  const countByPlan = {};
  counts.forEach(row => { countByPlan[row.floor_plan_id] = row.c; });
  res.json(plans.map(p => ({ ...p, tableCount: countByPlan[p.id] || 0 })));
});

app.post('/api/floor-plans', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { name, cloneFromId } = req.body;
  if (!name) return res.status(400).json({ error: 'name es obligatorio' });
  const restaurant = req.restaurant;

  let newPlanId;
  try {
    newPlanId = await db.withTransaction(async (client) => {
      const { rows: inserted } = await client.query(
        'INSERT INTO floor_plans (restaurant_id, name, is_default) VALUES ($1,$2,0) RETURNING id', [restaurant.id, name]
      );
      const newPlanId = inserted[0].id;

      if (cloneFromId) {
        const { rows: sourceRows } = await client.query(
          'SELECT * FROM floor_plans WHERE id = $1 AND restaurant_id = $2', [cloneFromId, restaurant.id]
        );
        if (!sourceRows.length) throw Object.assign(new Error('El plano de origen no existe'), { status: 400 });

        const zoneIdMap = new Map();
        const { rows: zones } = await client.query('SELECT * FROM zones WHERE floor_plan_id = $1', [cloneFromId]);
        for (const z of zones) {
          const { rows: zInserted } = await client.query(
            'INSERT INTO zones (restaurant_id, floor_plan_id, name, sort_order) VALUES ($1,$2,$3,$4) RETURNING id',
            [restaurant.id, newPlanId, z.name, z.sort_order]
          );
          zoneIdMap.set(z.id, zInserted[0].id);
        }
        const tableIdMap = new Map();
        const { rows: srcTables } = await client.query('SELECT * FROM tables WHERE floor_plan_id = $1 AND active = 1', [cloneFromId]);
        for (const t of srcTables) {
          const { rows: tInserted } = await client.query(`
            INSERT INTO tables (restaurant_id, floor_plan_id, zone_id, name, capacity_min, capacity_max, pos_x, pos_y, active)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1) RETURNING id
          `, [restaurant.id, newPlanId, t.zone_id ? zoneIdMap.get(t.zone_id) : null, t.name, t.capacity_min, t.capacity_max, t.pos_x, t.pos_y]);
          tableIdMap.set(t.id, tInserted[0].id);
        }
        const { rows: srcCombos } = await client.query('SELECT * FROM table_combinations WHERE floor_plan_id = $1 AND active = 1', [cloneFromId]);
        for (const c of srcCombos) {
          const { rows: cInserted } = await client.query(
            'INSERT INTO table_combinations (restaurant_id, floor_plan_id, name, active) VALUES ($1,$2,$3,1) RETURNING id',
            [restaurant.id, newPlanId, c.name]
          );
          const { rows: members } = await client.query('SELECT table_id FROM table_combination_members WHERE combination_id = $1', [c.id]);
          for (const m of members) {
            await client.query('INSERT INTO table_combination_members (combination_id, table_id) VALUES ($1,$2)',
              [cInserted[0].id, tableIdMap.get(m.table_id)]);
          }
        }
      }
      return newPlanId;
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  const { rows } = await db.query('SELECT * FROM floor_plans WHERE id = $1', [newPlanId]);
  res.status(201).json(rows[0]);
});

app.patch('/api/floor-plans/:id', adminAuth.requireAdminAuth, async (req, res) => {
  const { rows: planRows } = await db.query('SELECT * FROM floor_plans WHERE id = $1', [req.params.id]);
  const plan = planRows[0];
  if (!plan) return res.status(404).json({ error: 'Plano no encontrado' });
  const { name, isDefault } = req.body;

  await db.withTransaction(async (client) => {
    if (name) await client.query('UPDATE floor_plans SET name = $1 WHERE id = $2', [name, plan.id]);
    if (isDefault) {
      await client.query('UPDATE floor_plans SET is_default = 0 WHERE restaurant_id = $1', [plan.restaurant_id]);
      await client.query('UPDATE floor_plans SET is_default = 1 WHERE id = $1', [plan.id]);
    }
  });
  const { rows } = await db.query('SELECT * FROM floor_plans WHERE id = $1', [plan.id]);
  res.json(rows[0]);
});

// --- Agenda: qué plano aplica cada fecha ------------------------------------
app.get('/api/floor-plan-schedule', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { from, to } = req.query;
  let rows;
  if (from && to) {
    ({ rows } = await db.query('SELECT * FROM floor_plan_schedule WHERE restaurant_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date',
      [req.restaurant.id, from, to]));
  } else {
    ({ rows } = await db.query('SELECT * FROM floor_plan_schedule WHERE restaurant_id = $1 ORDER BY date', [req.restaurant.id]));
  }
  res.json(rows);
});

// Asigna (o reasigna) qué plano aplica un día concreto. No modifica ninguna reserva
// ya existente para esa fecha: solo cambia qué mesas se ofrecen para reservas NUEVAS.
app.put('/api/floor-plan-schedule', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { date, floorPlanId } = req.body;
  if (!date || !floorPlanId) return res.status(400).json({ error: 'date y floorPlanId son obligatorios' });
  const { rows: planRows } = await db.query('SELECT * FROM floor_plans WHERE id = $1 AND restaurant_id = $2', [floorPlanId, req.restaurant.id]);
  if (!planRows.length) return res.status(400).json({ error: 'Ese plano no existe para este local' });

  await db.query(`
    INSERT INTO floor_plan_schedule (restaurant_id, date, floor_plan_id) VALUES ($1,$2,$3)
    ON CONFLICT(restaurant_id, date) DO UPDATE SET floor_plan_id = excluded.floor_plan_id
  `, [req.restaurant.id, date, floorPlanId]);

  res.json({ ok: true, date, floorPlanId });
});

// Quita la asignación específica de un día: ese día vuelve a usar el plano por defecto.
app.delete('/api/floor-plan-schedule', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date es obligatorio' });
  await db.query('DELETE FROM floor_plan_schedule WHERE restaurant_id = $1 AND date = $2', [req.restaurant.id, date]);
  res.json({ ok: true });
});

// --- Zonas -------------------------------------------------------------------
app.get('/api/zones', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { floorPlanId } = req.query;
  if (!floorPlanId) return res.status(400).json({ error: 'floorPlanId es obligatorio' });
  const { rows } = await db.query('SELECT * FROM zones WHERE restaurant_id = $1 AND floor_plan_id = $2 ORDER BY sort_order, name',
    [req.restaurant.id, floorPlanId]);
  res.json(rows);
});

app.post('/api/zones', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { floorPlanId, name, sortOrder } = req.body;
  if (!floorPlanId || !name) return res.status(400).json({ error: 'floorPlanId y name son obligatorios' });
  const { rows } = await db.query('INSERT INTO zones (restaurant_id, floor_plan_id, name, sort_order) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.restaurant.id, floorPlanId, name, sortOrder || 0]);
  res.status(201).json(rows[0]);
});

app.delete('/api/zones/:id', adminAuth.requireAdminAuth, async (req, res) => {
  await db.withTransaction(async (client) => {
    await client.query('UPDATE tables SET zone_id = NULL WHERE zone_id = $1', [req.params.id]);
    await client.query('DELETE FROM zones WHERE id = $1', [req.params.id]);
  });
  res.json({ ok: true });
});

// --- Mesas ---------------------------------------------------------------------
app.get('/api/tables', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { floorPlanId, date } = req.query;
  const planId = floorPlanId || await availability.resolveFloorPlanId(req.restaurant.id, date || dayjs().format('YYYY-MM-DD'));
  const { rows } = await db.query(`
    SELECT t.*, z.name AS "zoneName" FROM tables t
    LEFT JOIN zones z ON z.id = t.zone_id
    WHERE t.restaurant_id = $1 AND t.floor_plan_id = $2 AND t.active = 1
    ORDER BY t.name
  `, [req.restaurant.id, planId]);
  res.json(rows);
});

app.post('/api/tables', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { floorPlanId, zoneId, name, capacityMin, capacityMax, posX, posY } = req.body;
  if (!floorPlanId || !name || !capacityMax) {
    return res.status(400).json({ error: 'floorPlanId, name y capacityMax son obligatorios' });
  }
  // Mesa nueva: se coloca en el centro del plano por defecto — se arrastra a su sitio
  // en el plano visual justo después de crearla.
  const { rows } = await db.query(`
    INSERT INTO tables (restaurant_id, floor_plan_id, zone_id, name, capacity_min, capacity_max, pos_x, pos_y, active)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1) RETURNING *
  `, [req.restaurant.id, floorPlanId, zoneId || null, name, capacityMin || 1, capacityMax,
      posX != null ? posX : 50, posY != null ? posY : 50]);
  res.status(201).json(rows[0]);
});

app.patch('/api/tables/:id', adminAuth.requireAdminAuth, async (req, res) => {
  const { rows: existingRows } = await db.query('SELECT * FROM tables WHERE id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Mesa no encontrada' });
  const body = req.body;
  // A diferencia de COALESCE(?, campo) — que no distingue "no lo mandaron" de
  // "lo mandaron como null" —, aquí cada campo solo se toca si viene en el body,
  // así que zoneId: null (p. ej. "Sin zona" en el editor) sí la deja sin zona.
  const next = {
    name: 'name' in body ? body.name : existing.name,
    zone_id: 'zoneId' in body ? body.zoneId : existing.zone_id,
    capacity_min: 'capacityMin' in body && body.capacityMin != null ? body.capacityMin : existing.capacity_min,
    capacity_max: 'capacityMax' in body && body.capacityMax != null ? body.capacityMax : existing.capacity_max,
    pos_x: 'posX' in body && body.posX != null ? body.posX : existing.pos_x,
    pos_y: 'posY' in body && body.posY != null ? body.posY : existing.pos_y,
  };
  const { rows } = await db.query(`
    UPDATE tables SET name = $1, zone_id = $2, capacity_min = $3, capacity_max = $4, pos_x = $5, pos_y = $6
    WHERE id = $7 RETURNING *
  `, [next.name, next.zone_id, next.capacity_min, next.capacity_max, next.pos_x, next.pos_y, req.params.id]);
  res.json(rows[0]);
});

// Baja lógica: nunca se borra la fila físicamente, para no romper reservas ya
// creadas que la referencian (reservation_tables.table_id).
app.delete('/api/tables/:id', adminAuth.requireAdminAuth, async (req, res) => {
  const { rows: existingRows } = await db.query('SELECT * FROM tables WHERE id = $1', [req.params.id]);
  if (!existingRows.length) return res.status(404).json({ error: 'Mesa no encontrada' });
  await db.query('UPDATE tables SET active = 0 WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Combinaciones de mesas ----------------------------------------------------
app.get('/api/combinations', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { floorPlanId } = req.query;
  if (!floorPlanId) return res.status(400).json({ error: 'floorPlanId es obligatorio' });
  const { rows: combos } = await db.query('SELECT * FROM table_combinations WHERE restaurant_id = $1 AND floor_plan_id = $2 AND active = 1',
    [req.restaurant.id, floorPlanId]);
  if (!combos.length) return res.json([]);

  const comboIds = combos.map(c => c.id);
  const placeholders = comboIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows: allMembers } = await db.query(`
    SELECT tcm.combination_id, t.id, t.name, t.capacity_max FROM table_combination_members tcm
    JOIN tables t ON t.id = tcm.table_id WHERE tcm.combination_id IN (${placeholders})
  `, comboIds);
  const membersByCombo = {};
  for (const m of allMembers) (membersByCombo[m.combination_id] = membersByCombo[m.combination_id] || []).push(m);

  res.json(combos.map(c => {
    const tables = membersByCombo[c.id] || [];
    const sumMax = tables.reduce((s, t) => s + t.capacity_max, 0);
    // capacity_min/capacity_max: aforo fijado a mano (como en Cover), que puede no
    // coincidir con la suma de las mesas — si no se fijó, se sigue calculando como suma.
    return { ...c, tables, combinedMax: c.capacity_max != null ? c.capacity_max : sumMax };
  }));
});

app.post('/api/combinations', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { floorPlanId, name, tableIds, capacityMin, capacityMax } = req.body;
  if (!floorPlanId || !name || !Array.isArray(tableIds) || tableIds.length < 2) {
    return res.status(400).json({ error: 'floorPlanId, name y al menos 2 tableIds son obligatorios' });
  }
  const placeholders = tableIds.map((_, i) => `$${i + 2}`).join(',');
  const { rows: validTables } = await db.query(`SELECT id FROM tables WHERE floor_plan_id = $1 AND id IN (${placeholders})`,
    [floorPlanId, ...tableIds]);
  if (validTables.length !== tableIds.length) {
    return res.status(400).json({ error: 'Todas las mesas de la combinación deben pertenecer al mismo plano' });
  }

  const id = await db.withTransaction(async (client) => {
    const { rows: inserted } = await client.query(
      'INSERT INTO table_combinations (restaurant_id, floor_plan_id, name, active, capacity_min, capacity_max) VALUES ($1,$2,$3,1,$4,$5) RETURNING id',
      [req.restaurant.id, floorPlanId, name, capacityMin || null, capacityMax || null]
    );
    const comboId = inserted[0].id;
    for (const tid of tableIds) {
      await client.query('INSERT INTO table_combination_members (combination_id, table_id) VALUES ($1,$2)', [comboId, tid]);
    }
    return comboId;
  });
  const { rows } = await db.query('SELECT * FROM table_combinations WHERE id = $1', [id]);
  res.status(201).json(rows[0]);
});

app.delete('/api/combinations/:id', adminAuth.requireAdminAuth, async (req, res) => {
  await db.query('DELETE FROM table_combinations WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Encuesta de satisfacción del día después ------------------------------

// Disparador diario externo (GitHub Actions) — protegido por un secreto compartido,
// no por sesión de personal, porque quien llama es un robot, no una persona con login.
app.get('/api/cron/send-surveys', async (req, res) => {
  if (!process.env.CRON_SECRET || req.query.key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const { rows: restaurants } = await db.query('SELECT * FROM restaurants');
  const results = [];
  for (const restaurant of restaurants) {
    const { rows } = await db.query(`
      SELECT * FROM reservations
      WHERE restaurant_id = $1 AND date = $2 AND status NOT IN ('cancelled','no_show')
        AND email IS NOT NULL AND survey_sent_at IS NULL
    `, [restaurant.id, yesterday]);
    for (const reservation of rows) {
      const result = await sendSurveyEmail({ restaurant, reservation, baseUrl });
      if (result.ok) {
        await db.query('UPDATE reservations SET survey_sent_at = $1 WHERE id = $2',
          [dayjs().format('YYYY-MM-DD HH:mm:ss'), reservation.id]);
      }
      results.push({ reservationId: reservation.id, email: reservation.email, ...result });
    }
  }
  res.json({ date: yesterday, sent: results.filter(r => r.ok).length, results });
});

// --- Encuesta: consultar (verifica el token) y responder (público, sin login) ---
app.get('/api/survey/:id', async (req, res) => {
  const { rows: reservationRows } = await db.query('SELECT * FROM reservations WHERE id = $1', [req.params.id]);
  const reservation = reservationRows[0];
  if (!reservation || !(await verifySurveyToken(reservation.id, req.query.t))) {
    return res.status(404).json({ error: 'Encuesta no encontrada' });
  }
  const { rows: restaurantRows } = await db.query('SELECT name FROM restaurants WHERE id = $1', [reservation.restaurant_id]);
  const restaurant = restaurantRows[0];
  const { rows: alreadyRows } = await db.query('SELECT 1 FROM survey_responses WHERE reservation_id = $1', [reservation.id]);
  res.json({
    restaurantName: restaurant ? restaurant.name : '',
    date: reservation.date,
    customerName: reservation.customer_name,
    alreadyAnswered: alreadyRows.length > 0,
  });
});

app.post('/api/survey/:id', async (req, res) => {
  const { rows: reservationRows } = await db.query('SELECT * FROM reservations WHERE id = $1', [req.params.id]);
  const reservation = reservationRows[0];
  if (!reservation || !(await verifySurveyToken(reservation.id, req.body.token))) {
    return res.status(404).json({ error: 'Encuesta no encontrada' });
  }
  const { ratingGeneral, ratingComida, ratingServicio, comentario } = req.body;
  if (![ratingGeneral, ratingComida, ratingServicio].every(n => Number.isInteger(n) && n >= 1 && n <= 5)) {
    return res.status(400).json({ error: 'Las valoraciones deben ser un número entero de 1 a 5.' });
  }
  try {
    await db.query(`
      INSERT INTO survey_responses (reservation_id, rating_general, rating_comida, rating_servicio, comentario)
      VALUES ($1,$2,$3,$4,$5)
    `, [reservation.id, ratingGeneral, ratingComida, ratingServicio, comentario || null]);
  } catch (err) {
    return res.status(409).json({ error: 'Ya se respondió esta encuesta.' });
  }
  res.status(201).json({ ok: true });
});

// --- Respuestas de la encuesta (panel de personal) --------------------------
app.get('/api/survey-responses', adminAuth.requireAdminAuth, requireRestaurant, async (req, res) => {
  const { rows } = await db.query(`
    SELECT sr.*, r.customer_name, r.date AS reservation_date, r.party_size
    FROM survey_responses sr
    JOIN reservations r ON r.id = sr.reservation_id
    WHERE r.restaurant_id = $1
    ORDER BY sr.created_at DESC
  `, [req.restaurant.id]);
  res.json(rows);
});

const PORT = process.env.PORT || 3000;

// Al arrancar node server/index.js directamente (desarrollo local) no se pasa por
// start-safe.js, así que initDb() se llama aquí también — es seguro repetirlo
// (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), no vuelve a sembrar datos.
db.initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor de reservas escuchando en http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Error al inicializar la base de datos:', err);
    process.exit(1);
  });
