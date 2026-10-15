# Avisos por WhatsApp — puesta en marcha

La app manda dos avisos por WhatsApp (con email de respaldo mientras WhatsApp no esté
configurado o si un envío falla):

1. **Recordatorio el día antes** (cada día a las ~18:00, GitHub Actions `reminders.yml`).
2. **Mesa libre de la lista de espera** (al cancelarse una reserva y cada 10 min, `waitlist-tick.yml`).

## 1. Alta en Meta (lo hace Grupo Saona)

1. Meta Business Suite → verificar la empresa (Grupo Saona).
2. developers.facebook.com → crear app de tipo *Business* → añadir **WhatsApp**.
3. Registrar el número que enviará los avisos (no puede estar en uso en la app de WhatsApp normal).
4. Crear un **usuario del sistema** con permiso `whatsapp_business_messaging` y generar un **token permanente**.
5. Anotar el **Phone number ID** del número.

## 2. Plantillas a enviar a aprobación

Categoría **Utilidad**, idioma **Español (es_ES)**. Los nombres deben ser exactamente estos
(o cambiar las variables `WHATSAPP_TEMPLATE_*`). El número de variables debe coincidir.

### `saona_recordatorio_reserva`

Cuerpo:

> Hola {{1}}, te recordamos tu reserva en {{2}} el {{3}} a las {{4}} para {{5}} personas. ¿Vienes? Confírmalo o cancela desde el botón para que otra persona pueda disfrutar de la mesa si no puedes venir.

Ejemplos para la revisión: {{1}} Ana · {{2}} Saona Balboa · {{3}} viernes, 23 de octubre · {{4}} 21:00 · {{5}} 4

Botón: **Visitar sitio web** · texto «Confirmar o cancelar» · URL **dinámica**:
`https://reservas-saona-piloto.onrender.com/r/{{1}}` (ejemplo: `123-0123456789abcdef0123456789abcdef`)

### `saona_lista_espera_mesa`

Cuerpo:

> Hola {{1}}, ¡se ha liberado una mesa en {{2}}! {{3}} a las {{4}} para {{5}} personas. Tienes {{6}} minutos para confirmarla desde el botón; después se ofrecerá a la siguiente persona de la lista de espera.

Ejemplos: {{1}} Ana · {{2}} Saona Balboa · {{3}} viernes, 23 de octubre · {{4}} 21:15 · {{5}} 2 · {{6}} 15

Botón: **Visitar sitio web** · texto «Confirmar la mesa» · URL **dinámica**:
`https://reservas-saona-piloto.onrender.com/l/{{1}}`

> Si algún día cambia el dominio de la web, hay que volver a aprobar las plantillas con la URL nueva.

## 3. Variables en Render

| Variable | Valor |
|---|---|
| `WHATSAPP_TOKEN` | token permanente del usuario del sistema |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone number ID |
| `WHATSAPP_API_VERSION` | opcional (por defecto `v22.0`) |
| `WHATSAPP_LANG` | opcional (por defecto `es_ES`) |
| `WAITLIST_OFFER_MINUTES` | opcional, minutos para confirmar la mesa ofrecida (por defecto 15) |

Sin `WHATSAPP_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID`, todos los avisos salen por email (si el
cliente lo dejó). El panel indica en cada aviso por qué canal salió.

## 4. Consentimiento

La web pide aceptar el aviso por WhatsApp o email al apuntarse a la lista de espera. Para el
recordatorio de las reservas, conviene que legal revise el texto de consentimiento de la web.
