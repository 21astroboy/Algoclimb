const WebSocket=require('ws'); const B='ws://localhost:3000';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function once(ws,t,timeout=5000){return new Promise((res,rej)=>{
  const to=setTimeout(()=>{ws.off('message',h);rej(new Error('timeout '+t));},timeout);
  const h=d=>{const m=JSON.parse(d);if(!t||m.type===t){clearTimeout(to);ws.off('message',h);res(m);}};
  ws.on('message',h);});}
(async()=>{
  const T=new WebSocket(B+'/?role=teacher'); await new Promise(r=>T.on('open',r));
  let st=null; T.on('message',d=>{const m=JSON.parse(d);if(m.type==='state')st=m;});
  const mk=async(n)=>{const w=new WebSocket(B+'/');await new Promise(r=>w.on('open',r));
    w.send(JSON.stringify({type:'join',nick:n,icon:'X'}));await once(w,'joined');return w;};
  const A=await mk('alice'); const Bb=await mk('bob');
  await sleep(150); T.send(JSON.stringify({type:'start'}));
  const ta=await once(A,'task'); await once(Bb,'task');
  console.log(`R1 idx=${ta.index}/${ta.total} type=${ta.task.type} limit=${ta.limit}`);
  const ans=(t,c)=> t.task.type==='choice'?{type:'answer',taskId:t.task.id,payload:{choice:c}}:{type:'answer',taskId:t.task.id,payload:{edges:[]}};
  A.send(JSON.stringify(ans(ta,0))); const aA=await once(A,'answered');
  console.log(`alice correct=${aA.correct} pts=${aA.points} picked=${aA.picked}`);
  A.send(JSON.stringify(ans(ta,1)));
  Bb.send(JSON.stringify(ans(ta,0))); const aB=await once(Bb,'answered');
  console.log(`bob correct=${aB.correct} pts=${aB.points}`);
  await once(A,'roundover'); console.log('R1 roundover OK (advance on all-answered)');
  const t2=await once(A,'task'); await once(Bb,'task');
  console.log(`R2 idx=${t2.index}/${t2.total} type=${t2.task.type}`);
  await sleep(100);
  console.log(`state status=${st&&st.session.status} answered=${st&&st.answeredCount} active=${st&&st.activeCount}`);
  console.log('PASS'); process.exit(0);
})().catch(e=>{console.error('ERR '+e.message);process.exit(1);});
