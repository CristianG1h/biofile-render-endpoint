import { parseDocument } from '../src/nacionales/parser.js';
let input='';for await(const chunk of process.stdin)input+=chunk;
const documents=JSON.parse(input), templates={}, fields={};
for(const text of documents){
  const c=parseDocument(text);templates[c.templateDetected]=(templates[c.templateDetected]||0)+1;
  for(const [key,value] of Object.entries(c.patient)) if(value)fields[key]=(fields[key]||0)+1;
  if(c.exams.length)fields.exams=(fields.exams||0)+1;
  if(c.cityExam)fields.cityExam=(fields.cityExam||0)+1;
}
console.log(JSON.stringify({documents:documents.length,templates,fields,notice:'Presence counts are not an accuracy claim. No patient values retained.'},null,2));
