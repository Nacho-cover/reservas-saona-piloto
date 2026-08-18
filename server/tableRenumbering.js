// Sala Interior tenía numeración con huecos y un salto raro (1-24, 26, 27, y luego
// 508-519 — así venía exportado literalmente de Cover). Se pasa a correlativa 1-38.
// Solo cambia la ETIQUETA visible; qué mesas físicas se combinan entre sí no se toca
// (las combinaciones referencian mesas por id, no por nombre). Compartido por
// seed.js y floorPositions.js para no tener que retranscribir a mano ni las 40 filas
// de combinaciones ni las posiciones del plano.
const RENUMERACION_SALA_INTERIOR = {
  '26': '25', '27': '26',
  '508': '27', '509': '28', '510': '29', '511': '30', '512': '31', '513': '32',
  '514': '33', '515': '34', '516': '35', '517': '36', '518': '37', '519': '38',
};

function renombrar(nombre) {
  return RENUMERACION_SALA_INTERIOR[nombre] || nombre;
}

module.exports = { RENUMERACION_SALA_INTERIOR, renombrar };
