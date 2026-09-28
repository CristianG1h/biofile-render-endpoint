import { SheetsApiClient, extraerSpreadsheetId } from '../google-sheets.js';

// One writer per deployment. Do not run multiple Render replicas with this store.
// Fixed row updates are idempotent, unlike Sheets append.
export class JobStore {
  constructor(google, sheet = process.env.BIOFILE_JOBS_SHEET || 'TRABAJOS_BIOFILE') {
    this.api = new SheetsApiClient(google);
    this.id = extraerSpreadsheetId(google.urlOId);
    this.sheet = sheet;
    this.items = new Map(); this.rows = new Map(); this.tail = Promise.resolve();
  }
  range(value) { return `'${this.sheet.replace(/'/g, "''")}'!${value}`; }
  async init() {
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${this.id}`;
    const metadata = await this.api.request(base + '?fields=sheets.properties');
    if (!(metadata.sheets || []).some(s => s.properties.title === this.sheet)) {
      await this.api.request(base + ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: this.sheet, gridProperties: { rowCount: 10000, columnCount: 2 } } } }] }) });
    }
    const properties=metadata.sheets?.find(s=>s.properties.title===this.sheet)?.properties;
    this.rowCount=properties?.gridProperties?.rowCount || 10000;
    const values = await this.api.getValues(this.id, this.range('A:B'));
    this.nextRow = Math.max(2, values.length + 1);
    for (let i = 1; i < values.length; i++) {
      if (!values[i]?.[0]) continue;
      try {
        const job = JSON.parse(values[i][1]);
        if (!job.id || job.id !== values[i][0] || this.rows.has(job.id)) throw new Error('Invalid journal identity');
        this.items.set(job.id, job); this.rows.set(job.id, i + 1);
      } catch { throw new Error(`Estado persistente ilegible en fila ${i + 1}. Se bloquea la ejecución para evitar duplicados.`); }
    }
    await this.write(1, ['ID', 'ESTADO_JSON']);
    return this;
  }
  async write(row, values) {
    const range = this.range(`A${row}:B${row}`);
    await this.api.request(`https://sheets.googleapis.com/v4/spreadsheets/${this.id}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ range, values: [values] }) });
  }
  save(job) {
    const snapshot = JSON.parse(JSON.stringify(job));
    const serialized = JSON.stringify(snapshot);
    if (serialized.length > 45000) return Promise.reject(new Error('El trabajo supera el tamaño permitido del historial.'));
    const task = this.tail.catch(() => {}).then(async () => {
      let row = this.rows.get(job.id);
      if (!row) { row = this.nextRow++; this.rows.set(job.id, row); }
      if (row > this.rowCount) {
        const base=`https://sheets.googleapis.com/v4/spreadsheets/${this.id}`;
        const meta=await this.api.request(base+'?fields=sheets.properties');
        const properties=meta.sheets.find(s=>s.properties.title===this.sheet).properties;
        const target=Math.max(row+1000,properties.gridProperties.rowCount);
        await this.api.request(base+':batchUpdate',{method:'POST',body:JSON.stringify({requests:[{updateSheetProperties:{properties:{sheetId:properties.sheetId,gridProperties:{rowCount:target}},fields:'gridProperties.rowCount'}}]})});
        this.rowCount=target;
      }
      await this.write(row, [job.id, serialized]);
      this.items.set(job.id, snapshot);
    });
    this.tail = task; return task;
  }
  delete(id) {
    const task = this.tail.catch(() => {}).then(async () => {
      const row = this.rows.get(id);
      if (!row) return false;
      await this.write(row, ['', '']);
      this.items.delete(id);
      this.rows.delete(id);
      return true;
    });
    this.tail = task;
    return task;
  }
}
