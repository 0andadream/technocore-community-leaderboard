import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {writeMintBin} from './confirm.mjs';
import {Fold} from './fold.mjs';

const BASE = 'https://challenges.technocore.chat/close-1/';
const SEED = '226.14';
const root = process.cwd();
dns.setDefaultResultOrder('ipv4first');

function sha256(buf){return crypto.createHash('sha256').update(buf).digest('hex')}
function getOnce(url){
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, buf) => {
      if(settled) return;
      settled = true;
      clearTimeout(timer);
      if(error) reject(error); else resolve(buf);
    };
    const req = https.get(url, {family: 4, headers: {'user-agent': 'Score/1.0 (read-only close-1 archive replay)', accept: 'application/json'}}, res => {
      const code = res.statusCode || 0;
      if(code !== 200){res.resume(); done(Error(`HTTP ${code}`)); return}
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
      res.on('error', done);
    });
    const timer = setTimeout(() => req.destroy(Error('timeout')), 180_000);
    req.on('error', done);
  });
}
async function getBuf(url){
  let last;
  for(let attempt = 1; attempt <= 6; attempt++){
    try{return await getOnce(url)}
    catch(error){
      last = error;
      console.log(JSON.stringify({archive: 'retry', url, attempt, error: String(error.message || error)}));
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw Error(`${url}: ${last?.message || last}`);
}
function micro(text){
  const neg = String(text).startsWith('-');
  const [whole, frac = ''] = String(text).replace('-', '').split('.');
  if(!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac)) || frac.length > 6) return null;
  const value = BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
  return neg ? -value : value;
}
function visibleMatch(actual, published){
  const right = (published || []).filter(trade => !(trade && trade.redacted));
  if(actual.length !== right.length) return false;
  for(let i = 0; i < actual.length; i++){
    const a = actual[i], b = right[i];
    if(a.id !== b.id || a.outcome !== b.outcome) return false;
    if(a.outcome === 'void'){if(a.reason !== b.reason) return false}
    else if(micro(a.maker_fee) === null || micro(a.maker_fee) !== micro(b.maker_fee) || micro(a.taker_fee) !== micro(b.taker_fee)) return false;
  }
  return true;
}
function sortFile(src, dest){
  const sorted = spawnSync('sort', ['-t', '\t', '-k1,1', '-s', '-o', dest, src], {encoding: 'utf8', env: {...process.env, LC_ALL: 'C', LANG: 'C'}});
  if(sorted.status !== 0) throw Error(sorted.stderr || 'sort failed');
}

export async function buildArchive({dir = path.join(root, 'data', 'archive'), limit = Infinity, log = console.log} = {}){
  const next = `${dir}-next`;
  fs.rmSync(next, {recursive: true, force: true});
  fs.mkdirSync(next, {recursive: true});
  const indexBuf = await getBuf(`${BASE}index.json`);
  const indexSha = sha256(indexBuf);
  const index = JSON.parse(indexBuf.toString('utf8'));
  const sweeps = (index.sweeps || []).slice().sort((a, b) => a.n - b.n);
  if(index.contest !== 'close-1' || !sweeps.length || sweeps.some((sweep, i) => sweep.n !== i + 1)) throw Error('Archive index is not a complete close-1 sweep list');
  const ready = path.join(dir, 'meta.json');
  if(fs.existsSync(ready)){
    try{
      const prev = JSON.parse(fs.readFileSync(ready, 'utf8'));
      if(prev.status === 'ready' && prev.indexSha256 === indexSha && prev.through === sweeps.length && limit === Infinity){
        log(JSON.stringify({archive: 'unchanged', through: prev.through}));
        fs.rmSync(next, {recursive: true, force: true});
        return prev;
      }
    }catch{/* rebuild */}
  }
  const selected = sweeps.slice(0, limit);
  const fold = new Fold();
  fold.seed(SEED);
  const mintFile = path.join(next, 'minted.unsorted');
  const mintOut = fs.createWriteStream(mintFile);
  const writeLine = async (stream, line) => {if(!stream.write(line)) await new Promise(resolve => stream.once('drain', resolve))};
  let redactedTrades = 0, publicTrades = 0, minted = 0, positionsReliable = true, replayStoppedAt = null, mark = SEED, markSweep = 0;
  log(JSON.stringify({archive: 'start', sweeps: selected.length, bytes: selected.reduce((sum, sweep) => sum + (sweep.bytes || 0), 0)}));
  const inflight = new Map();
  let cursor = 0;
  const pull = () => {
    while(inflight.size < 2 && cursor < selected.length){
      const sweep = selected[cursor++];
      if(!/^(?:sweeps|redacted)\/[a-f0-9]{64}\.json$/.test(sweep.path || '')) throw Error(`Bad archive path for sweep ${sweep.n}`);
      inflight.set(sweep.n, getBuf(BASE + sweep.path).then(buf => ({sweep, buf})));
    }
  };
  pull();
  for(const listed of selected){
    let sweep, buf;
    try{({sweep, buf} = await inflight.get(listed.n))}
    catch(error){throw Error(`Sweep ${listed.n} download failed: ${error.message || error}`)}
    inflight.delete(listed.n);
    pull();
    const digest = sha256(buf);
    const expected = sweep.status === 'full' ? sweep.file : sweep.sha256;
    if(digest !== expected) throw Error(`Sweep ${sweep.n} hash ${digest} does not match the index`);
    const record = JSON.parse(buf.toString('utf8'));
    const input = record.input || {}, output = record.output || {};
    if(input.n !== sweep.n || output.sweep !== sweep.n) throw Error(`Sweep ${sweep.n} record number does not match the index`);
    for(const key of output.minted || []){
      if(typeof key !== 'string') continue;
      minted += 1;
      await writeLine(mintOut, `${key}\t${sweep.n}\n`);
    }
    redactedTrades += (input.trades || []).filter(trade => trade && trade.redacted).length;
    const result = positionsReliable ? fold.sweep(input) : null;
    if(result){
      publicTrades += result.trades.length;
      const sameMints = result.minted.length === (output.minted || []).length && result.minted.every((key, i) => key === output.minted[i]);
      const sameTrades = visibleMatch(result.trades, output.trades);
      const sameGlobal = sweep.status !== 'full' || result.global_price === output.global_price;
      if(!sameMints || !sameTrades || !sameGlobal){
        positionsReliable = false;
        replayStoppedAt = sweep.n;
        log(JSON.stringify({archive: 'replay-diverged', sweep: sweep.n, sameMints, sameTrades, sameGlobal}));
      }
    }
    mark = String(output.close || input.close || mark);
    markSweep = sweep.n;
    if(sweep.n % 50 === 0 || sweep.n === selected.length) log(JSON.stringify({archive: 'sweep', n: sweep.n, of: selected.length, mintedOwners: fold.owners.size, positionsReliable, rssMb: Math.round(process.memoryUsage().rss / 1e6)}));
  }
  await new Promise((resolve, reject) => mintOut.end(err => err ? reject(err) : resolve()));
  sortFile(mintFile, path.join(next, 'minted.tsv'));
  fs.rmSync(mintFile, {force: true});
  writeMintBin(path.join(next, 'minted.tsv'), path.join(next, 'minted.bin'));
  const posFile = path.join(next, 'positions.unsorted');
  const posOut = fs.createWriteStream(posFile);
  if(positionsReliable){
    for(const [did, acct] of fold.accounts){
      if(!acct.settled && !acct.voids) continue;
      const snap = fold.snapshot(did, mark);
      if(snap) await writeLine(posOut, [did, snap.side, snap.qty, snap.entry, snap.cash, snap.fees, snap.pnl, snap.settled, snap.voids].join('\t') + '\n');
    }
  }
  await new Promise((resolve, reject) => posOut.end(err => err ? reject(err) : resolve()));
  sortFile(posFile, path.join(next, 'positions.tsv'));
  fs.rmSync(posFile, {force: true});
  const meta = {status: 'ready', contest: 'close-1', through: selected.at(-1)?.n ?? 0, indexSweeps: sweeps.length, indexSha256: limit === Infinity ? indexSha : null, checkedAt: new Date().toISOString(), minted, publicTrades, redactedTrades, positionsReliable, replayStoppedAt, mark, markSweep, seed: SEED, source: BASE};
  fs.writeFileSync(path.join(next, 'meta.json'), JSON.stringify(meta));
  fs.rmSync(dir, {recursive: true, force: true});
  fs.renameSync(next, dir);
  log(JSON.stringify({archive: 'ready', ...meta}));
  return meta;
}

if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
  buildArchive({limit: limitArg ? Number(limitArg.slice(8)) : Infinity}).catch(error => {console.error(error); process.exit(1)});
}
