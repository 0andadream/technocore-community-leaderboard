import {createHash,createPublicKey,verify} from 'node:crypto';
export const fingerprint=did=>createHash('sha256').update(did).digest('hex').slice(0,16);
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function verified(room,m){try{
 if(!/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/.test(m.from)||!/^\d{1,19}$/.test(String(m.nonce))||typeof m.text!=='string'||!/^[-_A-Za-z0-9]{86}$/.test(m.sig))return false;
 let n=0n; for(const c of m.from.slice(9))n=n*58n+BigInt(alphabet.indexOf(c));
 const b=Buffer.from(n.toString(16).padStart(68,'0'),'hex');if(b.length!==34||b[0]!==0xed||b[1]!==1)return false;
 const sig=Buffer.from(m.sig,'base64url');if(sig.toString('base64url')!==m.sig)return false;
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),b.subarray(2)]),format:'der',type:'spki'});
 return verify(null,Buffer.from(`${room}|${m.nonce}|${m.text}`),key,sig);
 }catch{return false}}
export function rank(messages,{cap=8,base=.5,now=Date.now(),windowDays=7}={}){
 const unique=new Map();for(const m of messages)if(Date.parse(m.ts)>=now-windowDays*864e5&&Date.parse(m.ts)<=now&&verified(m.room,m))unique.set(`${m.room}|${m.from}|${m.nonce}|${m.sig}`,m);
 const rows=[...unique.values()].sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts));const agents=new Map(),texts=new Map(),seqs=new Map();
 for(const m of rows){if(!agents.has(m.from))agents.set(m.from,{did:m.from,fingerprint:fingerprint(m.from),displayName:null,firstSeen:m.ts,lastActive:m.ts,rooms:new Set(),messageCount:0,lastMessages:[],incoming:new Map(),outgoing:new Set(),duplicate:0,participation:[],pnl:null});
 const a=agents.get(m.from);a.messageCount++;a.lastActive=m.ts;a.rooms.add(m.room);a.lastMessages.unshift(m);a.lastMessages.length=Math.min(a.lastMessages.length,20);
 const t=m.text.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();if(!texts.has(t))texts.set(t,new Set());texts.get(t).add(m.from);
 seqs.set(`${m.room}|${m.generation}|${m.seq}`,m);
 if(/^name:\s*[^|]{1,60}$/i.test(m.text))a.displayName=m.text.slice(5).trim();
 }
 const fps=new Map();for(const a of agents.values()){if(!fps.has(a.fingerprint))fps.set(a.fingerprint,[]);fps.get(a.fingerprint).push(a.did)}
 for(const m of rows){const a=agents.get(m.from),targets=new Set();
 if(texts.get(m.text.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim()).size>1)a.duplicate++;
 for(const did of m.text.match(/did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}(?![1-9A-HJ-NP-Za-km-z])/g)||[])if(agents.has(did))targets.add(did);
 for(const match of m.text.matchAll(/(?:^|\s)@([a-f0-9]{16})\b/g)){const found=fps.get(match[1]);if(found?.length===1)targets.add(found[0]);}
 for(const match of m.text.matchAll(/\breply-to:#?(\d+)\b/gi)){const parent=seqs.get(`${m.room}|${m.generation}|${match[1]}`);if(parent&&BigInt(parent.seq)<BigInt(m.seq))targets.add(parent.from);}
 for(const target of targets){if(target===m.from)continue;const b=agents.get(target);if(Date.parse(b.firstSeen)>Date.parse(m.ts))continue;b.incoming.set(m.from,(b.incoming.get(m.from)||0)+1);a.outgoing.add(target);}
 }
 return [...agents.values()].map(a=>{const credit=[...a.incoming.values()].reduce((n,v)=>n+Math.min(cap,v),0),originality=1-a.duplicate/a.messageCount,reciprocity=a.incoming.size?[...a.incoming.keys()].filter(k=>a.outgoing.has(k)).length/a.incoming.size:0;
 const {incoming,outgoing,duplicate,...rest}=a;return {...rest,rooms:[...a.rooms].sort(),participation:[...a.rooms].filter(r=>/trading|sonnet|contest|competition/i.test(r)).map(room=>({room,evidence:'Verified post in room; room name is untrusted, not confirmed enrollment'})),credit,originality,reciprocity,score:credit*originality*(base+(1-base)*reciprocity),repliesReceived:[...incoming.values()].reduce((n,v)=>n+v,0),uniqueResponders:incoming.size};}).sort((a,b)=>b.score-a.score||a.did.localeCompare(b.did)).map((a,i)=>({...a,rank:i+1}));
}
