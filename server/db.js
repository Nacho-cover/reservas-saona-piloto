const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'reservas.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
-- (no en sustitución) de la disponibilidad por mesa. Replica el control de
-- aforo por tramo horario que ya usa el grupo en CoverManager: un mismo
-- turno puede tener límites distintos según el tramo (p. ej. sábado a las
-- 16:00-16:45 el aforo baja a 15 comensales aunque haya mesas libres).
CREATE TABLE IF NOT EXISTS capacity_caps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  day_of_week INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  max_covers INTEGER NOT NULL
);

-- Un local puede tener varios planos de sala (p. ej. "Plano estándar" y "Plano evento
-- sábado noche" con la terraza reorganizada). Cada mesa y cada combinación pertenece a
-- un plano concreto. Los planos nunca se "activan" borrando datos: qué plano aplica cada
-- día se decide en floor_plan_schedule, y las mesas/combinaciones de planos no vigentes
-- simplemente dejan de ofrecerse para NUEVAS reservas — nunca se tocan las mesas ya
-- referenciadas por reservas existentes (reservation_tables apunta siempre al table_id
-- original), así que cambiar de plano no afecta a reservas ya realizadas.
CREATE TABLE IF NOT EXISTS floor_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);

-- Qué plano aplica cada día concreto (agenda). Si un día no tiene fila aquí, se usa el
-- plano marcado is_default=1 del local. Cambiar esta agenda para un día futuro (o incluso
-- pasado) NO modifica ni borra las mesas de reservas ya creadas para esa fecha.
CREATE TABLE IF NOT EXISTS floor_plan_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  date TEXT NOT NULL,
  floor_plan_id INTEGER NOT NULL REFERENCES floor_plans(id),
  UNIQUE(restaurant_id, date)
);

-- Zonas dentro de un plano (p. ej. "Sala Interior", "Terraza", "Barra"), igual que las
-- pestañas de zona del panel de mesas de CoverManager.
CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  floor_plan_id INTEGER NOT NULL REFERENCES floor_plans(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

-- Combinaciones de mesas explícitas (2 o más), como la pestaña "Combinación de mesas" de
-- CoverManager — sustituye el antiguo esquema de "grupo combinable" limitado a parejas.
CREATE TABLE IF NOT EXISTS table_combinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL,
  day_of_week INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  last_seating_offset_minutes INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS closures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  date TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  name TEXT,
  phone TEXT,
  email TEXT,
  visits INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE(restaurant_id, phone)
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  customer_id INTEGER REFERENCES customers(id),
  customer_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  party_size INTEGER NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed, seated, completed, cancelled, no_show
  source TEXT NOT NULL DEFAULT 'web', -- web, app, phone, admin
  notes TEXT,
  consent_accepted INTEGER NOT NULL DEFAULT 0, -- RGPD: consentimiento de tratamiento de datos (reservas web)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Acceso al panel de personal (usuario/contraseña compartidos, no uno por persona).
-- password_hash guarda "salt:hash" (scrypt), nunca la contraseña en claro.
CREATE TABLE IF NOT EXISTS admin_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
`);

// Migración: Cover permite fijar a mano el aforo min/max de una combinación en vez de
// que sea siempre la suma automática de las mesas que la forman (p. ej. dos mesas de
// 2 personas combinadas pueden dar servicio a 6, no a 4, por las sillas de esquina que
// se añaden) — columnas nullable: NULL = se sigue calculando como la suma (comportamiento
// anterior, sin romper combinaciones ya creadas).
const comboCols = db.prepare("PRAGMA table_info(table_combinations)").all().map(c => c.name);
if (!comboCols.includes('capacity_min')) db.exec('ALTER TABLE table_combinations ADD COLUMN capacity_min INTEGER');
if (!comboCols.includes('capacity_max')) db.exec('ALTER TABLE table_combinations ADD COLUMN capacity_max INTEGER');

// Primer arranque: si no hay ninguna credencial de acceso al panel de personal,
// se crea una por defecto (usuario/contraseña iniciales que el propio equipo puede
// cambiar después desde el botón "Cambiar contraseña" del panel).
const { count: adminCount } = db.prepare('SELECT COUNT(*) AS count FROM admin_credentials').get();
if (adminCount === 0) {
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('123456', salt, 64).toString('hex');
  db.prepare('INSERT INTO admin_credentials (username, password_hash) VALUES (?, ?)')
    .run('ngarcia@gruposaona.com', `${salt}:${hash}`);
}

module.exports = db;
