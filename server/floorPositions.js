// Posiciones (0-100, % del lienzo) de las mesas reales de Plaza España, leídas de la
// foto del plano de Cover. Compartido por seed.js (primer arranque) y db.js (migración
// segura que actualiza solo pos_x/pos_y sin tocar reservas ni el resto de datos).
// Las claves están en la numeración ORIGINAL de Cover (con huecos y el salto a
// 508-519); se renumeran correlativas (1-38) al final del archivo.
const { renombrar } = require('./tableRenumbering');

const SALA_INTERIOR_POS_COVER = {
  '9': [6, 14], '8': [15, 14], '7': [22, 14],
  '519': [73, 10],
  '13': [6, 33], '12': [14, 33], '11': [21, 33], '10': [28, 33],
  '6': [40, 41], '4': [51, 41], '2': [58, 41],
  '5': [40, 49], '3': [51, 49], '1': [58, 49],
  '17': [5, 49], '16': [10, 49], '15': [17, 49], '14': [24, 49],
  '18': [4, 61], '19': [4, 69], '20': [4, 78],
  '518': [21, 69], '517': [41, 69], '516': [51, 69], '515': [62, 69],
  '21': [4, 87], '22': [11, 87], '23': [16, 87],
  '24': [25, 87], '508': [30, 87], '26': [35, 87], '27': [40, 87],
  '509': [46, 87], '510': [51, 87],
  '511': [60, 87], '512': [65, 87], '513': [71, 87], '514': [75, 87],
};

const SALA_INTERIOR_POS = Object.fromEntries(
  Object.entries(SALA_INTERIOR_POS_COVER).map(([nombre, pos]) => [renombrar(nombre), pos])
);

const BARRA_POS = {
  '201': [30, 3], '202': [38, 3], '203': [46, 3], '204': [54, 3],
  '205': [62, 3], '206': [70, 3], '207': [78, 3],
};

module.exports = { SALA_INTERIOR_POS, BARRA_POS };
