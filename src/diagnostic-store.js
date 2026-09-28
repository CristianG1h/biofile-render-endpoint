import fs from 'node:fs/promises';
import path from 'node:path';
export async function purgeDiagnostics(root, retentionMs = Number(process.env.SCREENSHOT_RETENTION_MS || 86400000)) {
  const cutoff = Date.now() - retentionMs;
  async function visit(dir) {
    for (const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])) {
      if(e.isSymbolicLink())continue;
      const file=path.join(dir,e.name);
      if(e.isDirectory())await visit(file);
      else if(/\.(png|json)$/.test(e.name) && (await fs.stat(file)).mtimeMs<cutoff)await fs.unlink(file);
    }
  }
  await visit(root);
}
