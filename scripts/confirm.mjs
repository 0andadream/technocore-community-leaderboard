import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const FULL_DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const pending = {status: 'pending', gotIn: null, headline: 'Archive check is still running.', detail: 'Score reads the published close-1 files when the server starts and once a day at 9:45 UTC. A mint result shows up when that pass finishes.'};

export function confirmation({did, meta, mintedSweep, row}){
  if(!meta || meta.status !== 'ready') return {...pending, through: meta?.through ?? null, checkedAt: meta?.checkedAt ?? null};
  if(!FULL_DID.test(did)) return {status: 'invalid', gotIn: null, headline: 'Paste a full DID.', detail: 'The archive check needs the whole did:key. A fingerprint searches the board above, not the mint list.', through: meta.through, checkedAt: meta.checkedAt};
  const gotIn = Number.isInteger(mintedSweep);
  const base = {status: 'ready', gotIn, mintedSweep: gotIn ? mintedSweep : null, through: meta.through, checkedAt: meta.checkedAt, redactedTrades: meta.redactedTrades, position: null};
  if(!gotIn) return {...base, headline: 'Not in the published archive.', detail: `No published sweep through #${meta.through} lists this key as minted. The archive can lag the referee, so this is not proof the key missed registration. PnL is unknown, not zero.`};
  let detail = `This key was minted at sweep #${mintedSweep} in the published close-1 archive, through sweep #${meta.through}, checked ${meta.checkedAt}. The mint is the 10,000 POLF starting balance in those records. It is not a prize place.`;
  if(!meta.positionsReliable) return {...base, headline: 'Got in.', detail: detail + ` Position replay stopped matching published outcomes at sweep #${meta.replayStoppedAt}. No position number is shown.`};
  if(!row) detail += ' No public trade names this key. Private-room trades are redacted and do not name their keys, so an open position is not ruled out.';
  return {...base, headline: 'Got in.', detail, position: row ? positionView(row, meta) : null};
}

function positionView(row, meta){
  const signed = row.pnl.startsWith('-') ? row.pnl : `+${row.pnl}`;
  const book = row.side === 'flat' ? `Flat after ${row.settled} settled public ${row.settled === 1 ? 'trade' : 'trades'}` : `${row.side} ${row.qty}${row.entry ? ` @ ${row.entry}` : ' · mixed entries'}`;
  const caveat = meta.redactedTrades > 0 ? 'Private-room trades are redacted and are not in this figure, so it is not the referee position.' : 'Every published trade in this archive was public, and the replay matched those sweep files.';
  return {side: row.side, qty: row.qty, entry: row.entry || null, cash: row.cash, fees: row.fees, pnl: row.pnl, settled: row.settled, voids: row.voids, headline: 'Public-record position.', detail: `${book}. Cash ${row.cash} POLF · fees ${row.fees} · mark-to-market ${signed} POLF at sweep #${meta.markSweep} close ${meta.mark}. ${row.voids ? `${row.voids} voided public ${row.voids === 1 ? 'trade' : 'trades'}. ` : ''}${caveat}`};
}

export function findLine(file, key){
  if(!file || !fs.existsSync(file)) return null;
  const fd = fs.openSync(file, 'r');
  try{
    const size = fs.fstatSync(fd).size;
    if(!size) return null;
    let lo = 0, hi = size;
    while(lo < hi){
      const start = lineStart(fd, Math.floor((lo + hi) / 2));
      if(start >= size){hi = start; continue}
      const line = readLine(fd, start, size);
      if(line === null) return null;
      const found = line.split('\t', 1)[0];
      if(found === key) return line;
      if(found < key){
        const next = start + Buffer.byteLength(line) + 1;
        if(next <= lo) return null;
        lo = next;
      }else hi = start;
    }
    return null;
  }finally{fs.closeSync(fd)}
}
function lineStart(fd, pos){
  if(pos <= 0) return 0;
  const buf = Buffer.alloc(1);
  let p = pos;
  while(p > 0){
    fs.readSync(fd, buf, 0, 1, p - 1);
    if(buf[0] === 10) return p;
    p -= 1;
  }
  return 0;
}
function readLine(fd, pos, size){
  const chunks = [];
  const buf = Buffer.alloc(256);
  let at = pos;
  while(at < size){
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - at), at);
    const nl = buf.subarray(0, n).indexOf(10);
    if(nl >= 0){chunks.push(Buffer.from(buf.subarray(0, nl))); return Buffer.concat(chunks).toString('utf8')}
    chunks.push(Buffer.from(buf.subarray(0, n)));
    at += n;
    if(at - pos > 4000) return null;
  }
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
}

export function parsePosition(line){
  if(!line) return null;
  const [did, side, qty, entry, cash, fees, pnl, settled, voids] = line.split('\t');
  return {did, side, qty, entry, cash, fees, pnl, settled: Number(settled), voids: Number(voids)};
}

export function writeMintBin(tsvPath, dest){
  const text = fs.readFileSync(tsvPath);
  let count = 0;
  for(let i = 0; i < text.length; i++) if(text[i] === 10) count++;
  const body = Buffer.allocUnsafe(count * 10);
  let offset = 0, rec = 0;
  while(offset < text.length){
    const end = text.indexOf(10, offset);
    if(end < 0) break;
    const tab = text.indexOf(9, offset);
    if(tab < 0 || tab > end) throw Error('mint row has no sweep');
    const sweep = Number(text.toString('utf8', tab + 1, end));
    if(!Number.isInteger(sweep) || sweep < 1 || sweep > 65535) throw Error(`sweep out of range: ${sweep}`);
    createHash('sha256').update(text.subarray(offset, tab)).digest().copy(body, rec * 10, 0, 8);
    body.writeUInt16BE(sweep, rec * 10 + 8);
    rec++;
    offset = end + 1;
  }
  if(rec !== count) throw Error(`mint count ${rec} does not match ${count} rows`);
  const order = new Uint32Array(count);
  for(let i = 0; i < count; i++) order[i] = i;
  const before = (a, b) => {
    for(let i = 0; i < 8; i++){
      const diff = body[a * 10 + i] - body[b * 10 + i];
      if(diff) return diff;
    }
    return 0;
  };
  order.sort((a, b) => before(a, b));
  const out = Buffer.allocUnsafe(10 + count * 10);
  out.write('SCOR', 0);
  out[4] = 1;
  out[5] = 8;
  out.writeUInt32BE(count, 6);
  for(let i = 0; i < count; i++){
    const from = order[i] * 10;
    const to = 10 + i * 10;
    if(i && out.compare(body, from, from + 8, to - 10, to - 2) === 0) throw Error('mint hash collision');
    body.copy(out, to, from, from + 10);
  }
  fs.writeFileSync(dest, out);
  return count;
}
export function findMint(file, did){
  if(!file || !fs.existsSync(file)) return null;
  const fd = fs.openSync(file, 'r');
  try{
    const head = Buffer.alloc(10);
    if(fs.readSync(fd, head, 0, 10, 0) !== 10 || head.toString('utf8', 0, 4) !== 'SCOR' || head[4] !== 1 || head[5] !== 8) return undefined;
    const count = head.readUInt32BE(6);
    const key = createHash('sha256').update(did).digest().subarray(0, 8);
    const rec = Buffer.alloc(10);
    let lo = 0, hi = count;
    while(lo < hi){
      const mid = (lo + hi) >>> 1;
      if(fs.readSync(fd, rec, 0, 10, 10 + mid * 10) !== 10) return undefined;
      const cmp = rec.compare(key, 0, 8, 0, 8);
      if(cmp === 0) return rec.readUInt16BE(8);
      if(cmp < 0) lo = mid + 1; else hi = mid;
    }
    return null;
  }finally{fs.closeSync(fd)}
}
export function lookup(did, dir){
  const metaFile = path.join(dir, 'meta.json');
  if(!fs.existsSync(metaFile)) return {...pending};
  let meta;
  try{meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))}catch{return {...pending}}
  if(meta.status !== 'ready') return confirmation({did, meta});
  let mintedSweep = null;
  if(FULL_DID.test(did)){
    const bin = path.join(dir, 'minted.bin');
    if(fs.existsSync(bin)){
      const found = findMint(bin, did);
      if(found === undefined) return {...pending};
      mintedSweep = found;
    }else{
      const mintLine = findLine(path.join(dir, 'minted.tsv'), did);
      const sweep = mintLine ? Number(mintLine.split('\t')[1]) : null;
      mintedSweep = Number.isInteger(sweep) ? sweep : null;
    }
  }
  const row = FULL_DID.test(did) ? parsePosition(findLine(path.join(dir, 'positions.tsv'), did)) : null;
  return confirmation({did, meta, mintedSweep: Number.isInteger(mintedSweep) ? mintedSweep : null, row});
}
