import crypto from 'node:crypto';
import path from 'node:path';

export function crearConfigUsuario(configBase, { credencialesBiofile, sesionBiofileId = '' } = {}) {
  const usuario = String(credencialesBiofile?.usuario || configBase.biofile.usuario || '').trim();
  const contrasena = String(
    credencialesBiofile?.contrasena ?? configBase.biofile.contrasena ?? ''
  );
  let authPath = configBase.browser.authPath;

  if (sesionBiofileId) {
    const huella = crypto
      .createHash('sha256')
      .update(String(sesionBiofileId))
      .digest('hex')
      .slice(0, 16);
    const partes = path.parse(configBase.browser.authPath);
    authPath = path.join(partes.dir, `${partes.name}-${huella}${partes.ext || '.json'}`);
  }

  return {
    ...configBase,
    biofile: {
      ...configBase.biofile,
      usuario,
      contrasena
    },
    browser: {
      ...configBase.browser,
      authPath
    }
  };
}
