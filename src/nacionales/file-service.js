import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export function validateFile(name, mime, bytes) {
  const ext = path.extname(name).toLowerCase();
  const detected = bytes.subarray(0,5).toString() === '%PDF-' ? 'application/pdf' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : '';
  if (!detected || mime !== detected || !({ 'application/pdf':['.pdf'], 'image/jpeg':['.jpg','.jpeg'], 'image/png':['.png'] })[detected].includes(ext)) throw new Error('Extensión, MIME y contenido del archivo no coinciden.');
  if (!bytes.length || bytes.length > Number(process.env.NACIONALES_MAX_FILE_BYTES || 10485760)) throw new Error('Archivo vacío o superior al límite de 10 MB.');
  return { sourceFile: path.basename(name).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0,120), fileHash: crypto.createHash('sha256').update(bytes).digest('hex'), mime: detected };
}
export async function extractFile(bytes, metadata, needsOcr) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'biofile-document-'));
  const input = path.join(dir, metadata.mime === 'application/pdf' ? 'input.pdf' : metadata.mime === 'image/png' ? 'input.png' : 'input.jpg');
  const options = { timeout: 45000, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
  try {
    await fs.writeFile(input, bytes, { mode: 0o600 });
    let text = '', digitalText = '', method = 'pdf-text';
    if (metadata.mime === 'application/pdf') {
      const info = await exec(process.env.PDFINFO_BIN || 'pdfinfo', [input], options);
      const pages = Number(info.stdout.match(/Pages:\s*(\d+)/)?.[1] || 0);
      if (!pages || pages > Number(process.env.NACIONALES_MAX_PAGES || 10)) throw new Error('El PDF supera el límite de páginas o no se puede leer.');
      text = (await exec(process.env.PDFTOTEXT_BIN || 'pdftotext', ['-layout','-enc','UTF-8', input, '-'], options)).stdout;
      digitalText = text;
    }
    if (!text.trim() || needsOcr(text)) {
      method = text.trim() ? 'pdf-text+ocr' : 'ocr';
      let images = [input];
      if (metadata.mime === 'application/pdf') {
        await exec(process.env.PDFTOPPM_BIN || 'pdftoppm', ['-r','150','-scale-to','2200','-png',input,path.join(dir,'page')], options);
        images = (await fs.readdir(dir)).filter(n => /^page-.*\.png$/.test(n)).sort().map(n => path.join(dir,n));
      }
      let ocr = '';
      for (const image of images) ocr += (await exec(process.env.TESSERACT_BIN || 'tesseract', [image,'stdout','-l','spa','--psm','3'], options)).stdout + '\n';
      // Do not combine two competing identities. Parser chooses a complete source.
      if (ocr.trim()) text = ocr;
    }
    if (!text.trim()) throw new Error('No se pudo extraer texto legible.');
    return { text, digitalText, method };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Falta instalar Poppler o Tesseract en el servidor. Revise el despliegue Docker.');
    if (error.killed) throw new Error('La lectura del archivo superó el tiempo permitido.');
    // Child-process errors can include extracted sensitive text: never propagate stderr.
    if (error.cmd) throw new Error('No fue posible leer el documento con el motor de extracción.');
    throw error;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
