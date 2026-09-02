/** Does the export route bypass the capability check every other read enforces? */
const B='http://127.0.0.1:8080';
async function j(p,i={}){const r=await fetch(B+p,i);const t=await r.text();let x=null;try{x=JSON.parse(t)}catch{};return{s:r.status,t,j:x}}
async function signIn(email){
  const l=await j('/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});
  const v=await j('/v1/auth/mfa/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({actorId:l.j.actorId,challengeId:l.j.challengeId,code:l.j.devCode})});
  return v.j.accessToken;
}
const s=await j('/v1/console/session',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
const projectId=s.j.projectId;
const sup=await signIn('site@meridian.example');
const H={authorization:`Bearer ${sup}`,'content-type':'application/json'};

console.log('--- can the supervisor read the commercial position directly? ---');
for (const p of [`/v1/projects/${projectId}/cost/budget`, `/v1/projects/${projectId}/cost/cashflow`, `/v1/projects/${projectId}/commercial-control`]) {
  const r = await j(p,{headers:H});
  console.log(` ${p} -> ${r.s} ${r.j?.title ?? ''}`);
}

console.log('\n--- and through an export addressed to a court? ---');
const court = await j(`/v1/projects/${projectId}/exports/report`,{method:'POST',headers:H,body:JSON.stringify({audience:'COURT',format:'JSON_BUNDLE'})});
console.log(' export status:', court.s);
const text = court.t;
const commercial = /CPI|SPI|Commercial|costPerformanceIndex|Forecast at completion|Contract value/i.test(text);
console.log(' contains a Commercial section:', commercial);
for (const m of text.matchAll(/"text":"(Commercial|Programme|Project)"/g)) console.log('   section:', m[1]);
const supplier = await j(`/v1/projects/${projectId}/exports/report`,{method:'POST',headers:H,body:JSON.stringify({audience:'SUPPLIER',format:'JSON_BUNDLE'})});
console.log(' SUPPLIER bundle contains Commercial:', /"text":"Commercial"/.test(supplier.t));
console.log(' COURT bundle contains Commercial:', /"text":"Commercial"/.test(court.t));
