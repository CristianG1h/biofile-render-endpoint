// Local corpus audit. Feed JSONL {name,mime,data(base64)} on stdin.
// Patient values and clinical text are never written to the report.
import readline from 'node:readline';
import { validateFile, extractFile } from '../src/nacionales/file-service.js';
import { parseDocument, documentOcrPlan } from '../src/nacionales/parser.js';
const report={documents:0,templates:{},cities:{},methods:{},missingCity:[],missingIdentity:[],failures:[],warnings:0};
for await (const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
  if (!line.trim()) continue;
  const index=++report.documents;
  try {
    const file=JSON.parse(line),bytes=Buffer.from(file.data,'base64');
    const result=await extractFile(bytes,validateFile(file.name,file.mime,bytes),documentOcrPlan);
    const digital=result.digitalText?parseDocument(result.digitalText):null;
    const parsed=digital?.patient.numeroDocumento&&digital?.patient.primerNombre?digital:parseDocument(result.text);
    if(!parsed.cityExam) parsed.cityExam=parseDocument(result.text).cityExam;
    const template=parsed.templateDetected,city=parsed.cityExam||'POR CONFIRMAR';
    report.templates[template]=(report.templates[template]||0)+1;
    report.cities[city]=(report.cities[city]||0)+1;
    report.methods[result.method]=(report.methods[result.method]||0)+1;
    report.warnings+=result.warnings.length;
    if(!parsed.cityExam)report.missingCity.push({index,template});
    if(!parsed.patient.numeroDocumento||!parsed.patient.primerNombre||!parsed.patient.primerApellido)report.missingIdentity.push({index,template});
  } catch(error) {report.failures.push({index,error:error.message});}
}
console.log(JSON.stringify({...report,notice:'Cobertura de extracción, no certificación de exactitud clínica. Sin datos de pacientes.'},null,2));
