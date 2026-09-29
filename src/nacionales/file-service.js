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
export async function extractFile(bytes, metadata, needsOcr, run = exec) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'biofile-document-'));
  const input = path.join(dir, metadata.mime === 'application/pdf' ? 'input.pdf' : metadata.mime === 'image/png' ? 'input.png' : 'input.jpg');
  const options = { timeout: 45000, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
  let stage = 'abrir archivo';
  const failure = error => {
    if (error.code === 'ENOENT') return `No está disponible el motor para ${stage}. Revise Poppler y Tesseract en el servidor.`;
    if (error.killed) return `Se agotó el tiempo al ${stage}.`;
    return `No fue posible ${stage}. Revise que el documento no esté dañado ni protegido.`;
  };
  try {
    await fs.writeFile(input, bytes, { mode: 0o600 });
    let text = '', digitalText = '', method = 'pdf-text', pages = 1, pageSize = null;
    const warnings = [];
    if (metadata.mime === 'application/pdf') {
      stage = 'inspeccionar el PDF';
      const info = await run(process.env.PDFINFO_BIN || 'pdfinfo', [input], options);
      pages = Number(info.stdout.match(/Pages:\s*(\d+)/)?.[1] || 0);
      const dimensions=info.stdout.match(/Page size:\s*([\d.]+)\s+x\s+([\d.]+)/);
      if (dimensions && !Number(info.stdout.match(/Page rot:\s*(\d+)/)?.[1]||0)) pageSize=dimensions.slice(1).map(Number);
      if (!pages || pages > Number(process.env.NACIONALES_MAX_PAGES || 10)) throw new Error('El PDF supera el límite de páginas o no se puede leer.');
      stage = 'leer el texto del PDF';
      text = (await run(process.env.PDFTOTEXT_BIN || 'pdftotext', ['-layout','-enc','UTF-8', input, '-'], options)).stdout;
      digitalText = text;
    }
    const request=text.trim()?needsOcr(text):true;
    if (!text.trim() || request) {
      method = text.trim() ? 'pdf-text+ocr' : 'ocr';
      let ocr = '';
      try {
        if (request.footerOnly && pages===1 && pageSize?.every(n=>n>0)) {
          // Crop during rendering, before PNG encoding and recognition. The
          // 3300px scale preserves the tiny address without OCR of the whole page.
          const height=Math.floor(3300*pageSize[1]/Math.max(...pageSize));
          const top=Math.floor(height*0.8),prefix=path.join(dir,'footer');
          stage='convertir el pie de página para OCR';
          await run(process.env.PDFTOPPM_BIN||'pdftoppm',['-f','1','-l','1','-singlefile','-scale-to','3300','-y',String(top),'-H',String(height-top),'-png',input,prefix],options);
          stage='leer la sede en el pie de página';
          ocr=(await run(process.env.TESSERACT_BIN||'tesseract',[prefix+'.png','stdout','-l','spa','--psm','11'],options)).stdout;
          await fs.rm(prefix+'.png',{force:true});
          if (ocr.trim() && !needsOcr(digitalText+'\n'+ocr)) return {text:ocr,digitalText,method,warnings};
        }
        // Render and release one page at a time to bound memory and disk use.
        for (let page = 1; page <= pages; page++) {
          let image = input;
          if (metadata.mime === 'application/pdf') {
            stage = `convertir la página ${page} para OCR`;
            const prefix = path.join(dir, 'page');
            await run(process.env.PDFTOPPM_BIN || 'pdftoppm', ['-f',String(page),'-l',String(page),'-singlefile','-r','150','-scale-to','2200','-png',input,prefix], options);
            image = prefix + '.png';
          }
          stage = `leer por OCR la página ${page}`;
          const segmentation=digitalText.trim()?['--psm','3']:['--psm','1','-c','min_orientation_margin=0'];
          ocr += (await run(process.env.TESSERACT_BIN || 'tesseract', [image,'stdout','-l','spa',...segmentation], options)).stdout + '\n';
          // Small image footers can disappear at the normal resolution. Only pay
          // for a larger sparse-text pass when required fields remain unresolved.
          if (!request.footerOnly && digitalText.trim() && metadata.mime === 'application/pdf' && needsOcr(digitalText+'\n'+ocr)) {
            stage = `ampliar la página ${page} para leer texto pequeño`;
            await run(process.env.PDFTOPPM_BIN || 'pdftoppm', ['-f',String(page),'-l',String(page),'-singlefile','-r','225','-scale-to','3300','-png',input,path.join(dir,'page')], options);
            stage = `leer texto pequeño por OCR en la página ${page}`;
            ocr += (await run(process.env.TESSERACT_BIN || 'tesseract', [image,'stdout','-l','spa','--psm','11'], options)).stdout + '\n';
          }
          if (image !== input) await fs.rm(image, { force:true });
        }
        if (!ocr.trim()) throw new Error('OCR vacío');
      } catch (error) {
        if (!digitalText.trim()) throw new Error(failure(error));
        warnings.push(failure(error) + ' Se conservó el texto digital. Confirme la ciudad y los datos pendientes antes de enviar.');
        method = 'pdf-text-ocr-incomplete';
      }
      // Do not combine two competing identities. Parser chooses a complete source.
      if (ocr.trim()) text = ocr;
    }
    if (!text.trim()) throw new Error('No se pudo extraer texto legible.');
    return { text, digitalText, method, warnings };
  } catch (error) {
    // Child-process errors can include extracted sensitive text: never propagate stderr.
    if (error.cmd || error.code === 'ENOENT' || error.killed) throw new Error(failure(error));
    throw error;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
