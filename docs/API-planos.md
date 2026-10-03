# API de planos de sala (v1) — Grupo Saona

API de **solo lectura** para que otra aplicación lea los locales y sus planos de sala
(zonas, mesas, aforos, posiciones y combinaciones) sin tener que exportar PDFs.

- **URL base:** `https://reservas-saona-piloto.onrender.com/api/v1`
- **Formato:** JSON (UTF-8). Nombres de campo en inglés y `camelCase`.
- **Autenticación:** cabecera `X-API-Key: <clave>` (también vale `Authorization: Bearer <clave>`).
  Sin clave o con una clave incorrecta → `401`.
- **Solo lectura:** ningún endpoint modifica datos.
- El servidor está en el plan gratuito de Render: si lleva un rato sin uso, la primera
  llamada puede tardar ~30-50 s en responder mientras arranca.

## Endpoints

| Método y ruta | Qué devuelve |
|---|---|
| `GET /api/v1` | Índice de la API (público, sin datos). |
| `GET /api/v1/restaurants` | Todos los locales con el resumen de sus planos (sin mesas). |
| `GET /api/v1/restaurants/{id}` | Un local con su plano por defecto completo. |
| `GET /api/v1/restaurants/{id}?plans=all` | Un local con **todos** sus planos completos. |
| `GET /api/v1/restaurants/{id}?date=2026-10-10` | Un local con el plano que aplica ese día (agenda de planos) e indica `activeFloorPlanId`. |
| `GET /api/v1/restaurants/{id}/floor-plans` | Todos los planos completos de un local. |
| `GET /api/v1/floor-plans/{id}` | Un plano concreto completo. |
| `GET /api/v1/export` | Volcado de los 69 locales con su plano por defecto (~0,8 MB). |
| `GET /api/v1/export?plans=all` | Volcado de los 69 locales con todos sus planos (~2,8 MB). Pensado para una sincronización diaria. |

Parámetro opcional en los endpoints con mesas: `includeInactive=1` incluye también las mesas
desactivadas (por ejemplo, las que en Cover tienen aforo 0). Por defecto solo salen las activas.

## Estructura de un plano

```json
{
  "id": 5,
  "restaurantId": 4,
  "name": "Saona Actur OP",
  "isDefault": true,
  "coordinateSystem": { "unit": "percent", "origin": "top-left", "reference": "table-center" },
  "totals": { "zones": 4, "tables": 60, "seatsMax": 201, "combinations": 12 },
  "zones": [ { "id": 11, "name": "Sala interior", "order": 1 } ],
  "tables": [
    {
      "id": 54, "name": "1", "zoneId": 11, "zoneName": "Sala interior",
      "capacityMin": 2, "capacityMax": 4,
      "position": { "x": 22, "y": 14 },
      "active": true
    }
  ],
  "combinations": [
    {
      "id": 48, "name": "14+15", "capacityMin": 4, "capacityMax": 5,
      "capacityMaxIsExplicit": true,
      "tableIds": [67, 68], "tableNames": ["14", "15"]
    }
  ]
}
```

- `position`: centro de la mesa en **% del lienzo** (0-100 en cada eje, origen arriba a la
  izquierda), igual que el editor visual de la app. Puede ser `null` si la mesa no tiene posición.
- `capacityMaxIsExplicit`: `true` si el aforo máximo de la combinación viene fijado (como en
  Cover); `false` si se calcula sumando el máximo de cada mesa.
- Los `id` son estables mientras no se borre/recree el plano o la mesa; para cruzar con otra app
  es más robusto usar `restaurantId` + nombre del plano + `name` de la mesa.

## Local (`/restaurants/{id}`)

```json
{
  "id": 2, "name": "Saona Balboa",
  "address": "C. del Gral. Oráa, 38, 28006 Madrid", "phone": "+34 911 982 057", "email": "reservas@gruposaona.com",
  "settings": { "serviceDurationMinutes": 75, "turnoverBufferMinutes": 15, "slotIntervalMinutes": 15,
                "maxPartySize": 20, "maxAdvanceDays": 90, "minAdvanceMinutes": 0 },
  "floorPlans": [ { "...": "plano completo, ver arriba" } ]
}
```

## Ejemplos

```bash
curl -H "X-API-Key: $CLAVE" https://reservas-saona-piloto.onrender.com/api/v1/restaurants
curl -H "X-API-Key: $CLAVE" "https://reservas-saona-piloto.onrender.com/api/v1/restaurants/2?plans=all"
```

```js
const res = await fetch('https://reservas-saona-piloto.onrender.com/api/v1/export?plans=all', {
  headers: { 'X-API-Key': process.env.SAONA_API_KEY },
});
const { restaurants } = await res.json();
```

## Gestión de claves

Las claves no se guardan en claro: en la tabla `app_secrets` hay una fila por clave con
`key = 'api_key:<etiqueta>'` y `value = sha256(clave)` en hexadecimal. Así cada app puede tener
su propia clave.

- **Crear una clave:** generar un valor aleatorio largo y guardar su hash:
  `INSERT INTO app_secrets (key, value) VALUES ('api_key:nombre-app', encode(sha256('LA_CLAVE'::bytea), 'hex'));`
- **Revocar una clave:** `DELETE FROM app_secrets WHERE key = 'api_key:nombre-app';`
  (deja de funcionar en menos de 1 minuto, sin redesplegar).

Errores: `400` parámetro inválido · `401` sin clave o clave incorrecta · `404` local o plano
inexistente · `500` error interno. Siempre con cuerpo `{ "error": "..." }`.
