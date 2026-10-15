import { normalizar } from './util.js';
import { variantesPais } from './lugares-nacimiento.js';

export function separarCiudadNacimiento(valor) {
  const original = String(valor ?? '').trim().replace(/\s+/g, ' ');
  if (!original) return { original: '', municipio: '', departamento: '', pais: '', opcionEsperada: '' };

  // Acepta tanto MUNICIPIO (DEPARTAMENTO, PAIS) como CIUDAD (PAIS).
  // Algunos nombres de país contienen paréntesis: ISLAS MALVINAS (ISLAS FALKLAND).
  const conParentesis = original.match(/^(.+?)\s*\(\s*(.+)\s*\)$/);
  if (conParentesis) {
    let municipio = conParentesis[1].trim();
    const partes = conParentesis[2].split(',').map((x) => x.trim()).filter(Boolean);
    let departamento = '';
    let pais = '';
    if (partes.length >= 2) {
      pais = partes[partes.length - 1];
      departamento = partes.slice(0, -1).join(', ');
    } else {
      pais = partes[0] || '';
    }

    const m = normalizar(municipio);
    const d = normalizar(departamento);
    const p = normalizar(pais);
    if (['BOGOTA', 'BOGOTA D C'].includes(m) && d === 'BOGOTA D C' && p === 'COLOMBIA') {
      municipio = 'BOGOTÁ';
      departamento = 'BOGOTÁ D.C.';
      pais = 'COLOMBIA';
    }

    return {
      original,
      municipio,
      departamento,
      pais,
      opcionEsperada: departamento
        ? municipio + ' (' + departamento + ', ' + pais + ')'
        : municipio + ' (' + pais + ')'
    };
  }

  const departamentos = [
    'AMAZONAS', 'ANTIOQUIA', 'ARAUCA', 'ARCHIPIELAGO DE SAN ANDRES PROVIDENCIA Y SANTA CATALINA',
    'ATLANTICO', 'BOGOTA D C', 'BOLIVAR', 'BOYACA', 'CALDAS', 'CAQUETA', 'CASANARE', 'CAUCA',
    'CESAR', 'CHOCO', 'CORDOBA', 'CUNDINAMARCA', 'GUAINIA', 'GUAVIARE', 'HUILA', 'LA GUAJIRA',
    'MAGDALENA', 'META', 'NARINO', 'NORTE DE SANTANDER', 'PUTUMAYO', 'QUINDIO', 'RISARALDA',
    'SANTANDER', 'SUCRE', 'TOLIMA', 'VALLE DEL CAUCA', 'VAUPES', 'VICHADA'
  ].sort((a, b) => b.length - a.length);

  const n = normalizar(original);
  for (const dep of departamentos) {
    const sufijo = ' ' + dep;
    if (!n.endsWith(sufijo)) continue;
    const muni = n.slice(0, -sufijo.length).trim();
    if (muni) {
      return {
        original,
        municipio: muni,
        departamento: dep,
        pais: 'COLOMBIA',
        opcionEsperada: muni + ' (' + dep + ', COLOMBIA)'
      };
    }
  }

  const partes = original.split(',').map((x) => x.trim()).filter(Boolean);
  if (partes.length >= 3) {
    const municipio = partes[0];
    const departamento = partes[1];
    const pais = partes.slice(2).join(', ');
    return {
      original,
      municipio,
      departamento,
      pais,
      opcionEsperada: municipio + ' (' + departamento + ', ' + pais + ')'
    };
  }
  if (partes.length === 2) {
    return {
      original,
      municipio: partes[0],
      departamento: '',
      pais: partes[1],
      opcionEsperada: partes[0] + ' (' + partes[1] + ')'
    };
  }

  // Compatibilidad con registros antiguos que solo traían municipio.
  return { original, municipio: original, departamento: '', pais: 'COLOMBIA', opcionEsperada: '' };
}

export function claveCiudad(valor) {
  const n=normalizar(valor);
  return ({'BOGOTA D C':'BOGOTA','VILLA DE SAN DIEGO DE UBATE':'UBATE','SAN ANDRES DE TUMACO':'TUMACO','GUADALAJARA DE BUGA':'BUGA'})[n] || n;
}
export function coincideNacimiento(opcion, solicitado) {
  const a=separarCiudadNacimiento(opcion);
  const b=typeof solicitado==='string'?separarCiudadNacimiento(solicitado):solicitado;
  // La sugerencia debe incluir país explícito, no solo texto libre.
  if(!a.opcionEsperada || !b.municipio || claveCiudad(a.municipio)!==claveCiudad(b.municipio)) return false;
  const paises=variantesPais(b.pais || 'COLOMBIA');
  if(!variantesPais(a.pais).some(p=>paises.includes(p))) return false;
  return !b.departamento || normalizar(a.departamento)===normalizar(b.departamento);
}
export function resolverNacimiento(opciones, solicitado) {
  const candidatas=[...new Set(opciones)].filter(op=>coincideNacimiento(op,solicitado));
  const claves=new Set(candidatas.map(op=>{const p=separarCiudadNacimiento(op);return [claveCiudad(p.municipio),normalizar(p.departamento),normalizar(p.pais)].join('|');}));
  return claves.size===1 ? candidatas[0] : '';
}
