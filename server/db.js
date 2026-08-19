const { Pool } = require('pg');
const path = require('path');
// path explícito: si el proceso arranca con otro directorio de trabajo (p. ej.
// desde una herramienta de preview lanzada fuera de esta carpeta), dotenv no
// encontraría el .env basándose solo en cwd.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Supabase (Postgres) en vez de SQLite local: así los datos sobreviven a los
// despliegues en Render, que no tiene disco persistente en el plan gratuito.
// Se usa el "pooler de sesión" de Supabase (puerto 5432) — soporta prepared
// statements igual que una conexión normal, a diferencia del pooler de
// transacciones (6543), y funciona por IPv4 (Render no soporta IPv6 saliente).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Crea las tablas (si no existen) y aplica migraciones. Postgres soporta
// "ADD COLUMN IF NOT EXISTS" de forma nativa, así que las migraciones ya no
// necesitan comprobar antes qué columnas existen (a diferencia de SQLite).
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      phone TEXT,
      email TEXT,
      default_duration_minutes INTEGER NOT NULL DEFAULT 90,
      turnover_buffer_minutes INTEGER NOT NULL DEFAULT 15,
      slot_interval_minutes INTEGER NOT NULL DEFAULT 15,
      max_party_size INTEGER NOT NULL DEFAULT 20,
      max_advance_days INTEGER NOT NULL DEFAULT 90,
      min_advance_minutes INTEGER NOT NULL DEFAULT 0
    );

    -- Cupo agregado de comensales por franja horaria y día de la semana, además
    -- (no en sustitución) de la disponibilidad por mesa.
    CREATE TABLE IF NOT EXISTS capacity_caps (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      max_covers INTEGER NOT NULL
    );

    -- Un local puede tener varios planos de sala. Cada mesa y cada combinación
    -- pertenece a un plano concreto; qué plano aplica cada día se decide en
    -- floor_plan_schedule, sin borrar nunca mesas ya referenciadas por reservas.
    CREATE TABLE IF NOT EXISTS floor_plans (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS floor_plan_schedule (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
      date TEXT NOT NULL,
      floor_plan_id INTEGER NOT NULL REFERENCES floor_plans(id),
      UNIQUE(restaurant_id, date)
    );

    CREATE TABLE IF NOT EXISTS zones (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
      floor_plan_id INTEGER NOT NULL REFERENCES floor_plans(id),
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tables (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
      floor_plan_id INTEGER NOT NULL REFERENCES floor_plans(id),
      zone_id INTEGER REFERENCES zones(id),
      name TEXT NOT NULL,
      capacity_min INTEGER NOT NULL DEFAULT 1,
      capacity_max INTEGER NOT NULL,
      pos_x INTEGER,
      pos_y INTEGER,
      active INTEGER NOT NULL DEFAULT 1
    );

    -- Combinaciones de mesas explícitas (2 o más).
    CREATE TABLE IF NOT EXISTS table_combinations (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
      floor_plan_id INTEGER NOT NULL REFERENCES floor_plans(id),
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS table_combination_members (
      combination_id INTEGER NOT NULL REFERENCES table_combinations(id) ON DELETE CASCADE,
      table_id INTEGER NOT NULL REFERENCES tables(id),
      PRIMARY KEY (combination_id, table_id)
    );

    -- shifts define the service windows per day-of-week (0=Sunday..6=Saturday)
    CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
      name TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      last_seating_offset_minutes INTEGER NOT NULL DEFAULT 0
    );

    -- shift NULL = cierra el día entero; shift = 'Comida'/'Cena' cierra solo ese turno.
    CREATE TABLE IF NOT EXISTS closures (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
      date TEXT NOT NULL,
      shift TEXT,
      note TEXT
    );

    -- Excepción de horario para una fecha concreta (mismo turno, horas distintas a las
    -- de la plantilla semanal de "shifts") — igual que "Horario reservable → aplicar a
    -- Hoy/Entre dos fechas/Días específicos" en Cover. No es un cierre (eso sigue siendo
    -- "closures"): el turno sigue abierto, solo con otro horario ese día.
    CREATE TABLE IF NOT EXISTS shift_date_overrides (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
      date TEXT NOT NULL,
      shift_name TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      UNIQUE(restaurant_id, date, shift_name)
    );
    CREATE INDEX IF NOT EXISTS idx_shift_overrides_date ON shift_date_overrides(restaurant_id, date);

    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
      name TEXT,
      phone TEXT,
      email TEXT,
      visits INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      UNIQUE(restaurant_id, phone)
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
      customer_id INTEGER REFERENCES customers(id),
      customer_name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      party_size INTEGER NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed, seated, eating, dessert, paid, completed, cancelled, no_show
      source TEXT NOT NULL DEFAULT 'web', -- web, app, phone, admin
      notes TEXT,
      consent_accepted INTEGER NOT NULL DEFAULT 0, -- RGPD: consentimiento de tratamiento de datos (reservas web)
      created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      paid_at TEXT,
      survey_sent_at TEXT,
      cancelled_by TEXT
    );

    -- Almacén genérico clave/valor para secretos internos generados por la propia app.
    CREATE TABLE IF NOT EXISTS app_secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Respuestas a la encuesta de satisfacción del día después (una por reserva).
    CREATE TABLE IF NOT EXISTS survey_responses (
      id SERIAL PRIMARY KEY,
      reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      rating_general INTEGER NOT NULL,
      rating_comida INTEGER NOT NULL,
      rating_servicio INTEGER NOT NULL,
      comentario TEXT,
      created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(reservation_id)
    );

    -- Acceso al panel de personal (usuario/contraseña compartidos, no uno por persona).
    -- password_hash guarda "salt:hash" (scrypt), nunca la contraseña en claro.
    CREATE TABLE IF NOT EXISTS admin_credentials (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS reservation_tables (
      reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      table_id INTEGER NOT NULL REFERENCES tables(id),
      PRIMARY KEY (reservation_id, table_id)
    );

    CREATE INDEX IF NOT EXISTS idx_reservations_date ON reservations(restaurant_id, date);
    CREATE INDEX IF NOT EXISTS idx_reservation_tables_table ON reservation_tables(table_id);
    CREATE INDEX IF NOT EXISTS idx_capacity_caps_day ON capacity_caps(restaurant_id, day_of_week);
    CREATE INDEX IF NOT EXISTS idx_tables_floor_plan ON tables(floor_plan_id);
    CREATE INDEX IF NOT EXISTS idx_zones_floor_plan ON zones(floor_plan_id);
    CREATE INDEX IF NOT EXISTS idx_combinations_floor_plan ON table_combinations(floor_plan_id);
    CREATE INDEX IF NOT EXISTS idx_floor_plan_schedule_date ON floor_plan_schedule(restaurant_id, date);

    -- Migraciones: columnas añadidas después de la creación inicial de cada tabla.
    ALTER TABLE table_combinations ADD COLUMN IF NOT EXISTS capacity_min INTEGER;
    ALTER TABLE table_combinations ADD COLUMN IF NOT EXISTS capacity_max INTEGER;
    ALTER TABLE closures ADD COLUMN IF NOT EXISTS shift TEXT;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS paid_at TEXT;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS survey_sent_at TEXT;
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
  `);

  // Primer arranque: si no hay ninguna credencial de acceso al panel de personal,
  // se crea una por defecto (usuario/contraseña iniciales que el propio equipo puede
  // cambiar después desde el botón "Cambiar contraseña" del panel).
  const { rows: adminRows } = await pool.query('SELECT COUNT(*)::int AS count FROM admin_credentials');
  if (adminRows[0].count === 0) {
    const crypto = require('crypto');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync('123456', salt, 64).toString('hex');
    await pool.query('INSERT INTO admin_credentials (username, password_hash) VALUES ($1, $2)',
      ['ngarcia@gruposaona.com', `${salt}:${hash}`]);
  }

  // Secreto para firmar los enlaces de la encuesta de satisfacción — se genera solo una vez.
  const { rows: secretRows } = await pool.query("SELECT value FROM app_secrets WHERE key = 'survey_token_secret'");
  if (!secretRows.length) {
    const crypto = require('crypto');
    await pool.query('INSERT INTO app_secrets (key, value) VALUES ($1, $2)',
      ['survey_token_secret', crypto.randomBytes(32).toString('hex')]);
  }

  // Mantiene pos_x/pos_y de las mesas de Plaza España al día en cada arranque
  // (incluidos despliegues sobre una base de datos ya sembrada) sin tocar
  // reservas, combinaciones ni ningún otro dato.
  const { SALA_INTERIOR_POS, BARRA_POS } = require('./floorPositions');
  for (const [name, [x, y]] of Object.entries({ ...SALA_INTERIOR_POS, ...BARRA_POS })) {
    await pool.query('UPDATE tables SET pos_x = $1, pos_y = $2 WHERE name = $3', [x, y, name]);
  }
}

// Envuelve varias queries en una única transacción (BEGIN/COMMIT/ROLLBACK),
// equivalente a db.transaction() de better-sqlite3 pero async. `fn` recibe un
// cliente dedicado (con el mismo método .query) que hay que usar en vez del
// pool directamente, para que todas las queries corran en la misma conexión.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb, withTransaction, query: (text, params) => pool.query(text, params) };
