const { pool } = require('./db');
const { SALA_INTERIOR_POS, BARRA_POS } = require('./floorPositions');
const { renombrar } = require('./tableRenumbering');

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // survey_responses no hace falta borrarla a mano: tiene ON DELETE CASCADE
    // sobre reservations, así que se vacía sola al borrar las reservas.
    await client.query(`
      DELETE FROM reservation_tables;
      DELETE FROM reservations;
      DELETE FROM customers;
      DELETE FROM closures;
      DELETE FROM capacity_caps;
      DELETE FROM shifts;
      DELETE FROM table_combination_members;
      DELETE FROM table_combinations;
      DELETE FROM tables;
      DELETE FROM zones;
      DELETE FROM floor_plan_schedule;
      DELETE FROM floor_plans;
      DELETE FROM restaurants;
    `);
    // Reinicia las secuencias (equivalente al DELETE FROM sqlite_sequence de antes)
    // para que los ids vuelvan a empezar en 1 en cada resiembra.
    await client.query(`
      ALTER SEQUENCE restaurants_id_seq RESTART WITH 1;
      ALTER SEQUENCE floor_plans_id_seq RESTART WITH 1;
      ALTER SEQUENCE zones_id_seq RESTART WITH 1;
      ALTER SEQUENCE tables_id_seq RESTART WITH 1;
      ALTER SEQUENCE table_combinations_id_seq RESTART WITH 1;
      ALTER SEQUENCE shifts_id_seq RESTART WITH 1;
      ALTER SEQUENCE capacity_caps_id_seq RESTART WITH 1;
      ALTER SEQUENCE closures_id_seq RESTART WITH 1;
      ALTER SEQUENCE customers_id_seq RESTART WITH 1;
      ALTER SEQUENCE reservations_id_seq RESTART WITH 1;
      ALTER SEQUENCE floor_plan_schedule_id_seq RESTART WITH 1;
    `);

    // Duración media de servicio (75 min), intervalo de reserva (15 min), tope por reserva (20p)
    // y ventana de reserva (90 días máx., sin mínimo) replican la configuración real que el grupo
    // ya usa en CoverManager, para que el prototipo se comporte igual que hoy.
    const rRes = await client.query(`
      INSERT INTO restaurants (name, address, phone, email, default_duration_minutes, turnover_buffer_minutes, slot_interval_minutes, max_party_size, max_advance_days, min_advance_minutes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
    `, ['Saona Plaza España', 'Calle Ventura Rodríguez, 7, Madrid', '+34 960 000 000', 'piloto@gruposaona.com', 75, 15, 15, 20, 90, 0]);
    const restaurantId = rRes.rows[0].id;

    // --- Plano estándar (por defecto) -------------------------------------
    const planRes = await client.query(
      'INSERT INTO floor_plans (restaurant_id, name, is_default) VALUES ($1,$2,$3) RETURNING id',
      [restaurantId, 'Plano estándar', 1]
    );
    const standardPlanId = planRes.rows[0].id;

    const zone1 = await client.query(
      'INSERT INTO zones (restaurant_id, floor_plan_id, name, sort_order) VALUES ($1,$2,$3,$4) RETURNING id',
      [restaurantId, standardPlanId, 'Sala Interior', 1]
    );
    const salaInteriorZoneId = zone1.rows[0].id;
    const zone2 = await client.query(
      'INSERT INTO zones (restaurant_id, floor_plan_id, name, sort_order) VALUES ($1,$2,$3,$4) RETURNING id',
      [restaurantId, standardPlanId, 'Barra', 2]
    );
    const barraZoneId = zone2.rows[0].id;

    // Mesas reales de Plaza España, exportadas de Cover (nombre = "ID mesa" tal cual
    // aparece en Cover, para que el equipo reconozca cada mesa por el mismo número que
    // ya usa a diario). aforo (min,max) copiado literalmente de "Mínimo Pax"/"Máximo Pax".
    // Numeración ORIGINAL de Cover (con huecos y el salto a 508-519); se renumera
    // correlativa (1-38) al vuelo con renombrar(), sin retranscribir esta lista.
    const salaInteriorTables = [
      ['1', 2, 3], ['2', 2, 3], ['3', 2, 3], ['4', 2, 2], ['5', 2, 2], ['6', 2, 2],
      ['7', 2, 4], ['8', 3, 4], ['9', 3, 4], ['10', 3, 5], ['11', 3, 5], ['12', 3, 4],
      ['13', 6, 8], ['14', 2, 2], ['15', 2, 2], ['16', 2, 2], ['17', 1, 2], ['18', 2, 2],
      ['19', 2, 2], ['20', 2, 2], ['21', 2, 2], ['22', 1, 2], ['23', 7, 10], ['24', 2, 4],
      ['26', 2, 4], ['27', 2, 4],
      ['508', 1, 2], ['509', 2, 2], ['510', 1, 2], ['511', 2, 2], ['512', 1, 2], ['513', 2, 2],
      ['514', 2, 2], ['515', 2, 2], ['516', 2, 2], ['517', 2, 2], ['518', 2, 2], ['519', 2, 2],
    ].map(([nombre, capMin, capMax]) => [renombrar(nombre), capMin, capMax]);
    // Barra: puestos individuales (aforo 1), no tienen combinación entre sí.
    const barraTables = [
      ['201', 1, 1], ['202', 1, 1], ['203', 1, 1], ['204', 1, 1],
      ['205', 1, 1], ['206', 1, 1], ['207', 1, 1],
    ];

    // pos_x/pos_y (0-100, % del lienzo) — ver server/floorPositions.js (compartido con la
    // migración de db.js que las mantiene actualizadas en despliegues posteriores sin
    // tener que volver a sembrar toda la base de datos).
    const tableId = {};
    for (const [name, capMin, capMax] of salaInteriorTables) {
      const [x, y] = SALA_INTERIOR_POS[name];
      const res = await client.query(`
        INSERT INTO tables (restaurant_id, floor_plan_id, zone_id, name, capacity_min, capacity_max, pos_x, pos_y, active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1) RETURNING id
      `, [restaurantId, standardPlanId, salaInteriorZoneId, name, capMin, capMax, x, y]);
      tableId[name] = res.rows[0].id;
    }
    for (const [name, capMin, capMax] of barraTables) {
      const [x, y] = BARRA_POS[name];
      const res = await client.query(`
        INSERT INTO tables (restaurant_id, floor_plan_id, zone_id, name, capacity_min, capacity_max, pos_x, pos_y, active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1) RETURNING id
      `, [restaurantId, standardPlanId, barraZoneId, name, capMin, capMax, x, y]);
      tableId[name] = res.rows[0].id;
    }

    // Combinaciones de mesas: reglas reales exportadas de Cover (pestaña "Combinación de
    // mesas"), con el aforo (max,min) que el propio local ya tiene configurado — no siempre
    // coincide con la suma de las mesas (dos mesas de 2 pueden dar servicio a 6 por las
    // sillas de esquina añadidas al juntarlas), por eso se fija a mano en vez de calcularse.
    async function addCombo(memberNames, capMin, capMax, comboName) {
      const name = comboName || memberNames.join('+');
      const res = await client.query(
        'INSERT INTO table_combinations (restaurant_id, floor_plan_id, name, active, capacity_min, capacity_max) VALUES ($1,$2,$3,1,$4,$5) RETURNING id',
        [restaurantId, standardPlanId, name, capMin, capMax]
      );
      const comboId = res.rows[0].id;
      for (const n of memberNames) {
        await client.query('INSERT INTO table_combination_members (combination_id, table_id) VALUES ($1,$2)', [comboId, tableId[n]]);
      }
    }
    // Cierre total de Sala Interior (buyout), tal cual la fila especial de Cover: las 38
    // mesas de la sala a la vez, aforo 99-250. Con el tope actual de reserva online
    // (max_party_size=20) esta combinación no la puede activar un cliente por la web —
    // solo tiene efecto si el local sube ese tope o la reserva se crea desde el panel
    // de admin sin pasar por ese límite.
    await addCombo(salaInteriorTables.map(([n]) => n), 99, 250, 'Cierre total Sala Interior (buyout)');
    // [mesas, min, max] — copiado literal de la pantalla de combinaciones de Cover para
    // Plaza España. No incluye (todavía) una fila cuyas mesas no se llegaron a capturar
    // en la captura (aforo 14/12) — pendiente de confirmar con el local antes de añadirla.
    const realCombos = [
      [['1', '22', '510', '516'], 3, 4],
      [['1', '516'], 4, 6],
      [['10', '11'], 6, 8],
      [['11', '12'], 6, 8],
      [['14', '15', '16', '17', '18', '19', '20', '21', '22', '510', '511', '512', '513', '514', '515', '519'], 30, 32],
      [['14', '15', '16', '17', '18', '19', '20', '21', '511', '512', '513', '514', '515', '519'], 28, 30],
      [['14', '15', '16', '17', '18', '19', '20', '21', '512', '513', '514', '515', '519'], 26, 28],
      [['14', '15', '16', '17', '18', '19', '20', '512', '513', '514', '515', '519'], 24, 26],
      [['14', '15', '16', '17', '18', '19', '20', '513', '514', '515', '519'], 22, 24],
      [['14', '15', '16', '17', '18', '19', '513', '514', '515', '519'], 20, 22],
      [['14', '15', '16', '17', '18', '19', '513', '514', '515'], 18, 20],
      [['14', '15', '16', '17', '18', '513', '514', '515'], 16, 18],
      [['14', '15', '16', '17', '514', '515'], 14, 16],
      [['14', '15', '16', '17', '515'], 10, 12],
      [['14', '15', '16', '515'], 7, 10],
      [['14', '515'], 4, 6],
      [['15', '16'], 4, 6],
      [['15', '16', '17', '514'], 7, 10],
      [['15', '16', '17', '515'], 7, 10],
      [['15', '515'], 4, 6],
      [['16', '17'], 4, 6],
      [['17', '514'], 4, 6],
      [['18', '19', '513', '519'], 7, 10],
      [['18', '513'], 4, 6],
      [['19', '20', '512', '519'], 7, 10],
      [['19', '20', '513', '519'], 7, 10],
      [['19', '513'], 4, 6],
      [['19', '519'], 3, 4],
      [['2', '3', '517', '518'], 8, 10],
      [['2', '517'], 4, 6],
      [['20', '512'], 4, 6],
      [['20', '519'], 4, 6],
      [['21', '22', '510', '511'], 7, 10],
      [['21', '511'], 4, 6],
      [['22', '510'], 4, 6],
      [['22', '511'], 4, 6],
      [['3', '518'], 4, 6],
      [['4', '5'], 4, 6],
      [['4', '5', '6'], 6, 8],
      [['4', '5', '6', '509'], 7, 10],
      [['5', '6'], 4, 6],
      [['5', '6', '509'], 6, 8],
      [['6', '509'], 4, 6],
      [['7', '8'], 3, 5],
    ];
    // Mismas combinaciones físicas de siempre (ver comentario arriba) — solo se
    // renombran los miembros a la numeración correlativa nueva.
    for (const [members, min, max] of realCombos) await addCombo(members.map(renombrar), min, max);

    // --- Segundo plano de ejemplo: "Plano evento" (terraza reorganizada para grupos
    // grandes) — demuestra que un local puede tener varios planos y programar cuál
    // aplica cada día sin afectar a las mesas/reservas del plano estándar.
    const eventPlanRes = await client.query(
      'INSERT INTO floor_plans (restaurant_id, name, is_default) VALUES ($1,$2,$3) RETURNING id',
      [restaurantId, 'Plano evento', 0]
    );
    const eventPlanId = eventPlanRes.rows[0].id;
    const eventTerrazaZoneRes = await client.query(
      'INSERT INTO zones (restaurant_id, floor_plan_id, name, sort_order) VALUES ($1,$2,$3,$4) RETURNING id',
      [restaurantId, eventPlanId, 'Terraza (evento)', 1]
    );
    const eventTerrazaZoneId = eventTerrazaZoneRes.rows[0].id;
    const eventSalonZoneRes = await client.query(
      'INSERT INTO zones (restaurant_id, floor_plan_id, name, sort_order) VALUES ($1,$2,$3,$4) RETURNING id',
      [restaurantId, eventPlanId, 'Salón', 2]
    );
    const eventSalonZoneId = eventSalonZoneRes.rows[0].id;

    const eventTableId = {};
    const eventTableDefs = [
      ['M1', eventSalonZoneId, 1, 2, 22, 20], ['M2', eventSalonZoneId, 1, 2, 22, 44],
      ['M3', eventSalonZoneId, 2, 4, 52, 24], ['M4', eventSalonZoneId, 2, 4, 52, 46], ['M5', eventSalonZoneId, 4, 6, 80, 34],
      // La terraza se reorganiza en 3 mesas grandes para un evento (en vez de T1-T4)
      ['E1', eventTerrazaZoneId, 4, 8, 28, 30], ['E2', eventTerrazaZoneId, 4, 8, 72, 26], ['E3', eventTerrazaZoneId, 6, 10, 50, 64],
    ];
    for (const [name, zoneId, capMin, capMax, posX, posY] of eventTableDefs) {
      const res = await client.query(`
        INSERT INTO tables (restaurant_id, floor_plan_id, zone_id, name, capacity_min, capacity_max, pos_x, pos_y, active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1) RETURNING id
      `, [restaurantId, eventPlanId, zoneId, name, capMin, capMax, posX, posY]);
      eventTableId[name] = res.rows[0].id;
    }
    async function addEventCombo(name, memberNames) {
      const res = await client.query(
        'INSERT INTO table_combinations (restaurant_id, floor_plan_id, name, active, capacity_min, capacity_max) VALUES ($1,$2,$3,1,NULL,NULL) RETURNING id',
        [restaurantId, eventPlanId, name]
      );
      const comboId = res.rows[0].id;
      for (const n of memberNames) {
        await client.query('INSERT INTO table_combination_members (combination_id, table_id) VALUES ($1,$2)', [comboId, eventTableId[n]]);
      }
    }
    // Combinación de 3 mesas para grupos muy grandes — ejemplo de que ya no está
    // limitado a parejas de mesas como en la versión anterior del prototipo.
    await addEventCombo('E1+E2+E3', ['E1', 'E2', 'E3']);

    // Shifts: comida (13:00-16:00) y cena (20:00-23:30), martes a domingo; lunes cerrado
    // day_of_week: 0=domingo ... 6=sabado. Cerramos lunes (1).
    for (let dow = 0; dow <= 6; dow++) {
      if (dow === 1) continue;
      await client.query(
        'INSERT INTO shifts (restaurant_id, name, day_of_week, start_time, end_time, last_seating_offset_minutes) VALUES ($1,$2,$3,$4,$5,$6)',
        [restaurantId, 'Comida', dow, '13:00', '16:00', 30]
      );
      await client.query(
        'INSERT INTO shifts (restaurant_id, name, day_of_week, start_time, end_time, last_seating_offset_minutes) VALUES ($1,$2,$3,$4,$5,$6)',
        [restaurantId, 'Cena', dow, '20:00', '23:30', 30]
      );
    }

    // Cupo de aforo por franja horaria y día de la semana, replicando el ejemplo real
    // observado en la configuración de CoverManager del grupo (más restrictivo que la
    // simple disponibilidad de mesa en ciertos tramos, p. ej. sábado 16:00-16:45).
    const caps = [
      // Domingo (0)
      [0, '00:00', '13:00', 20], [0, '13:00', '13:30', 25], [0, '13:30', '23:59', 20],
      // Martes (2) y Miércoles (3): cupo plano
      [2, '00:00', '23:59', 20],
      [3, '00:00', '23:59', 20],
      // Jueves (4)
      [4, '00:00', '20:00', 20], [4, '20:00', '20:30', 30], [4, '20:30', '23:59', 25],
      // Viernes (5)
      [5, '00:00', '20:00', 20], [5, '20:00', '20:30', 30], [5, '20:30', '22:45', 25],
      [5, '22:45', '23:00', 30], [5, '23:00', '23:59', 25],
      // Sábado (6) — el más granular, refleja picos de cocina/sala a lo largo del día
      [6, '00:00', '13:00', 20], [6, '13:00', '13:30', 25], [6, '13:30', '16:00', 20],
      [6, '16:00', '16:45', 15], [6, '16:45', '20:00', 20], [6, '20:00', '20:30', 30],
      [6, '20:30', '22:45', 25], [6, '22:45', '23:00', 30], [6, '23:00', '23:59', 25],
    ];
    for (const c of caps) {
      await client.query(
        'INSERT INTO capacity_caps (restaurant_id, day_of_week, start_time, end_time, max_covers) VALUES ($1,$2,$3,$4,$5)',
        [restaurantId, ...c]
      );
    }

    // Ejemplo de agenda: el sábado 2026-08-22 se usa el "Plano evento" en vez del
    // estándar. El resto de días siguen usando el plano por defecto automáticamente.
    await client.query(
      'INSERT INTO floor_plan_schedule (restaurant_id, date, floor_plan_id) VALUES ($1,$2,$3)',
      [restaurantId, '2026-08-22', eventPlanId]
    );

    await client.query('COMMIT');
    console.log(`Seed completo. restaurantId=${restaurantId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = seed;

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}
