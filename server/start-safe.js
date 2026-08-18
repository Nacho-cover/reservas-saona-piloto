// Arranque seguro para producción/hosting: crea las tablas si no existen y
// siembra el local piloto SOLO si la base de datos está vacía (primer arranque).
// En arranques posteriores (redeploys, reinicios del servicio) NO vuelve a
// sembrar, así que las reservas reales hechas por clientes no se pierden nunca.
const { pool, initDb } = require('./db');

async function main() {
  await initDb();

  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM restaurants');
  if (rows[0].count === 0) {
    console.log('Base de datos vacía: sembrando local piloto de ejemplo...');
    const seed = require('./seed');
    await seed();
  } else {
    console.log(`Base de datos ya inicializada (${rows[0].count} local/es). No se resiembra.`);
  }

  require('./index');
}

main().catch(err => {
  console.error('Error al arrancar:', err);
  process.exit(1);
});
