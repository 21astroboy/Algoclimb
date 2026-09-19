const fs=require('fs'); const {spawn}=require('child_process'); const WebSocket=require('ws');
const LOG='/tmp/rt.log'; fs.writeFileSync(LOG,'START\n');
const w=s=>fs.appendFileSync(LOG,s+'\n');
const srv=spawn('node',['--experimental-sqlite','server.js'],{stdio:['ignore','ignore','ignore']});
const B='ws://localhost:3000'; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function once(ws,t,timeout=5000){return new Promise((res,rej)=>{
  const to=setTimeout(()=>{ws.off('message',h);rej(new Error('timeout '+t));},timeout);
  const h=d=>{const m=JSON.parse(d);if(!t||m.type===t){clearTimeout(to);ws.off('message',h);res(m);}};
  ws.on('message',h);});}
function done(c){try{srv.kill('SIGKILL');}catch{} w('EXIT '+c); setTimeout(()=>process.exit(c),150);}
setTimeout(()=>{w('HARD TIMEOUT');done(3);},22000);
(async()=>{
  await sleep(2000); w('server-wait done');
  const T=new WebSocket(B+'/?role=teacher'); await new Promise((r,j)=>{T.on('open',r);T.on('error',j);}); w('teacher connected');
  let st=null; T.on('message',d=>{const m=JSON.parse(d);if(m.type==='state')st=m;});
  const mk=async(n)=>{const ws=new WebSocket(B+'/');await new Promise(r=>ws.on('open',r));
    ws.send(JSON.stringify({type:'join',nick:n,icon:'X'}));await once(ws,'joined');return ws;};
  const A=await mk('alice'); const Bb=await mk('bob'); w('students joined');
  await sleep(150); T.send(JSON.stringify({type:'start'}));
  const ta=await once(A,'task'); await once(Bb,'task');
  w(`R1 idx=${ta.index}/${ta.total} type=${ta.task.type} limit=${ta.limit}`);
  const ans=(t,c)=> t.task.type==='choice'?{type:'answer',taskId:t.task.id,payload:{choice:c}}:{type:'answer',taskId:t.task.id,payload:{edges:[]}};
  A.send(JSON.stringify(ans(ta,0))); const aA=await once(A,'answered');
  w(`alice correct=${aA.correct} pts=${aA.points} picked=${aA.picked}`);
  A.send(JSON.stringify(ans(ta,1)));
  Bb.send(JSON.stringify(ans(ta,0))); const aB=await once(Bb,'answered');
  w(`bob correct=${aB.correct} pts=${aB.points}`);
  await once(A,'roundover'); w('R1 roundover OK (all-answered advance)');
  const t2=await once(A,'task'); await once(Bb,'task');
  w(`R2 idx=${t2.index}/${t2.total} type=${t2.task.type}`);
  await sleep(150);
  w(`state status=${st&&st.session.status} answered=${st&&st.answeredCount} active=${st&&st.activeCount}`);
  w('PASS'); done(0);
})().catch(e=>{w('ERR '+e.message); done(1);});
