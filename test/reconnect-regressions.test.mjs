import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
const baseline=fileURLToPath(new URL('..',import.meta.url));
const temp=mkdtempSync(join(tmpdir(),'cw-reconnect-independent-'));let seq=0;
process.on('exit',()=>rmSync(temp,{recursive:true,force:true}));
async function fixture(){
 const id=++seq,shim=join(temp,`shim-${id}.mjs`),copy=join(temp,`live-${id}.mjs`);
 const helpers=pathToFileURL(join(baseline,'bridge/midi.js')).href;
 writeFileSync(shim,`export {noteOn,noteOff,controlChange,pitchBend,CC,CH} from ${JSON.stringify(helpers)};
 export const state={connected:true,valid:false,opens:0,closes:0,attempts:[],failAt:0,throwSend:null,throwClose:false,partial:false};
 export async function listDevices(){return {devices:state.connected?[{dir:'out',index:1,name:'loopMIDI Test'}]:[]};}
 export async function openPort(){state.opens++;state.valid=state.connected;return {ok:state.valid};}
 export async function closePort(){state.closes++;state.valid=false;if(state.throwClose)throw new Error('CLEANUP_REJECTED');return {ok:true};}
 async function perform(bytes){state.attempts.push(bytes);if(state.failAt===state.attempts.length){state.valid=false;state.connected=false;if(state.throwSend)throw state.throwSend;return state.partial?{ok:false,sent:1,attempted:2,failed:1,rc:6,error:'removed'}:{ok:false,rc:6};}return state.valid&&state.connected?{ok:true,sent:1}:{ok:false,rc:6};}
 export const send=perform;export const sendAll=perform;export const panic=async()=>({ok:true});`);
 const source=readFileSync(join(baseline,'lib/live.js'),'utf8')
  .replace("'../bridge/midi.js'",JSON.stringify(pathToFileURL(shim).href))
  .replace("'./midi-config.js'",JSON.stringify(pathToFileURL(join(baseline,'lib/midi-config.js')).href));
 writeFileSync(copy,source);const fake=await import(pathToFileURL(shim).href),live=await import(pathToFileURL(copy).href);
 return {live,state:fake.state};
}
const strictCases=[
 ['note-on',1,l=>l.playNote({pitch:60,durationMs:1})],['note-off',2,l=>l.playNote({pitch:60,durationMs:1})],
 ['chord-on',1,l=>l.playChord({pitches:[60,64],durationMs:1})],['chord-off',2,l=>l.playChord({pitches:[60,64],durationMs:1})],
 ['volume',1,l=>l.setChannelVolume(1,80)],['pan',1,l=>l.setChannelPan(1,64)],
 ['CC',1,l=>l.sendCC(1,11,80)],['bend',1,l=>l.bend(1,8192)]
];
for(const [label,offset,operation]of strictCases)test(`${label}: failed operation not replayed; next operation opens restored device`,async()=>{
 const{live,state}=await fixture();assert.equal((await live.sendCC(1,11,70)).ok,true);
 const before=state.attempts.length;state.failAt=before+offset;
 await assert.rejects(operation(live),e=>e.code==='MIDI_SEND_FAILED'&&e.detail.rc===6);
 assert.equal(state.attempts.length,before+offset,'no automatic replay');
 state.connected=true;assert.equal((await live.sendCC(1,11,71)).ok,true);
 assert.equal(state.opens,2,'same module must replace failed native handle');
 assert.equal(state.attempts.length,before+offset+1);
});
test('raw partial batch retains counts without replay and can reconnect',async()=>{
 const{live,state}=await fixture();state.failAt=1;state.partial=true;
 const r=await live.sendMessages([[144,60,90],[144,64,90]]);
 assert.deepEqual(r,{ok:false,sent:1,attempted:2,failed:1,error:'removed',rc:6});assert.equal(state.attempts.length,1);
 state.connected=true;assert.equal((await live.sendCC(1,11,80)).ok,true);assert.equal(state.opens,2);
});
test('send rejection retained even if native close also rejects',async()=>{
 const{live,state}=await fixture();state.failAt=1;state.throwSend=new Error('ORIGINAL_DISCONNECT');state.throwClose=true;
 await assert.rejects(live.sendCC(1,11,80),e=>e===state.throwSend);
 state.connected=true;state.throwClose=false;assert.equal((await live.sendCC(1,11,81)).ok,true);assert.equal(state.opens,2);
});
test('returned driver failure retained even when cleanup rejects',async()=>{
 const{live,state}=await fixture();state.failAt=1;state.throwClose=true;
 await assert.rejects(live.sendCC(1,11,80),e=>e.code==='MIDI_SEND_FAILED'&&e.detail.rc===6);
 state.connected=true;state.throwClose=false;assert.equal((await live.sendCC(1,11,81)).ok,true);assert.equal(state.opens,2);
});
