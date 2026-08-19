const db = require('./db');
const dayjs = require('dayjs');

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function toHHMM(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Turnos de un día concreto: la plantilla semanal (shifts), con las horas
// sustituidas por la excepción de esa fecha si existe (shift_date_overrides) —
// el turno sigue abierto, solo con otro horario ese día en concreto.
async function getShiftsForDate(restaurantId, dateStr) {
  const dow = dayjs(dateStr).day(); // 0=Sunday
  const { rows: base } = await db.query(
    `SELECT * FROM shifts WHERE restaurant_id = $1 AND day_of_week = $2 ORDER BY start_time`,
    [restaurantId, dow]
  );
  const { rows: overrides } = await db.query(
    `SELECT * FROM shift_date_overrides WHERE restaurant_id = $1 AND date = $2`,
    [restaurantId, dateStr]
  );
  if (!overrides.length) return base;

  const overrideByName = {};
  overrides.forEach(o => { overrideByName[o.shift_name] = o; });
  const merged = base.map(s => overrideByName[s.name]
    ? { ...s, start_time: overrideByName[s.name].start_time, end_time: overrideByName[s.name].end_time }
    : s);
  // Excepción para un turno que ese día de la semana no tiene plantilla (caso raro) —
  // se añade igualmente, con desfase de última entrada 0 por defecto.
  for (const name of Object.keys(overrideByName)) {
    if (!merged.some(s => s.name === name)) {
      merged.push({ id: null, restaurant_id: restaurantId, day_of_week: dow, name,
        start_time: overrideByName[name].start_time, end_time: overrideByName[name].end_time,
        last_seating_offset_minutes: 0 });
    }
  }
  return merged;
}

async function isClosed(restaurantId, dateStr) {
  const { rows } = await db.query(
    `SELECT 1 FROM closures WHERE restaurant_id = $1 AND date = $2 AND shift IS NULL`,
    [restaurantId, dateStr]
  );
  return rows.length > 0;
}

// Turnos cerrados ese día (además del posible cierre del día entero) — deja de
// ofrecerse ese turno para reservas nuevas, sin tocar las que ya existan.
async function closedShifts(restaurantId, dateStr) {
  const { rows } = await db.query(
    `SELECT shift FROM closures WHERE restaurant_id = $1 AND date = $2 AND shift IS NOT NULL`,
    [restaurantId, dateStr]
  );
  return new Set(rows.map(r => r.shift));
}

// Returns candidate time slots (HH:MM) for a given date based on shifts + slot interval,
// leaving room for the reservation duration before the shift/last-seating cutoff.
async function candidateSlots(restaurant, dateStr) {
  if (await isClosed(restaurant.id, dateStr)) return [];
  const closed = await closedShifts(restaurant.id, dateStr);
  const shifts = await getShiftsForDate(restaurant.id, dateStr);
  const slots = [];
  for (const shift of shifts) {
    if (closed.has(shift.name)) continue;
    const start = toMinutes(shift.start_time);
    const lastSeating = toMinutes(shift.end_time) - (shift.last_seating_offset_minutes || 0);
    for (let t = start; t <= lastSeating; t += restaurant.slot_interval_minutes) {
      slots.push({ time: toHHMM(t), shift: shift.name, minutes: t });
    }
  }
  return slots;
}

// Existing reservations occupying a given table on a date, as [start,end) minute ranges
// (end includes the turnover buffer so back-to-back bookings respect cleaning time).
async function tableBusyRanges(restaurantId, tableId, dateStr, bufferMinutes, excludeReservationId) {
  let rows;
  if (excludeReservationId) {
    ({ rows } = await db.query(`
      SELECT r.time, r.duration_minutes, r.id, r.paid_at
      FROM reservations r
      JOIN reservation_tables rt ON rt.reservation_id = r.id
      WHERE r.restaurant_id = $1 AND rt.table_id = $2 AND r.date = $3
        AND r.status NOT IN ('cancelled','no_show')
        AND r.id != $4
    `, [restaurantId, tableId, dateStr, excludeReservationId]));
  } else {
    ({ rows } = await db.query(`
      SELECT r.time, r.duration_minutes, r.id, r.paid_at
      FROM reservations r
      JOIN reservation_tables rt ON rt.reservation_id = r.id
      WHERE r.restaurant_id = $1 AND rt.table_id = $2 AND r.date = $3
        AND r.status NOT IN ('cancelled','no_show')
    `, [restaurantId, tableId, dateStr]));
  }
  return rows.map(r => {
    const start = toMinutes(r.time);
    let end = start + r.duration_minutes + bufferMinutes;
    // Si ya se marcó "Pagada" ese mismo día, la mesa se libera 2 min después de eso
    // en vez de esperar a que acabe la duración estándar de la reserva.
    if (r.paid_at && r.paid_at.slice(0, 10) === dateStr) {
      const [ph, pm] = r.paid_at.slice(11, 16).split(':').map(Number);
      const paidEnd = Math.max(start, ph * 60 + pm) + 2;
      end = Math.min(end, paidEnd);
    }
    return { start, end, reservationId: r.id };
  });
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// ---- Planos de sala: qué plano aplica cada fecha ----------------------
// Si el día tiene una fila en floor_plan_schedule se usa ese plano; si no,
// se usa el plano marcado is_default=1 del local. Cambiar esta asignación
// (incluso para una fecha que ya tiene reservas) nunca toca las mesas ya
// referenciadas por esas reservas: reservation_tables sigue apuntando al
// table_id original, que no se borra al cambiar de plano.
async function resolveFloorPlanId(restaurantId, dateStr) {
  const { rows: scheduledRows } = await db.query(
    `SELECT floor_plan_id FROM floor_plan_schedule WHERE restaurant_id = $1 AND date = $2`,
    [restaurantId, dateStr]
  );
  if (scheduledRows.length) return scheduledRows[0].floor_plan_id;
  const { rows: defRows } = await db.query(
    `SELECT id FROM floor_plans WHERE restaurant_id = $1 AND is_default = 1 LIMIT 1`,
    [restaurantId]
  );
  return defRows.length ? defRows[0].id : null;
}

async function getActiveTables(restaurantId, dateStr) {
  const floorPlanId = await resolveFloorPlanId(restaurantId, dateStr);
  if (!floorPlanId) return [];
  const { rows } = await db.query(
    `SELECT * FROM tables WHERE restaurant_id = $1 AND floor_plan_id = $2 AND active = 1`,
    [restaurantId, floorPlanId]
  );
  return rows;
}

// Combinaciones de mesas definidas explícitamente para el plano de esa fecha
// (2 o más mesas, no solo parejas — p. ej. M3+M4+M5 para un grupo grande).
async function getCombinationsForDate(restaurantId, dateStr) {
  const floorPlanId = await resolveFloorPlanId(restaurantId, dateStr);
  if (!floorPlanId) return [];
  const { rows: combos } = await db.query(
    `SELECT * FROM table_combinations WHERE restaurant_id = $1 AND floor_plan_id = $2 AND active = 1`,
    [restaurantId, floorPlanId]
  );
  if (!combos.length) return [];

  // Una sola consulta con IN(...) en vez de una por combinación: con muchas
  // combinaciones a la vez (Promise.all disparando todas en paralelo), el pooler
  // de Supabase llega a su límite de conexiones simultáneas (EMAXCONNSESSION).
  const comboIds = combos.map(c => c.id);
  const placeholders = comboIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows: allMembers } = await db.query(`
    SELECT tcm.combination_id, t.* FROM table_combination_members tcm
    JOIN tables t ON t.id = tcm.table_id
    WHERE tcm.combination_id IN (${placeholders}) AND t.active = 1
  `, comboIds);
  const membersByCombo = {};
  for (const m of allMembers) {
    (membersByCombo[m.combination_id] = membersByCombo[m.combination_id] || []).push(m);
  }
  return combos
    .map(c => ({ ...c, tables: membersByCombo[c.id] || [] }))
    .filter(c => c.tables.length >= 2);
}

// Finds a table (or an explicit combination of tables) free for [start, start+duration)
// at partySize, using only the tables/combinations that belong to the plan active on dateStr.
async function findAvailableTable(restaurantId, dateStr, startMinutes, durationMinutes, partySize, bufferMinutes, excludeReservationId) {
  const allTables = await getActiveTables(restaurantId, dateStr);
  const reqEnd = startMinutes + durationMinutes;

  async function isFree(table) {
    const busy = await tableBusyRanges(restaurantId, table.id, dateStr, bufferMinutes, excludeReservationId);
    return !busy.some(b => overlaps(startMinutes, reqEnd, b.start, b.end));
  }

  // 1) Best single-table fit (smallest table whose own capacity_min<=party<=capacity_max).
  // This filter only makes sense per-table, so it's applied here — NOT on the list used
  // for combos below, otherwise a party that only fits when combining smaller tables
  // (e.g. 8 people needing two 4-tops) would wrongly get excluded before the combo search.
  const singleCandidates = allTables
    .filter(t => partySize <= t.capacity_max)
    .sort((a, b) => a.capacity_max - b.capacity_max);
  for (const t of singleCandidates) {
    if (partySize >= t.capacity_min && await isFree(t)) return [t];
  }

  // 2) Explicit combinations of 2+ tables defined for this plan (staff-configured, not
  // inferred). What matters is the combination's total capacity, not any single member's.
  // capacity_min/capacity_max: aforo fijado a mano (como en Cover) — no siempre coincide
  // con la suma de las mesas (dos mesas de 2 pueden dar servicio a 6 por las sillas de
  // esquina que se añaden al juntarlas). Si no se fijó, se usa la suma de siempre.
  const combos = (await getCombinationsForDate(restaurantId, dateStr))
    .map(c => ({
      ...c,
      combinedMin: c.capacity_min != null ? c.capacity_min : 1,
      combinedMax: c.capacity_max != null ? c.capacity_max : c.tables.reduce((sum, t) => sum + t.capacity_max, 0),
    }))
    .sort((a, b) => a.combinedMax - b.combinedMax);
  for (const combo of combos) {
    if (partySize > combo.combinedMax || partySize < combo.combinedMin) continue;
    let allFree = true;
    for (const t of combo.tables) {
      if (!(await isFree(t))) { allFree = false; break; }
    }
    if (allFree) return combo.tables;
  }
  return null;
}

// ---- Cupo de aforo por franja horaria (independiente de la mesa física) ----
// Replica el control que ya usa el grupo en CoverManager: un límite de
// comensales agregados por tramo horario y día de la semana, que puede ser
// más estricto que "cuántas mesas hay libres" (p. ej. para no saturar cocina
// en un tramo concreto aunque queden mesas).

async function getCapacityCapsForDay(restaurantId, dateStr) {
  const dow = dayjs(dateStr).day();
  const { rows } = await db.query(
    `SELECT * FROM capacity_caps WHERE restaurant_id = $1 AND day_of_week = $2 ORDER BY start_time`,
    [restaurantId, dow]
  );
  return rows;
}

function findCapForMinute(caps, minute) {
  return caps.find(c => minute >= toMinutes(c.start_time) && minute < toMinutes(c.end_time)) || null;
}

// Comensales ya reservados (no cancelados/no-show) cuya hora de inicio cae dentro
// de la misma franja [bandStart, bandEnd) que la reserva candidata.
async function coversBookedInBand(restaurantId, dateStr, bandStart, bandEnd, excludeReservationId) {
  const { rows } = await db.query(
    `SELECT time, party_size, id FROM reservations
     WHERE restaurant_id = $1 AND date = $2 AND status NOT IN ('cancelled','no_show')`,
    [restaurantId, dateStr]
  );
  return rows
    .filter(r => (!excludeReservationId || r.id !== excludeReservationId))
    .filter(r => { const m = toMinutes(r.time); return m >= bandStart && m < bandEnd; })
    .reduce((sum, r) => sum + r.party_size, 0);
}

// true si añadir `partySize` a las `startMinutes` respeta el cupo de aforo de esa franja.
// Si no hay cupo configurado para ese día/franja, no se restringe por este criterio
// (solo aplica la disponibilidad de mesa).
async function hasCapacityRoom(restaurantId, dateStr, startMinutes, partySize, excludeReservationId) {
  const caps = await getCapacityCapsForDay(restaurantId, dateStr);
  if (!caps.length) return true;
  const cap = findCapForMinute(caps, startMinutes);
  if (!cap) return true;
  const bandStart = toMinutes(cap.start_time);
  const bandEnd = toMinutes(cap.end_time);
  const booked = await coversBookedInBand(restaurantId, dateStr, bandStart, bandEnd, excludeReservationId);
  return booked + partySize <= cap.max_covers;
}

// Public: available time slots for a date/party size, combinando disponibilidad
// de mesa Y cupo de aforo por franja.
async function getAvailability(restaurant, dateStr, partySize) {
  const duration = restaurant.default_duration_minutes;
  const buffer = restaurant.turnover_buffer_minutes;
  const slots = await candidateSlots(restaurant, dateStr);
  const results = [];
  for (const slot of slots) {
    const table = await findAvailableTable(restaurant.id, dateStr, slot.minutes, duration, partySize, buffer, null);
    const capOk = await hasCapacityRoom(restaurant.id, dateStr, slot.minutes, partySize, null);
    results.push({ time: slot.time, shift: slot.shift, available: !!table && capOk });
  }
  return results;
}

async function getZonesForDate(restaurantId, dateStr) {
  const floorPlanId = await resolveFloorPlanId(restaurantId, dateStr);
  if (!floorPlanId) return [];
  const { rows } = await db.query(
    `SELECT * FROM zones WHERE restaurant_id = $1 AND floor_plan_id = $2 ORDER BY sort_order, name`,
    [restaurantId, floorPlanId]
  );
  return rows;
}

// Public: the real, tappable floor plan for a specific date/time/party — every table's
// actual status (occupied by an existing reservation, too small for this party, or free),
// plus which currently-viable combinations each table belongs to. This is what lets the
// customer pick their own table instead of the system silently auto-assigning one.
async function getTableMap(restaurantId, dateStr, startMinutes, durationMinutes, partySize, bufferMinutes, excludeReservationId) {
  const zones = await getZonesForDate(restaurantId, dateStr);
  const zoneName = {};
  zones.forEach(z => { zoneName[z.id] = z.name; });

  const tables = await getActiveTables(restaurantId, dateStr);
  const reqEnd = startMinutes + durationMinutes;

  async function isFree(table) {
    // Al mover una reserva ya existente a otra mesa, hay que ignorar su propia
    // ocupación actual (si no, la mesa que ya tiene asignada saldría "ocupada" por
    // sí misma). excludeReservationId viene null en el flujo normal de reserva nueva.
    const busy = await tableBusyRanges(restaurantId, table.id, dateStr, bufferMinutes, excludeReservationId || null);
    return !busy.some(b => overlaps(startMinutes, reqEnd, b.start, b.end));
  }

  const tableFree = {};
  const tableStatus = {};
  for (const t of tables) {
    const free = await isFree(t);
    tableFree[t.id] = free;
    tableStatus[t.id] = !free ? 'occupied' : (partySize > t.capacity_max ? 'toosmall' : 'available');
  }

  const rawCombos = await getCombinationsForDate(restaurantId, dateStr);
  const combos = rawCombos.map(c => {
    const combinedMax = c.tables.reduce((sum, t) => sum + t.capacity_max, 0);
    const allFree = c.tables.every(t => tableFree[t.id]);
    const status = !allFree ? 'occupied' : (partySize > combinedMax ? 'toosmall' : 'available');
    return {
      id: c.id, name: c.name, combinedMax, status,
      tableIds: c.tables.map(t => t.id),
      tables: c.tables.map(t => ({ id: t.id, name: t.name, capacityMax: t.capacity_max })),
    };
  });

  // A table that's too small on its own can still be worth showing as selectable if
  // it belongs to a combo that currently fits — surface those options per table so the
  // client can offer "combine with X" instead of just graying the table out.
  const comboOptionsByTable = {};
  for (const c of combos) {
    if (c.status !== 'available') continue;
    for (const tid of c.tableIds) {
      (comboOptionsByTable[tid] = comboOptionsByTable[tid] || []).push({
        id: c.id, name: c.name, combinedMax: c.combinedMax, tableIds: c.tableIds,
        tableNames: c.tables.map(t => t.name),
      });
    }
  }

  const outTables = tables.map(t => ({
    id: t.id, name: t.name, zoneId: t.zone_id, zoneName: t.zone_id ? zoneName[t.zone_id] : null,
    capacityMin: t.capacity_min, capacityMax: t.capacity_max,
    posX: t.pos_x, posY: t.pos_y,
    status: tableStatus[t.id],
    comboOptions: comboOptionsByTable[t.id] || [],
  }));

  return {
    zones: zones.map(z => ({ id: z.id, name: z.name, sortOrder: z.sort_order })),
    tables: outTables,
    combos,
  };
}

// Validates a customer's own table choice (a single table id, or the member ids of a
// combo they picked) at reservation-creation time — re-checking freshly, since time may
// have passed between showing them the floor plan and them hitting "confirm". Returns the
// table rows to book if the choice still holds, or null if it doesn't (caller should ask
// the customer to pick again rather than silently substituting a different table).
async function validateChosenTables(restaurantId, dateStr, tableIds, startMinutes, durationMinutes, partySize, bufferMinutes, excludeReservationId) {
  if (!Array.isArray(tableIds) || !tableIds.length) return null;
  const floorPlanId = await resolveFloorPlanId(restaurantId, dateStr);
  if (!floorPlanId) return null;

  const placeholders = tableIds.map((_, i) => `$${i + 3}`).join(',');
  const { rows } = await db.query(
    `SELECT * FROM tables WHERE restaurant_id = $1 AND floor_plan_id = $2 AND active = 1 AND id IN (${placeholders})`,
    [restaurantId, floorPlanId, ...tableIds]
  );
  if (rows.length !== tableIds.length) return null; // a table doesn't belong to this date's plan

  const reqEnd = startMinutes + durationMinutes;
  for (const t of rows) {
    const busy = await tableBusyRanges(restaurantId, t.id, dateStr, bufferMinutes, excludeReservationId);
    if (busy.some(b => overlaps(startMinutes, reqEnd, b.start, b.end))) return null;
  }

  const combinedMax = rows.reduce((sum, t) => sum + t.capacity_max, 0);
  if (partySize > combinedMax) return null;
  if (rows.length === 1 && partySize < rows[0].capacity_min) return null;
  return rows;
}

module.exports = {
  toMinutes, toHHMM, getShiftsForDate, isClosed, closedShifts, candidateSlots,
  findAvailableTable, getAvailability, getActiveTables,
  getCapacityCapsForDay, findCapForMinute, hasCapacityRoom,
  resolveFloorPlanId, getCombinationsForDate,
  getZonesForDate, getTableMap, validateChosenTables,
};
