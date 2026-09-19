const WebSocket=require('ws');
setTimeout(()=>{console.log('HARD TIMEOUT'); process.exit(2);},8000);
const w=new WebSocket('ws://localhost:3000/?role=teacher');
w.on('open',()=>{console.log('OPEN ok'); });
w.on('message',d=>{const m=JSON.parse(d);console.log('MSG type='+m.type); process.exit(0);});
w.on('error',e=>{console.log('WSERR '+e.message); process.exit(1);});
