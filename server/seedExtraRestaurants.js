const { pool } = require('./db');

// Locales REALES adicionales, leídos del panel de Cover (solo lectura) el
// 2026-10-02: plano operativo "SAONA BALBOA OP" de Saona Balboa y plano
// "Saona Bilbao" de Saona Bilbao Henao — mesas, aforos mín/máx, zonas y
// combinaciones exactas. Posiciones (0-100 % del lienzo) convertidas de las
// coordenadas del editor de Cover; Bilbao tiene 2 plantas en Cover (SALA y
// SALA -1), aquí van como zonas "Sala" y "Sala -1" en el mismo lienzo.
// La mesa 23 de Bilbao tiene aforo 0 en Cover y entra desactivada.
//
// ADITIVO y seguro de repetir: solo INSERT, se salta los locales que ya
// existen por nombre. Horarios y cupo por día son PROVISIONALES (mismo patrón
// que Plaza España) hasta revisar "Experiencia cliente → Limitaciones" de cada
// local en Cover. Ya aplicado en producción el 2026-10-02.
const REAL_RESTAURANTS = [
  {
    name: "Saona Balboa",
    address: "C. del Gral. Oráa, 38, 28006 Madrid",
    phone: "+34 911 982 057",
    email: 'reservas@gruposaona.com',
    capPerDay: 30,
    zones: ["Sala", "Mesa alta con taburete", "Barra"],
    // [idCover, nombre, aforoMín, aforoMáx, zona, pos_x, pos_y, activa]
    tables: [
      ["1", "1", 1, 2, "Sala", 11, 5, 1],
      ["2", "2", 1, 2, "Sala", 12, 16, 1],
      ["3", "3", 1, 2, "Sala", 25, 6, 1],
      ["4", "4", 1, 2, "Sala", 26, 16, 1],
      ["5", "5", 1, 2, "Sala", 40, 5, 1],
      ["6", "6", 1, 2, "Sala", 40, 15, 1],
      ["7", "7", 3, 5, "Sala", 58, 6, 1],
      ["9", "9", 1, 2, "Sala", 58, 22, 1],
      ["10", "NH 10", 1, 2, "Sala", 58, 31, 1],
      ["11", "11", 2, 2, "Sala", 53, 41, 1],
      ["14", "14", 4, 5, "Sala", 52, 59, 1],
      ["15", "15", 3, 6, "Sala", 52, 67, 1],
      ["17", "17", 3, 5, "Sala", 52, 75, 1],
      ["20", "20", 2, 2, "Sala", 52, 84, 1],
      ["21", "21", 1, 3, "Sala", 4, 28, 1],
      ["22", "22", 2, 4, "Sala", 17, 27, 1],
      ["23", "23", 2, 4, "Sala", 34, 28, 1],
      ["24", "24", 2, 4, "Sala", 35, 52, 1],
      ["25", "25", 3, 4, "Sala", 35, 66, 1],
      ["26", "26", 6, 12, "Mesa alta con taburete", 30, 88, 1],
      ["101", "B1", 1, 1, "Barra", 68, 30, 1],
      ["102", "B2", 1, 1, "Barra", 71, 30, 1],
      ["103", "B3", 1, 1, "Barra", 75, 31, 1],
      ["104", "B4", 1, 1, "Barra", 78, 31, 1],
      ["105", "B5", 1, 1, "Barra", 81, 31, 1],
      ["106", "B6", 1, 1, "Barra", 84, 30, 1],
      ["107", "B7", 1, 1, "Barra", 87, 30, 1],
      ["108", "B8", 1, 1, "Barra", 90, 30, 1],
      ["109", "B9", 1, 1, "Barra", 93, 31, 1],
      ["110", "B10", 1, 1, "Barra", 96, 40, 1],
      ["111", "B11", 1, 1, "Barra", 96, 50, 1],
      ["112", "B12", 1, 1, "Barra", 96, 60, 1],
      ["220", "220", 2, 2, "Sala", 52, 92, 1],
      ["2111", "211", 2, 2, "Sala", 52, 50, 1],
    ],
    // [nombre, [idCover de las mesas], aforoMín, aforoMáx]
    combinations: [
      ["1+2", ["1", "2"], 3, 6],
      ["1+2+3", ["1", "2", "3"], 8, 8],
      ["1+2+3+4", ["1", "2", "3", "4"], 10, 11],
      ["Cierre total Sala (buyout)", ["1", "2", "3", "4", "5", "6", "7", "9", "10", "11", "14", "15", "17", "20", "21", "22", "23", "24", "25", "26", "220", "2111"], 98, 99],
      ["1+2+4", ["1", "2", "4"], 8, 8],
      ["1+3+4", ["1", "3", "4"], 8, 8],
      ["11+211", ["11", "2111"], 3, 5],
      ["14+15+17+20", ["14", "15", "17", "20"], 16, 20],
      ["15+17", ["15", "17"], 8, 10],
      ["15+17+20", ["15", "17", "20"], 12, 15],
      ["2+3+4", ["2", "3", "4"], 8, 8],
      ["20+220", ["20", "220"], 3, 5],
      ["3+4", ["3", "4"], 3, 6],
      ["5+6", ["5", "6"], 3, 6],
      ["5+6+7", ["5", "6", "7"], 10, 11],
      ["7+9", ["7", "9"], 6, 8],
      ["7+9+NH 10", ["7", "9", "10"], 9, 12],
      ["7+9+NH 10+11", ["7", "9", "10", "11"], 11, 13],
      ["9+NH 10", ["9", "10"], 3, 6],
    ],
  },
  {
    name: "Saona Bilbao Henao",
    address: "Henao Kalea, 42, 48009 Bilbao",
    phone: "+34 944 258 767",
    email: 'reservas@gruposaona.com',
    capPerDay: 50,
    zones: ["Sala", "Sala -1", "Barra"],
    // [idCover, nombre, aforoMín, aforoMáx, zona, pos_x, pos_y, activa]
    tables: [
      ["1", "1", 1, 2, "Sala", 4, 11, 1],
      ["2", "2", 1, 2, "Sala", 12, 11, 1],
      ["3", "3", 1, 3, "Sala", 21, 11, 1],
      ["4", "4", 1, 2, "Sala", 24, 22, 1],
      ["5", "5", 1, 2, "Sala", 24, 30, 1],
      ["6", "6", 1, 2, "Sala", 24, 38, 1],
      ["7", "7", 1, 2, "Sala", 23, 46, 1],
      ["8", "8", 2, 6, "Sala", 26, 63, 1],
      ["9", "9", 2, 5, "Sala", 35, 63, 1],
      ["10", "10", 1, 2, "Sala", 44, 68, 1],
      ["11", "11", 1, 2, "Sala", 52, 68, 1],
      ["12", "12", 1, 2, "Sala", 61, 68, 1],
      ["13", "13", 1, 2, "Sala", 70, 68, 1],
      ["14", "14", 2, 5, "Sala", 80, 63, 1],
      ["15", "15", 3, 5, "Barra", 92, 62, 1],
      ["17", "17", 2, 5, "Sala", 90, 52, 1],
      ["18", "18", 1, 2, "Sala", 95, 45, 1],
      ["19", "19", 1, 2, "Sala", 95, 37, 1],
      ["20", "20", 1, 2, "Sala", 95, 30, 1],
      ["21", "21", 1, 2, "Sala", 95, 22, 1],
      ["22", "22", 2, 5, "Sala", 95, 14, 1],
      ["23", "23", 0, 0, "Sala", 88, 14, 0],
      ["24", "24", 6, 9, "Sala", 91, 4, 1],
      ["25", "25", 2, 4, "Sala", 69, 12, 1],
      ["26", "26", 3, 4, "Sala", 67, 25, 1],
      ["27", "27", 6, 8, "Sala", 67, 34, 1],
      ["28", "28", 3, 4, "Sala", 71, 47, 1],
      ["29", "29", 3, 4, "Sala", 48, 47, 1],
      ["30", "30", 6, 8, "Sala", 47, 34, 1],
      ["31", "31", 3, 4, "Sala", 47, 24, 1],
      ["32", "32", 2, 4, "Sala", 47, 14, 1],
      ["33", "33", 3, 5, "Sala -1", 14, 95, 1],
      ["34", "34", 3, 5, "Sala -1", 40, 94, 1],
      ["35", "35", 3, 5, "Sala -1", 63, 95, 1],
      ["36", "36", 1, 2, "Sala -1", 80, 78, 1],
      ["37", "37", 1, 2, "Sala -1", 72, 78, 1],
      ["38", "38", 1, 2, "Sala -1", 64, 78, 1],
      ["39", "39", 1, 2, "Sala -1", 50, 78, 1],
      ["40", "40", 1, 2, "Sala -1", 42, 78, 1],
      ["41", "41", 1, 2, "Sala -1", 34, 78, 1],
      ["42", "42", 1, 2, "Sala -1", 20, 78, 1],
      ["43", "43", 1, 2, "Sala -1", 13, 78, 1],
      ["44", "44", 1, 2, "Sala -1", 5, 78, 1],
      ["45", "45", 2, 2, "Sala -1", 4, 95, 1],
      ["101", "101", 2, 3, "Barra", 10, 4, 1],
      ["102", "102", 1, 2, "Barra", 36, 25, 1],
      ["103", "103", 1, 2, "Barra", 36, 43, 1],
    ],
    // [nombre, [idCover de las mesas], aforoMín, aforoMáx]
    combinations: [
      ["Cierre total Sala (buyout)", ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32"], 23, 250],
      ["10+11", ["10", "11"], 3, 4],
      ["10+11+12", ["10", "11", "12"], 6, 7],
      ["11+12", ["11", "12"], 3, 4],
      ["11+12+13", ["11", "12", "13"], 5, 6],
      ["12+13", ["12", "13"], 3, 4],
      ["12+13+14", ["12", "13", "14"], 6, 7],
      ["13+14", ["13", "14"], 3, 5],
      ["17+18", ["17", "18"], 3, 5],
      ["17+18+19", ["17", "18", "19"], 6, 7],
      ["17+18+19+20", ["17", "18", "19", "20"], 9, 13],
      ["17+18+19+20+21+22+23", ["17", "18", "19", "20", "21", "22", "23"], 13, 22],
      ["18+19", ["18", "19"], 3, 4],
      ["19+20", ["19", "20"], 3, 4],
      ["19+20+21", ["19", "20", "21"], 6, 7],
      ["20+21", ["20", "21"], 3, 4],
      ["20+21+22+23", ["20", "21", "22", "23"], 9, 12],
      ["21+22", ["21", "22"], 3, 4],
      ["21+22+23", ["21", "22", "23"], 5, 7],
      ["22+23", ["22", "23"], 3, 5],
      ["33+45", ["33", "45"], 6, 7],
      ["36+37", ["36", "37"], 3, 4],
      ["36+37+38", ["36", "37", "38"], 5, 8],
      ["37+38", ["37", "38"], 3, 4],
      ["39+40", ["39", "40"], 3, 4],
      ["39+40+41", ["39", "40", "41"], 5, 9],
      ["4+5", ["4", "5"], 3, 4],
      ["4+5+6", ["4", "5", "6"], 5, 6],
      ["4+5+6+7", ["4", "5", "6", "7"], 5, 10],
      ["40+41", ["40", "41"], 3, 4],
      ["42+43", ["42", "43"], 3, 5],
      ["42+43+44", ["42", "43", "44"], 6, 9],
      ["43+44", ["43", "44"], 3, 4],
      ["5+6", ["5", "6"], 3, 4],
      ["6+7", ["6", "7"], 3, 5],
      ["8+9+10", ["8", "9", "10"], 5, 6],
    ],
  },
];

async function seedExtraRestaurants() {
  const client = await pool.connect();
  try {
    for (const def of REAL_RESTAURANTS) {
      const existing = await client.query('SELECT id FROM restaurants WHERE name = $1', [def.name]);
      if (existing.rows.length) {
        console.log(`Ya existe "${def.name}" (id=${existing.rows[0].id}) — se omite.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        const { rows: [r] } = await client.query(`
          INSERT INTO restaurants (name, address, phone, email, default_duration_minutes, turnover_buffer_minutes, slot_interval_minutes, max_party_size, max_advance_days, min_advance_minutes)
          VALUES ($1,$2,$3,$4,75,15,15,20,90,0) RETURNING id`, [def.name, def.address, def.phone, def.email]);
        const { rows: [plan] } = await client.query(
          'INSERT INTO floor_plans (restaurant_id, name, is_default) VALUES ($1,$2,1) RETURNING id', [r.id, 'Plano estándar']);

        const zoneIds = {};
        for (const [i, zone] of def.zones.entries()) {
          const { rows: [z] } = await client.query(
            'INSERT INTO zones (restaurant_id, floor_plan_id, name, sort_order) VALUES ($1,$2,$3,$4) RETURNING id', [r.id, plan.id, zone, i + 1]);
          zoneIds[zone] = z.id;
        }

        const tableIds = {};
        for (const [coverId, name, min, max, zone, x, y, active] of def.tables) {
          const { rows: [t] } = await client.query(`
            INSERT INTO tables (restaurant_id, floor_plan_id, zone_id, name, capacity_min, capacity_max, pos_x, pos_y, active)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [r.id, plan.id, zoneIds[zone], name, min, max, x, y, active]);
          tableIds[coverId] = t.id;
        }

        for (const [name, members, min, max] of def.combinations) {
          const { rows: [c] } = await client.query(`
            INSERT INTO table_combinations (restaurant_id, floor_plan_id, name, active, capacity_min, capacity_max)
            VALUES ($1,$2,$3,1,$4,$5) RETURNING id`, [r.id, plan.id, name, min, max]);
          for (const m of members) {
            await client.query('INSERT INTO table_combination_members (combination_id, table_id) VALUES ($1,$2)', [c.id, tableIds[m]]);
          }
        }

        // day_of_week: 0=domingo ... 6=sábado; lunes cerrado.
        for (let dow = 0; dow <= 6; dow++) {
          if (dow === 1) continue;
          await client.query(
            'INSERT INTO shifts (restaurant_id, name, day_of_week, start_time, end_time, last_seating_offset_minutes) VALUES ($1,$2,$3,$4,$5,$6),($1,$7,$3,$8,$9,$6)',
            [r.id, 'Comida', dow, '13:00', '16:00', 30, 'Cena', '20:00', '23:30']);
          await client.query(
            'INSERT INTO capacity_caps (restaurant_id, day_of_week, start_time, end_time, max_covers) VALUES ($1,$2,$3,$4,$5)',
            [r.id, dow, '00:00', '23:59', def.capPerDay]);
        }
        await client.query('COMMIT');
        console.log(`Creado "${def.name}" (id=${r.id}, ${def.tables.length} mesas, ${def.combinations.length} combinaciones).`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

module.exports = seedExtraRestaurants;

if (require.main === module) {
  seedExtraRestaurants()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}
