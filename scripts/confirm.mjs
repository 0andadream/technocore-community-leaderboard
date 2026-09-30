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

export function lookup(did, dir){
  const metaFile = path.join(dir, 'meta.json');
  if(!fs.existsSync(metaFile)) return {...pending};
  let meta;
  try{meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))}catch{return {...pending}}
  if(meta.status !== 'ready') return confirmation({did, meta});
  const mintLine = FULL_DID.test(did) ? findLine(path.join(dir, 'minted.tsv'), did) : null;
  const mintedSweep = mintLine ? Number(mintLine.split('\t')[1]) : null;
  const row = mintLine || FULL_DID.test(did) ? parsePosition(findLine(path.join(dir, 'positions.tsv'), did)) : null;
  return confirmation({did, meta, mintedSweep: Number.isInteger(mintedSweep) ? mintedSweep : null, row});
}
