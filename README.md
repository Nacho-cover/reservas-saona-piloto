# Sistema de reservas — Prototipo (local piloto)

Prototipo funcional de un sistema de reservas de mesa: web de cliente (responsive, instalable como app),
panel de gestión para el local (staff) y motor de disponibilidad que respeta franjas horarias, aforo de
mesas y tiempo medio de comida. Pensado para validarse en **un local piloto** antes de escalarlo a toda
la red de franquiciados.

## Qué incluye este prototipo

- **Reserva online (web/app)**: `public/index.html` — flujo cliente: fecha → comensales → hora disponible
  → **elegir mesa en el plano real** → datos de contacto → confirmación. Es una web responsive con
  manifest PWA (`manifest.json` + `sw.js`), así que un cliente puede "instalarla" en el móvil como si
  fuera una app nativa, sin necesidad todavía de publicar nada en las tiendas de apps.
- **Selector visual de mesa**: tras elegir hora, el cliente ve el plano de sala real del local (por
  zonas: Salón/Terraza, con pestañas) y toca la mesa que quiere — no es una maqueta, es el plano de
  `admin/config.html` con la disponibilidad real de ese momento: mesas ocupadas en gris, mesas que no
  llegan al número de comensales atenuadas (con un icono 🔗 si se pueden combinar con otra libre para sí
  llegar), y mesas libres seleccionables. Al confirmar la reserva, esa mesa se re-valida por si alguien
  se adelantó, y solo entonces se guarda — así que lo que el cliente ve y lo que se reserva es siempre lo
  mismo. `server/availability.js` → `getTableMap()` / `validateChosenTables()`, endpoint
  `GET /api/table-map`.
- **Panel de gestión (staff)**: `public/admin/index.html` — vista del día por turnos (comida/cena), con
  todas las reservas (web y teléfono), botón para dar de alta una reserva telefónica manualmente, y
  acciones para sentar/completar/cancelar.
- **Planos de sala, zonas y combinaciones** (`public/admin/config.html`): un mismo local puede tener
  varios planos de sala (p. ej. "Plano estándar" y "Plano evento" con la terraza reorganizada), cada uno
  con sus propias zonas, mesas y combinaciones de mesas — igual que "Plantas/Zonas", "Mesas" y
  "Combinación de mesas" en CoverManager. Un nuevo plano se puede crear vacío o clonando otro existente
  como punto de partida. Las combinaciones ya no están limitadas a parejas de mesas: se puede unir
  cualquier número de mesas de un mismo plano (p. ej. 3 mesas para un grupo de 18).
- **Agenda de planos por día**: qué plano está activo se puede fijar por fecha concreta (tabla
  `floor_plan_schedule`); si un día no tiene nada asignado, se usa el plano marcado "por defecto". Cambiar
  el plano asignado a una fecha — incluso una que ya tiene reservas — **nunca modifica esas reservas**:
  cada reserva guarda directamente las mesas físicas que se le asignaron en su momento, no una referencia
  al plano, así que solo cambia qué mesas se ofrecen para reservas *nuevas* a partir de ese cambio.
- **Motor de disponibilidad** (`server/availability.js`): calcula huecos según los turnos configurados,
  la duración media de la comida, un buffer de limpieza entre reservas, y expone la disponibilidad
  mesa-por-mesa dentro del plano activo ese día. El cliente web elige su mesa directamente en el plano;
  las reservas telefónicas dadas de alta por el personal (que no pasan por el plano visual) siguen
  asignándose automáticamente a la mesa más ajustada, o a una combinación, igual que antes.
- **Cupo de aforo por franja horaria**: además de la disponibilidad por mesa, se puede limitar el número
  agregado de comensales por tramo horario y día de la semana (tabla `capacity_caps`), replicando el
  control que el grupo ya usa en CoverManager — por ejemplo, restringir el aforo de las 16:00 a las 16:45
  aunque queden mesas libres. Si no se configura ningún cupo para un día, solo aplica el límite por mesa.
- **Ventana de reserva y RGPD**: antelación máxima/mínima configurable por local (por defecto 90 días
  máx., sin mínimo — igual que la configuración real vista en Cover), y checkbox de consentimiento de
  tratamiento de datos obligatorio para reservas hechas por el cliente (web/app); el personal puede seguir
  anotando reservas telefónicas fuera de esa ventana.
- **API REST** (`server/index.js`) y base de datos SQLite (`server/db.js`) — sin dependencias externas de
  pago, fácil de ejecutar en local.
- **"Teléfono"**: en este prototipo, las llamadas se gestionan por el personal del local, que da de alta
  la reserva en el panel de staff (botón "Nueva reserva (teléfono)"). No hay todavía integración con
  centralita/IVR — ver roadmap más abajo.

## Cómo ejecutarlo

```bash
npm install
npm run seed     # crea el local piloto de ejemplo, sus mesas y turnos
npm start        # arranca el servidor en http://localhost:3000
```

- Web de reserva del cliente: `http://localhost:3000/`
- Panel del local (staff): `http://localhost:3000/admin/`
- Configuración de sala (planos, zonas, mesas, combinaciones, agenda): `http://localhost:3000/admin/config.html`
  (enlace "Configuración de sala" desde el panel de staff)

El local de ejemplo ("Saona Piloto - Calle Mayor") tiene dos planos de sala: "Plano estándar" (por
defecto, 9 mesas en salón y terraza) y "Plano evento" (la terraza reorganizada en 3 mesas grandes,
programado para el 2026-08-22 como ejemplo de agenda). Turnos de comida (13:00–16:00) y cena
(20:00–23:30) de martes a domingo (lunes cerrado), reservas de 75 minutos y 15 minutos de buffer de
limpieza entre mesas, y un cupo de aforo por franja horaria de ejemplo (el patrón más granular está en
sábado). Estos valores replican la configuración real observada en CoverManager para el grupo. Todo esto
es configurable desde el panel de configuración de sala, en `server/seed.js`, o directamente en las
tablas `restaurants`, `floor_plans`, `tables`, `shifts` y `capacity_caps` de la base de datos.

## Modelo de datos (resumen)

- `restaurants` — un local: duración media de comida, buffer de limpieza, intervalo de franjas, aforo
  máximo por reserva, antelación máxima/mínima de reserva.
- `floor_plans` — planos de sala de un local (p. ej. "Plano estándar", "Plano evento"); uno marcado
  `is_default`.
- `floor_plan_schedule` — qué plano aplica en una fecha concreta (una fila por local+fecha con plano
  distinto al de por defecto); resuelto en `availability.js` → `resolveFloorPlanId()`.
- `zones` — zonas dentro de un plano (Salón, Terraza…).
- `tables` — mesas de un plano, con capacidad mínima/máxima y zona opcional. Las mesas nunca se borran
  físicamente (`active = 0`), para no romper la referencia de reservas ya hechas con esa mesa.
- `table_combinations` / `table_combination_members` — combinaciones de mesas de un mismo plano que se
  pueden unir para grupos grandes; sin límite de número de mesas por combinación.
- `shifts` — turnos de servicio por día de la semana (comida/cena, horario, corte de última entrada).
- `capacity_caps` — cupo máximo de comensales agregados por franja horaria y día de la semana, indepen-
  diente de la disponibilidad por mesa.
- `closures` — días cerrados (festivos, vacaciones) además del cierre semanal.
- `reservations` / `reservation_tables` — la reserva y las mesas físicas asignadas (una o varias si se
  combinan); **la reserva guarda mesas concretas, nunca un plano**, así que cambiar qué plano aplica una
  fecha no afecta a las reservas ya hechas en ella. Incluye `consent_accepted` para dejar constancia del
  consentimiento RGPD en reservas web/app.
- `customers` — ficha básica por teléfono, con contador de visitas (base para un futuro CRM/fidelización).

## Qué falta para llevarlo a producción real

Este es un prototipo para validar el flujo y el modelo de datos con un local piloto, no un sistema listo
para producción. Próximos pasos recomendados, por fases:

**Fase 1 — Reforzar el piloto**
- Autenticación en el panel de staff (hoy es de acceso libre).
- Notificaciones de confirmación/recordatorio por SMS o WhatsApp (p. ej. Twilio) y email.
- Política de cancelación / no-show con posible solicitud de tarjeta para grupos grandes (Cover permite
  solo devoluciones totales, no parciales — decidir si el sistema propio mantiene esa misma regla).
- Textos legales de consentimiento en varios idiomas (Cover tiene 13 configurados) — el prototipo hoy
  solo tiene el texto en español.
- Panel de configuración de turnos y cupos de aforo sin tocar la base de datos directamente (planos de
  sala, zonas, mesas y combinaciones ya tienen panel propio en `admin/config.html`; falta el mismo
  tratamiento para turnos y cupos).
- Editor visual del plano (arrastrar mesas sobre un plano gráfico, como en CoverManager) — hoy la
  posición de cada mesa se gestiona por lista, no visualmente; las columnas `pos_x`/`pos_y` ya existen en
  la base de datos para cuando se aborde esto.

**Fase 2 — App nativa real**
- Este prototipo es una web instalable (PWA), suficiente para validar el flujo, pero no aparece en App
  Store / Google Play ni tiene push notifications nativas. Si el piloto funciona, siguiente paso natural:
  React Native o Flutter reutilizando la misma API.

**Fase 3 — Canal telefónico real**
- Hoy el "teléfono" lo resuelve el personal a mano en el panel. Para automatizarlo: integración con una
  centralita/IVR (p. ej. Twilio Voice, Aircall) que ofrezca disponibilidad por voz o derive a un agente,
  y cree la reserva en este mismo sistema vía API.

**Fase 4 — Multi-local / red de franquiciados**
- El modelo de datos ya soporta múltiples `restaurants`, pero falta: selector de local en la web/app,
  panel de administración central para la matriz (ver todos los locales, comparar ocupación), roles y
  permisos por franquiciado, y informes agregados. Con 68 locales activos hoy y objetivo de 100, esta fase
  deja de ser un "extra" y pasa a ser el núcleo del proyecto si se decide seguir con desarrollo propio —
  ver la comparativa build vs. buy para el análisis de coste a esa escala, incluida la migración de datos
  desde CoverManager.

**Fase 5 — Alternativa build vs. buy**
- Antes de invertir en desarrollo propio a gran escala, vale la pena comparar con plataformas ya
  existentes en el sector (Covermanager, TheFork Manager, ResOS, etc.) en coste, funcionalidades y
  velocidad de despliegue frente a build propio. Puedo preparar esa comparativa si es útil.

## Estructura del proyecto

```
reservas-app/
├── server/
│   ├── db.js            # esquema SQLite
│   ├── availability.js  # motor de disponibilidad y asignación de mesas
│   ├── index.js         # API REST (Express)
│   └── seed.js           # datos de ejemplo del local piloto
├── public/
│   ├── index.html/.css/.js   # web de reserva para clientes (+ PWA)
│   └── admin/
│       ├── index.html/.css/.js    # panel de gestión de reservas del local
│       └── config.html/.css/.js   # panel de planos de sala, zonas, mesas, combinaciones y agenda
└── data/                 # base de datos SQLite (se genera al arrancar)
```
