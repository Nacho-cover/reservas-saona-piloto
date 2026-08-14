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

function getShiftsForDate(restaurantId, dateStr) {
  const dow = dayjs(dateStr).day(); // 0=Sunday
  return db.prepare(
    `SELECT * FROM shifts WHERE restaurant_id = ? AND day_of_week = ? ORDER BY start_time`
  ).all(restaurantId, dow);
}

function isClosed(restaurantId, dateStr) {
  const row = db.prepare(
    `SELECT 1 FROM closures WHERE restaurant_id = ? AND date = ? AND shift IS NULL`
  ).get(restaurantId, dateStr);
  return !!row;
}

// Turnos cerrados ese día (además del posible cierre del día entero) — deja de
// ofrecerse ese turno para reservas nuevas, sin tocar las que ya existan.
function closedShifts(restaurantId, dateStr) {
  const rows = db.prepare(
    `SELECT shift FROM closures WHERE restaurant_id = ? AND date = ? AND shift IS NOT NULL`
  ).all(restaurantId, dateStr);
  return new Set(rows.map(r => r.shift));
}

// Returns candidate time slots (HH:MM) for a given date based on shifts + slot interval,
// leaving room for the reservation duration before the shift/last-seating cutoff.
function candidateSlots(restaurant, dateStr) {
  if (isClosed(restaurant.id, dateStr)) return [];
  const closed = closedShifts(restaurant.id, dateStr);
  const shifts = getShiftsForDate(restaurant.id, dateStr);
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
function tableBusyRanges(restaurantId, tableId, dateStr, bufferMinutes, excludeReservationId) {
  let rows;
  if (excludeReservationId) {
    rows = db.prepare(`
      SELECT r.time, r.duration_minutes, r.id, r.paid_at
      FROM reservations r
      JOIN reservation_tables rt ON rt.reservation_id = r.id
      WHERE r.restaurant_id = ? AND rt.table_id = ? AND r.date = ?
        AND r.status NOT IN ('cancelled','no_show')
        AND r.id != ?
    `).all(restaurantId, tableId, dateStr, excludeReservationId);
  } else {
    rows = db.prepare(`
      SELECT r.time, r.duration_minutes, r.id, r.paid_at
      FROM reservations r
      JOIN reservation_tables rt ON rt.reservation_id = r.id
      WHERE r.restaurant_id = ? AND rt.table_id = ? AND r.date = ?
        AND r.status NOT IN ('cancelled','no_show')
    `).all(restaurantId, tableId, dateStr);
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
function resolveFloorPlanId(restaurantId, dateStr) {
  const scheduled = db.prepare(
    `SELECT floor_plan_id FROM floor_plan_schedule WHERE restaurant_id = ? AND date = ?`
  ).get(restaurantId, dateStr);
  if (scheduled) return scheduled.floor_plan_id;
  const def = db.prepare(
    `SELECT id FROM floor_plans WHERE restaurant_id = ? AND is_default = 1 LIMIT 1`
  ).get(restaurantId);
  return def ? def.id : null;
}

function getActiveTables(restaurantId, dateStr) {
  const floorPlanId = resolveFloorPlanId(restaurantId, dateStr);
  if (!floorPlanId) return [];
  return db.prepare(
    `SELECT * FROM tables WHERE restaurant_id = ? AND floor_plan_id = ? AND active = 1`
  ).all(restaurantId, floorPlanId);
}

// Combinaciones de mesas definidas explícitamente para el plano de esa fecha
// (2 o más mesas, no solo parejas — p. ej. M3+M4+M5 para un grupo grande).
function getCombinationsForDate(restaurantId, dateStr) {
  const floorPlanId = resolveFloorPlanId(restaurantId, dateStr);
  if (!floorPlanId) return [];
  const combos = db.prepare(
    `SELECT * FROM table_combinations WHERE restaurant_id = ? AND floor_plan_id = ? AND active = 1`
  ).all(restaurantId, floorPlanId);
  const memberStmt = db.prepare(`
    SELECT t.* FROM table_combination_members tcm
    JOIN tables t ON t.id = tcm.table_id
    WHERE tcm.combination_id = ? AND t.active = 1
  `);
  return combos
    .map(c => ({ ...c, tables: memberStmt.all(c.id) }))
    .filter(c => c.tables.length >= 2);
}

// Finds a table (or an explicit combination of tables) free for [start, start+duration)
// at partySize, using only the tables/combinations that belong to the plan active on dateStr.
function findAvailableTable(restaurantId, dateStr, startMinutes, durationMinutes, partySize, bufferMinutes, excludeReservationId) {
  const allTables = getActiveTables(restaurantId, dateStr);

  const isFree = (table) => {
    const busy = tableBusyRanges(restaurantId, table.id, dateStr, bufferMinutes, excludeReservationId);
    const reqEnd = startMinutes + durationMinutes;
    return !busy.some(b => overlaps(startMinutes, reqEnd, b.start, b.end));
  };

  // 1) Best single-table fit (smallest table whose own capacity_min<=party<=capacity_max).
  // This filter only makes sense per-table, so it's applied here — NOT on the list used
  // for combos below, otherwise a party that only fits when combining smaller tables
  // (e.g. 8 people needing two 4-tops) would wrongly get excluded before the combo search.
  const singleCandidates = allTables
    .filter(t => partySize <= t.capacity_max)
    .sort((a, b) => a.capacity_max - b.capacity_max);
  const singleFit = singleCandidates.find(t => partySize >= t.capacity_min && isFree(t));
  if (singleFit) return [singleFit];

  // 2) Explicit combinations of 2+ tables defined for this plan (staff-configured, not
  // inferred). What matters is the combination's total capacity, not any single member's.
  // capacity_min/capacity_max: aforo fijado a mano (como en Cover) — no siempre coincide
  // con la suma de las mesas (dos mesas de 2 pueden dar servicio a 6 por las sillas de
  // esquina que se añaden al juntarlas). Si no se fijó, se usa la suma de siempre.
  const combos = getCombinationsForDate(restaurantId, dateStr)
    .map(c => ({
      ...c,
      combinedMin: c.capacity_min != null ? c.capacity_min : 1,
      combinedMax: c.capacity_max != null ? c.capacity_max : c.tables.reduce((sum, t) => sum + t.capacity_max, 0),
    }))
    .sort((a, b) => a.combinedMax - b.combinedMax);
  for (const combo of combos) {
    if (partySize > combo.combinedMax || partySize < combo.combinedMin) continue;
    if (combo.tables.every(isFree)) return combo.tables;
  }
  return null;
}

// ---- Cupo de aforo por franja horaria (independiente de la mesa física) ----
// Replica el control que ya usa el grupo en CoverManager: un límite de
// comensales agregados por tramo horario y día de la semana, que puede ser
// más estricto que "cuántas mesas hay libres" (p. ej. para no saturar cocina
// en un tramo concreto aunque queden mesas).

function getCapacityCapsForDay(restaurantId, dateStr) {
  const dow = dayjs(dateStr).day();
  return db.prepare(
    `SELECT * FROM capacity_caps WHERE restaurant_id = ? AND day_of_week = ? ORDER BY start_time`
  ).all(restaurantId, dow);
}

function findCapForMinute(caps, minute) {
  return caps.find(c => minute >= toMinutes(c.start_time) && minute < toMinutes(c.end_time)) || null;
}

// Comensales ya reservados (no cancelados/no-show) cuya hora de inicio cae dentro
// de la misma franja [bandStart, bandEnd) que la reserva candidata.
function coversBookedInBand(restaurantId, dateStr, bandStart, bandEnd, excludeReservationId) {
  const rows = db.prepare(
    `SELECT time, party_size, id FROM reservations
     WHERE restaurant_id = ? AND date = ? AND status NOT IN ('cancelled','no_show')`
  ).all(restaurantId, dateStr);
  return rows
    .filter(r => (!excludeReservationId || r.id !== excludeReservationId))
    .filter(r => { const m = toMinutes(r.time); return m >= bandStart && m < bandEnd; })
    .reduce((sum, r) => sum + r.party_size, 0);
}

// true si añadir `partySize` a las `startMinutes` respeta el cupo de aforo de esa franja.
// Si no hay cupo configurado para ese día/franja, no se restringe por este criterio
// (solo aplica la disponibilidad de mesa).
function hasCapacityRoom(restaurantId, dateStr, startMinutes, partySize, excludeReservationId) {
  const caps = getCapacityCapsForDay(restaurantId, dateStr);
  if (!caps.length) return true;
  const cap = findCapForMinute(caps, startMinutes);
  if (!cap) return true;
  const bandStart = toMinutes(cap.start_time);
  const bandEnd = toMinutes(cap.end_time);
  const booked = coversBookedInBand(restaurantId, dateStr, bandStart, bandEnd, excludeReservationId);
  return booked + partySize <= cap.max_covers;
}

// Public: available time slots for a date/party size, combinando disponibilidad
// de mesa Y cupo de aforo por franja.
function getAvailability(restaurant, dateStr, partySize) {
  const duration = restaurant.default_duration_minutes;
  const buffer = restaurant.turnover_buffer_minutes;
  const slots = candidateSlots(restaurant, dateStr);
  const results = [];
  for (const slot of slots) {
    const table = findAvailableTable(restaurant.id, dateStr, slot.minutes, duration, partySize, buffer, null);
    const capOk = hasCapacityRoom(restaurant.id, dateStr, slot.minutes, partySize, null);
    results.push({ time: slot.time, shift: slot.shift, available: !!table && capOk });
  }
  return results;
}

function getZonesForDate(restaurantId, dateStr) {
  const floorPlanId = resolveFloorPlanId(restaurantId, dateStr);
  if (!floorPlanId) return [];
  return db.prepare(
    `SELECT * FROM zones WHERE restaurant_id = ? AND floor_plan_id = ? ORDER BY sort_order, name`
  ).all(restaurantId, floorPlanId);
}

// Public: the real, tappable floor plan for a specific date/time/party — every table's
// actual status (occupied by an existing reservation, too small for this party, or free),
// plus which currently-viable combinations each table belongs to. This is what lets the
// customer pick their own table instead of the system silently auto-assigning one.
function getTableMap(restaurantId, dateStr, startMinutes, durationMinutes, partySize, bufferMinutes) {
  const zones = getZonesForDate(restaurantId, dateStr);
  const zoneName = {};
  zones.forEach(z => { zoneName[z.id] = z.name; });

  const tables = getActiveTables(restaurantId, dateStr);
  const reqEnd = startMinutes + durationMinutes;
  const isFree = (table) => {
    const busy = tableBusyRanges(restaurantId, table.id, dateStr, bufferMinutes, null);
    return !busy.some(b => overlaps(startMinutes, reqEnd, b.start, b.end));
  };

  const tableFree = {};
  const tableStatus = {};
  for (const t of tables) {
    const free = isFree(t);
    tableFree[t.id] = free;
    tableStatus[t.id] = !free ? 'occupied' : (partySize > t.capacity_max ? 'toosmall' : 'available');
  }

  const combos = getCombinationsForDate(restaurantId, dateStr).map(c => {
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
function validateChosenTables(restaurantId, dateStr, tableIds, startMinutes, durationMinutes, partySize, bufferMinutes, excludeReservationId) {
  if (!Array.isArray(tableIds) || !tableIds.length) return null;
  const floorPlanId = resolveFloorPlanId(restaurantId, dateStr);
  if (!floorPlanId) return null;

  const placeholders = tableIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM tables WHERE restaurant_id = ? AND floor_plan_id = ? AND active = 1 AND id IN (${placeholders})`
  ).all(restaurantId, floorPlanId, ...tableIds);
  if (rows.length !== tableIds.length) return null; // a table doesn't belong to this date's plan

  const reqEnd = startMinutes + durationMinutes;
  for (const t of rows) {
    const busy = tableBusyRanges(restaurantId, t.id, dateStr, bufferMinutes, excludeReservationId);
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
