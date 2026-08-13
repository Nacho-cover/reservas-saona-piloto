const db = require('./db');

const tx = db.transaction(() => {
  db.exec(`
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
    DELETE FROM sqlite_sequence WHERE name IN
      ('reservations','customers','closures','capacity_caps','shifts','table_combinations',
       'tables','zones','floor_plan_schedule','floor_plans','restaurants');
  `);

  // Duración media de servicio (75 min), intervalo de reserva (15 min), tope por reserva (20p)
  // y ventana de reserva (90 días máx., sin mínimo) replican la configuración real que el grupo
  // ya usa en CoverManager, para que el prototipo se comporte igual que hoy.
  const r = db.prepare(`
    INSERT INTO restaurants (name, address, phone, email, default_duration_minutes, turnover_buffer_minutes, slot_interval_minutes, max_party_size, max_advance_days, min_advance_minutes)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run('Saona Plaza España', 'Calle Ventura Rodríguez, 7, Madrid', '+34 960 000 000', 'piloto@gruposaona.com', 75, 15, 15, 20, 90, 0);
  const restaurantId = r.lastInsertRowid;

  // --- Plano estándar (por defecto) -------------------------------------
  const insertPlan = db.prepare('INSERT INTO floor_plans (restaurant_id, name, is_default) VALUES (?,?,?)');
  const standardPlanId = insertPlan.run(restaurantId, 'Plano estándar', 1).lastInsertRowid;

  const insertZone = db.prepare('INSERT INTO zones (restaurant_id, floor_plan_id, name, sort_order) VALUES (?,?,?,?)');
  const salaInteriorZoneId = insertZone.run(restaurantId, standardPlanId, 'Sala Interior', 1).lastInsertRowid;
  const barraZoneId = insertZone.run(restaurantId, standardPlanId, 'Barra', 2).lastInsertRowid;

  // Mesas reales de Plaza España, exportadas de Cover (nombre = "ID mesa" tal cual
  // aparece en Cover, para que el equipo reconozca cada mesa por el mismo número que
  // ya usa a diario). aforo (min,max) copiado literalmente de "Mínimo Pax"/"Máximo Pax".
  const insertTable = db.prepare(`
    INSERT INTO tables (restaurant_id, floor_plan_id, zone_id, name, capacity_min, capacity_max, pos_x, pos_y, active)
    VALUES (?,?,?,?,?,?,?,?,1)
  `);
  const salaInteriorTables = [
    ['1', 2, 3], ['2', 2, 3], ['3', 2, 3], ['4', 2, 2], ['5', 2, 2], ['6', 2, 2],
    ['7', 2, 4], ['8', 3, 4], ['9', 3, 4], ['10', 3, 5], ['11', 3, 5], ['12', 3, 4],
    ['13', 6, 8], ['14', 2, 2], ['15', 2, 2], ['16', 2, 2], ['17', 1, 2], ['18', 2, 2],
    ['19', 2, 2], ['20', 2, 2], ['21', 2, 2], ['22', 1, 2], ['23', 7, 10], ['24', 2, 4],
    ['26', 2, 4], ['27', 2, 4],
    ['508', 1, 2], ['509', 2, 2], ['510', 1, 2], ['511', 2, 2], ['512', 1, 2], ['513', 2, 2],
    ['514', 2, 2], ['515', 2, 2], ['516', 2, 2], ['517', 2, 2], ['518', 2, 2], ['519', 2, 2],
  ];
  // Barra: puestos individuales (aforo 1), no tienen combinación entre sí.
  const barraTables = [
    ['201', 1, 1], ['202', 1, 1], ['203', 1, 1], ['204', 1, 1],
    ['205', 1, 1], ['206', 1, 1], ['207', 1, 1],
  ];

  // pos_x/pos_y (0-100, % del lienzo) recalculadas a partir de la segunda captura del
  // plano de Cover (más nítida, con medidas de distancias reales entre mesas). Cover
  // no exporta coordenadas, así que esto sigue siendo una lectura a ojo de la imagen,
  // no una medida exacta — se puede reajustar mesa a mesa más adelante si no encaja.
  // Las mesas 508-519 ocupan, en el plano de Cover, las posiciones que antes eran
  // 25 y 28-38 (los únicos números que faltan en el listado de "ID mesa"), así que
  // se colocan ahí; si esa suposición no es correcta basta con mover la mesa a mano.
  const salaInteriorPos = {
    '9': [6, 14], '8': [15, 14], '7': [22, 14],
    '519': [73, 10],
    '13': [6, 33], '12': [14, 33], '11': [21, 33], '10': [28, 33],
    '6': [40, 41], '4': [51, 41], '2': [58, 41],
    '5': [40, 49], '3': [51, 49], '1': [58, 49],
    '17': [5, 49], '16': [10, 49], '15': [17, 49], '14': [24, 49],
    '18': [4, 61], '19': [4, 69], '20': [4, 78],
    '518': [21, 69], '517': [41, 69], '516': [51, 69], '515': [62, 69],
    '21': [4, 87], '22': [11, 87], '23': [16, 87],
    '24': [25, 87], '508': [30, 87], '26': [35, 87], '27': [40, 87],
    '509': [46, 87], '510': [51, 87],
    '511': [60, 87], '512': [65, 87], '513': [71, 87], '514': [75, 87],
  };
  // La Barra es una zona/pestaña aparte en Cover: se coloca en su propia franja
  // arriba del lienzo para no solaparse con la Sala Interior.
  const barraPos = {
    '201': [30, 3], '202': [38, 3], '203': [46, 3], '204': [54, 3],
    '205': [62, 3], '206': [70, 3], '207': [78, 3],
  };
  const tableId = {};
  salaInteriorTables.forEach(([name, capMin, capMax]) => {
    const [x, y] = salaInteriorPos[name];
    tableId[name] = insertTable.run(restaurantId, standardPlanId, salaInteriorZoneId, name, capMin, capMax, x, y).lastInsertRowid;
  });
  barraTables.forEach(([name, capMin, capMax]) => {
    const [x, y] = barraPos[name];
    tableId[name] = insertTable.run(restaurantId, standardPlanId, barraZoneId, name, capMin, capMax, x, y).lastInsertRowid;
  });

  // Combinaciones de mesas: reglas reales exportadas de Cover (pestaña "Combinación de
  // mesas"), con el aforo (max,min) que el propio local ya tiene configurado — no siempre
  // coincide con la suma de las mesas (dos mesas de 2 pueden dar servicio a 6 por las
  // sillas de esquina añadidas al juntarlas), por eso se fija a mano en vez de calcularse.
  const insertCombo = db.prepare('INSERT INTO table_combinations (restaurant_id, floor_plan_id, name, active, capacity_min, capacity_max) VALUES (?,?,?,1,?,?)');
  const insertComboMember = db.prepare('INSERT INTO table_combination_members (combination_id, table_id) VALUES (?,?)');
  const addCombo = (memberNames, capMin, capMax, comboName) => {
    const name = comboName || memberNames.join('+');
    const comboId = insertCombo.run(restaurantId, standardPlanId, name, capMin, capMax).lastInsertRowid;
    for (const n of memberNames) insertComboMember.run(comboId, tableId[n]);
  };
  // Cierre total de Sala Interior (buyout), tal cual la fila especial de Cover: las 38
  // mesas de la sala a la vez, aforo 99-250. Con el tope actual de reserva online
  // (max_party_size=20) esta combinación no la puede activar un cliente por la web —
  // solo tiene efecto si el local sube ese tope o la reserva se crea desde el panel
  // de admin sin pasar por ese límite.
  addCombo(salaInteriorTables.map(([n]) => n), 99, 250, 'Cierre total Sala Interior (buyout)');
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
  for (const [members, min, max] of realCombos) addCombo(members, min, max);

  // --- Segundo plano de ejemplo: "Plano evento" (terraza reorganizada para grupos
  // grandes) — demuestra que un local puede tener varios planos y programar cuál
  // aplica cada día sin afectar a las mesas/reservas del plano estándar.
  const eventPlanId = insertPlan.run(restaurantId, 'Plano evento', 0).lastInsertRowid;
  const eventTerrazaZoneId = insertZone.run(restaurantId, eventPlanId, 'Terraza (evento)', 1).lastInsertRowid;
  const eventSalonZoneId = insertZone.run(restaurantId, eventPlanId, 'Salón', 2).lastInsertRowid;

  const eventTableId = {};
  const eventTableDefs = [
    ['M1', eventSalonZoneId, 1, 2, 22, 20], ['M2', eventSalonZoneId, 1, 2, 22, 44],
    ['M3', eventSalonZoneId, 2, 4, 52, 24], ['M4', eventSalonZoneId, 2, 4, 52, 46], ['M5', eventSalonZoneId, 4, 6, 80, 34],
    // La terraza se reorganiza en 3 mesas grandes para un evento (en vez de T1-T4)
    ['E1', eventTerrazaZoneId, 4, 8, 28, 30], ['E2', eventTerrazaZoneId, 4, 8, 72, 26], ['E3', eventTerrazaZoneId, 6, 10, 50, 64],
  ];
  for (const [name, zoneId, capMin, capMax, posX, posY] of eventTableDefs) {
    eventTableId[name] = insertTable.run(restaurantId, eventPlanId, zoneId, name, capMin, capMax, posX, posY).lastInsertRowid;
  }
  const addEventCombo = (name, memberNames) => {
    const comboId = insertCombo.run(restaurantId, eventPlanId, name, null, null).lastInsertRowid;
    for (const n of memberNames) insertComboMember.run(comboId, eventTableId[n]);
  };
  // Combinación de 3 mesas para grupos muy grandes — ejemplo de que ya no está
  // limitado a parejas de mesas como en la versión anterior del prototipo.
  addEventCombo('E1+E2+E3', ['E1', 'E2', 'E3']);

  // Shifts: comida (13:00-16:00) y cena (20:00-23:30), martes a domingo; lunes cerrado
  const insertShift = db.prepare(`
    INSERT INTO shifts (restaurant_id, name, day_of_week, start_time, end_time, last_seating_offset_minutes)
    VALUES (?,?,?,?,?,?)
  `);
  // day_of_week: 0=domingo ... 6=sabado. Cerramos lunes (1).
  for (let dow = 0; dow <= 6; dow++) {
    if (dow === 1) continue; // lunes cerrado
    insertShift.run(restaurantId, 'Comida', dow, '13:00', '16:00', 30);
    insertShift.run(restaurantId, 'Cena', dow, '20:00', '23:30', 30);
  }

  // Cupo de aforo por franja horaria y día de la semana, replicando el ejemplo real
  // observado en la configuración de CoverManager del grupo (más restrictivo que la
  // simple disponibilidad de mesa en ciertos tramos, p. ej. sábado 16:00-16:45).
  const insertCap = db.prepare(`
    INSERT INTO capacity_caps (restaurant_id, day_of_week, start_time, end_time, max_covers)
    VALUES (?,?,?,?,?)
  `);
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
  for (const c of caps) insertCap.run(restaurantId, ...c);

  // Ejemplo de agenda: el sábado 2026-08-22 se usa el "Plano evento" en vez del
  // estándar. El resto de días siguen usando el plano por defecto automáticamente.
  db.prepare('INSERT INTO floor_plan_schedule (restaurant_id, date, floor_plan_id) VALUES (?,?,?)')
    .run(restaurantId, '2026-08-22', eventPlanId);

  console.log(`Seed completo. restaurantId=${restaurantId}`);
});

tx();
