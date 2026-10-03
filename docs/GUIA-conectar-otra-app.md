# Guía rápida: conectar otra aplicación a los planos de sala

Para quien vaya a cablear otra app con los locales y planos de Grupo Saona.
Documentación técnica completa: https://reservas-saona-piloto.onrender.com/api/v1/docs

## 1. Lo que hace falta

- **Dirección base:** `https://reservas-saona-piloto.onrender.com/api/v1`
- **Clave de acceso:** se envía en cada petición en la cabecera `X-API-Key: <clave>`
  (también vale `Authorization: Bearer <clave>`).
- Todo es **solo lectura** y en **JSON**.

## 2. Conseguir una clave (desde el panel)

1. Entrar en el panel → **Configuración de sala**
   (https://reservas-saona-piloto.onrender.com/admin/config.html).
2. Bajar hasta **Integración (API)** → **Claves de acceso**.
3. Escribir un nombre (la app que la va a usar) y pulsar **Crear clave**.
4. La clave completa se muestra **una sola vez**: copiarla y guardarla en un gestor de contraseñas.
   Después el panel solo enseña su principio, el nombre y las fechas de creación y último uso.
5. Si se pierde o deja de hacer falta: **Revocar** y crear otra. Deja de funcionar en menos de 1 minuto.

Recomendación: una clave por aplicación.

## 3. Qué se puede pedir

| Para qué | Dirección (tras la base) |
|---|---|
| Lista de locales | `/restaurants` |
| Un local con su plano principal | `/restaurants/{id}` |
| Un local con todos sus planos | `/restaurants/{id}?plans=all` |
| El plano que aplica un día | `/restaurants/{id}?date=2026-10-10` |
| Todos los planos de un local | `/restaurants/{id}/floor-plans` |
| Un plano concreto | `/floor-plans/{id}` |
| Todo de golpe (sincronización diaria, ~2,8 MB) | `/export?plans=all` |

En **Integración (API)** las direcciones salen ya completas para el local/plano elegido arriba,
con botones **Copiar** y **Probar** (Probar muestra en pantalla lo que recibiría la otra app).

## 4. Ejemplo

```bash
curl -H "X-API-Key: $CLAVE" https://reservas-saona-piloto.onrender.com/api/v1/restaurants
```

```js
const res = await fetch('https://reservas-saona-piloto.onrender.com/api/v1/export?plans=all', {
  headers: { 'X-API-Key': process.env.SAONA_API_KEY },
});
const datos = await res.json();
```

## 5. A tener en cuenta

- El servidor está en el plan gratuito de Render: tras un rato sin uso, la primera llamada puede
  tardar 30-50 s. La otra app debe esperar al menos 60 s antes de darla por fallida.
- Errores: `401` sin clave o clave incorrecta · `404` local o plano inexistente · `400` parámetro inválido.
- Para cruzar datos con otra app es más robusto usar local + nombre del plano + nombre de la mesa que los `id`.
- La clave **nunca** se pone en código público ni en GitHub (el repositorio es público).
