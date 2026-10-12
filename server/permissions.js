// Roles y permisos del panel de personal.
//
// Los roles son fijos (definidos aquí, no en la base de datos): cada usuario tiene un
// rol y una lista de locales asignados (tabla user_restaurants). El Administrador ve
// todos los locales aunque no tenga ninguno asignado.
//
// Permisos:
//   reservations       Ver el panel de reservas y el plano; crear, sentar, mover, cancelar,
//                      marcar no-show. Incluye ver (no editar) horarios y planos, que el
//                      panel necesita para pintarse.
//   closures           Cierres puntuales (día o turno) y excepciones de horario por fecha.
//   schedule           Horario semanal de cada turno y plano de sala por turno.
//   floorplans         Planos de sala, zonas, mesas, combinaciones y agenda de planos.
//   reports            Informes de reservas y ocupación.
//   reports_customers  Informes con datos de clientes (listado, mejores clientes, origen).
//   surveys            Respuestas de la encuesta de satisfacción.
//   users              Usuarios del panel y claves de la API de integración.

const PERMISSIONS = {
  reservations: 'Reservas: ver, crear, sentar, mover, cancelar y no-show',
  closures: 'Cierres puntuales y excepciones de horario',
  schedule: 'Horario semanal y plano por turno',
  floorplans: 'Planos de sala, mesas y combinaciones',
  reports: 'Informes de reservas y ocupación',
  reports_customers: 'Informes con datos de clientes',
  surveys: 'Encuestas de satisfacción',
  users: 'Usuarios y claves de la API',
};

const ROLES = {
  admin: {
    label: 'Administrador',
    description: 'Todo, en todos los locales. Gestiona usuarios y claves de la API.',
    allRestaurants: true,
    permissions: Object.keys(PERMISSIONS),
  },
  operaciones: {
    label: 'Operaciones',
    description: 'Todo salvo usuarios y API, en los locales asignados.',
    permissions: ['reservations', 'closures', 'schedule', 'floorplans', 'reports', 'reports_customers', 'surveys'],
  },
  franquiciado: {
    label: 'Franquiciado',
    description: 'Reservas, cierres, informes (con clientes) y encuestas de sus locales. No cambia horario semanal, cupos ni planos.',
    permissions: ['reservations', 'closures', 'reports', 'reports_customers', 'surveys'],
  },
  encargado: {
    label: 'Encargado',
    description: 'Reservas, cierres, informes (sin datos de clientes) y encuestas de su local.',
    permissions: ['reservations', 'closures', 'reports', 'surveys'],
  },
  sala: {
    label: 'Sala',
    description: 'Solo el panel de reservas de su local.',
    permissions: ['reservations'],
  },
};

function roleOf(user) { return ROLES[user && user.role] || null; }

function hasPermission(user, perm) {
  const role = roleOf(user);
  return !!role && role.permissions.includes(perm);
}

// null = todos los locales.
function allowedRestaurantIds(user) {
  const role = roleOf(user);
  if (!role) return [];
  if (role.allRestaurants) return null;
  return user.restaurantIds || [];
}

function canAccessRestaurant(user, restaurantId) {
  const ids = allowedRestaurantIds(user);
  return ids === null || ids.includes(Number(restaurantId));
}

module.exports = { PERMISSIONS, ROLES, roleOf, hasPermission, allowedRestaurantIds, canAccessRestaurant };
