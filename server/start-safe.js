// Arranque seguro para producción/hosting: siembra el local piloto SOLO si la
// base de datos está vacía (primer arranque). En arranques posteriores
// (redeploys, reinicios del servicio) NO vuelve a sembrar, así que las
// reservas reales hechas por clientes no se pierden nunca.
const db = require('./db');

const { count } = db.prepare('SELECT COUNT(*) AS count FROM restaurants').get();

if (count === 0) {
  console.log('Base de datos vacía: sembrando local piloto de ejemplo...');
  require('./seed');
} else {
  console.log(`Base de datos ya inicializada (${count} local/es). No se resiembra.`);
}

require('./index');
