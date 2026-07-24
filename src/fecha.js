function pad(n) {
  return String(n).padStart(2, '0');
}

function fechaValida(a, m, d) {
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function convertirFechaBiofile(valor) {
  if (valor === null || valor === undefined || valor === '') return '';

  if (valor instanceof Date && !Number.isNaN(valor.getTime())) {
    return `${pad(valor.getUTCDate())}/${pad(valor.getUTCMonth() + 1)}/${valor.getUTCFullYear()}`;
  }

  if (typeof valor === 'number' && Number.isFinite(valor)) {
    // Sistema de fechas de Excel: 1 = 01/01/1900. El origen práctico es 30/12/1899.
    const ms = Date.UTC(1899, 11, 30) + Math.floor(valor) * 86400000;
    const dt = new Date(ms);
    return `${pad(dt.getUTCDate())}/${pad(dt.getUTCMonth() + 1)}/${dt.getUTCFullYear()}`;
  }

  const s = String(valor).trim();

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const [, a, mes, dia] = m.map(Number);
    if (!fechaValida(a, mes, dia)) throw new Error(`Fecha inválida: ${s}`);
    return `${pad(dia)}/${pad(mes)}/${a}`;
  }

  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) {
    const dia = Number(m[1]);
    const mes = Number(m[2]);
    const a = Number(m[3]);
    if (!fechaValida(a, mes, dia)) throw new Error(`Fecha inválida: ${s}`);
    return `${pad(dia)}/${pad(mes)}/${a}`;
  }

  throw new Error(`No se pudo convertir la fecha: ${s}`);
}
