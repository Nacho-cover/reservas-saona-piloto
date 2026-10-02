const { pool } = require('./db');
const seedExtraRestaurants = require('./seedExtraRestaurants');

// Migración de sustitución para cuando seedExtraRestaurants.js ya se llegó a
// ejecutar con la primera versión de datos INVENTADOS (locales de ejemplo
// "Saona Balboa" con dirección/mesas ficticias, y "Saona Bilbao" con nombre
// inventado) — los sustituye por los datos REALES capturados de Cover el
// 2026-09-16 (ver claude/referencia-configuracion-cover.md en el proyecto).
//
// Es idempotente y segura de volver a ejecutar:
//   - "Saona Balboa": si su dirección coincide con la de ejemplo antigua, se
//     borra ese restaurante COMPLETO (planos, zonas, mesas, turnos, cupos,
//     combinaciones — nunca otros restaurantes) y se vuelve a sembrar con
//     seedExtraRestaurants(). Si ya tiene la dirección real, no se toca.
//   - "Saona Bilbao" (nombre inventado): se borra siempre que exista — el
//     real se llama "Saona Bilbao Henao" (nombre distinto, así que
//     seedExtraRestaurants() lo crea aparte sin conflicto de nombres).
//   - ANTES de borrar cualquier restaurante, comprueba si tiene reservas o
//     clientes reales. Si los tiene, NO se borra — se avisa por consola y se
//     deja para revisión manual, por si alguien llegó a probar el piloto de
//     verdad contra ese local de ejemplo.
//   - Si ninguno de los dos nombres antiguos existe (porque nunca se
//     ejecutó el seed antiguo, o porque ya se migró antes), esta migración
//     no borra nada y simplemente llama a seedExtraRestaurants(), que a su
//     vez se salta los locales que ya tengan los nombres reales.

const OLD_BALBOA_ADDRESS = 'Calle de Alcalá, 130, 28009 Madrid';
const OLD_BILBAO_NAME = 'Saona Bilbao';

async function findStaleExampleRestaurants(client) {
  const stale = [];

  const balboa = await client.query('SELECT id, address FROM restaurants WHERE name = $1', ['Saona Balboa']);
  if (balboa.rows.length) {
    const { id, address } = balboa.rows[0];
    if (address === OLD_BALBOA_ADDRESS) {
      stale.push({ id, name: 'Saona Balboa', reason: 'dirección de ejemplo antigua detectada' });
    } else {
      console.log('"Saona Balboa" ya tiene datos reales (la dirección no coincide con la de ejemplo) — no se toca.');
    }
  }

  const bilbao = await client.query('SELECT id FROM restaurants WHERE name = $1', [OLD_BILBAO_NAME]);
  if (bilbao.rows.length) {
    stale.push({ id: bilbao.rows[0].id, name: OLD_BILBAO_NAME, reason: 'nombre inventado — el real es "Saona Bilbao Henao"' });
  }

  return stale;
}

async function isSafeToDelete(client, restaurantId) {
  const { rows } = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM reservations WHERE restaurant_id = $1)::int AS reservations,
       (SELECT COUNT(*) FROM customers WHERE restaurant_id = $1)::int AS customers`,
    [restaurantId]
  );
  return rows[0].reservations === 0 && rows[0].customers === 0;
}

// Borra un restaurante y todo lo que cuelga de él, en el orden que exigen
// las claves foráneas (ninguna tiene ON DELETE CASCADE hacia restaurants,
// así que hay que hacerlo a mano tabla por tabla, nunca con un DELETE FROM
// restaurants a secas). table_combination_members y reservation_tables/
// survey_responses sí cascadean solos al borrar table_combinations /
// reservations respectivamente.
async function deleteRestaurantCascade(client, restaurantId) {
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM reservations WHERE restaurant_id = $1', [restaurantId]);
    await client.query('DELETE FROM customers WHERE restaurant_id = $1', [restaurantId]);
    await client.query('DELETE FROM closures WHERE restaurant_id = $1', [restaurantId]);
    await client.query('DELETE FROM shift_date_overrides WHERE restaurant_id = $1', [restaurantId]);
    await client.query('DELETE FROM capacity_caps WHERE restaurant_id = $1', [restaurantId]);
    await client.query('DELETE FROM shifts WHERE restaurant_id = $1', [restaurantId]);
    await client.query('DELETE FROM table_combinations WHERE restaurant_id = $1', [restaurantId]);
    await client.query('DELETE FROM tables WHERE restaurant_id = $1', [restaurantId]);
    await client.query('DELETE FROM zones WHERE restaurant_id = $1', [restaurantId]);
    await client.query('DELETE FROM floor_plan_schedule WHERE restaurant_id = $1', [restaurantId]);
    await client.query('DELETE FROM floor_plans WHERE restaurant_id = $1', [restaurantId]);
    await client.query('DELETE FROM restaurants WHERE id = $1', [restaurantId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function migrateRealRestaurantData() {
  const client = await pool.connect();
  try {
    const stale = await findStaleExampleRestaurants(client);
    for (const { id, name, reason } of stale) {
      if (!(await isSafeToDelete(client, id))) {
        console.log(`⚠️  "${name}" (id=${id}) tiene reservas o clientes reales — NO se borra automáticamente. Revísalo a mano antes de volver a sembrar.`);
        continue;
      }
      console.log(`Borrando "${name}" (id=${id}) — ${reason}...`);
      await deleteRestaurantCascade(client, id);
      console.log(`  ...borrado.`);
    }
  } finally {
    client.release();
  }

  console.log('Sembrando datos reales de Saona Balboa y Saona Bilbao Henao...');
  await seedExtraRestaurants();
}

module.exports = migrateRealRestaurantData;

if (require.main === module) {
  migrateRealRestaurantData()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}
