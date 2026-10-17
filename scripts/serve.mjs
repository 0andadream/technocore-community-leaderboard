import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {lookup} from './confirm.mjs';

const root = process.cwd();
const dist = path.join(root, 'dist');
const api = path.join(root, 'public', 'api');
const port = Number(process.env.PORT || 3000);
const MAINTENANCE = process.env.MAINTENANCE !== '0';
const maintenanceBody = JSON.stringify({maintenance: true, headline: 'Score is down for maintenance.', detail: 'The signed referee feeds are not publishing one shared sweep, so the board and the DID check are offline.'});
const maintenancePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Score is down for maintenance."><link rel="icon" href="/score-logo.jpg"><title>Score · Maintenance</title><style>
:root{font-family:Inter,Arial,sans-serif;color:#d5dce0;background:#0b0e11}*{box-sizing:border-box}body{margin:0}a{color:#6dd8f5}
header{height:88px;display:flex;align-items:center;gap:16px;padding:0 4%;border-bottom:1px solid #262c31}.brand{display:flex;align-items:center;gap:14px;font-size:14px;font-weight:700;letter-spacing:.03em;color:#d5dce0;text-decoration:none}.logo{width:44px;height:44px;border-radius:10px;background:#000}
main{max-width:720px;padding:48px 6% 32px}h1{font-size:clamp(32px,5vw,44px);font-weight:500;letter-spacing:-.04em;color:#eff2f3;margin:0 0 12px}p{color:#919ca3;line-height:1.7;font-size:16px}
footer{margin-top:48px;padding-top:20px;border-top:1px solid #29353c;font-size:12px;color:#72818a}footer a{text-underline-offset:3px}
@media(max-width:650px){header{height:auto;padding:18px 16px}main{padding:32px 16px 24px}}
</style></head><body><header><a class="brand" href="/"><img class="logo" src="/score-logo.jpg" alt=""><span>SCORE</span></a></header><main><h1>Down for maintenance.</h1><p>The signed referee feeds are not publishing one shared sweep, so the board and the DID check are offline.</p><footer>made with ❤️ <a href="https://x.com/mattdreams?s=20">matt</a></footer></main></body></html>`;
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8','.webp':'image/webp'};

function resolveInside(dir, rel){
  const file = path.resolve(dir, rel);
  if(file !== dir && !file.startsWith(dir + path.sep)) return null;
  return file;
}
function existing(file){
  if(!file) return null;
  try{return fs.statSync(file).isFile() ? file : null}catch{return null}
}
function send(res, file){
  const ext = path.extname(file);
  res.writeHead(200, {'content-type': types[ext] || 'application/octet-stream', 'cache-control': ext === '.json' ? 'public, max-age=60' : 'public, max-age=300', 'access-control-allow-origin': '*'});
  fs.createReadStream(file).pipe(res);
}

let crawling = false, archiving = false, archiveTries = 0;
function crawl(){
  if(crawling) return;
  crawling = true;
  const child = spawn(process.execPath, ['scripts/crawl.mjs'], {cwd: root, stdio: 'inherit'});
  child.on('exit', code => {crawling = false; console.log(JSON.stringify({crawl: code === 0 ? 'ok' : 'failed', code}))});
}
function archive(){
  if(archiving) return;
  archiving = true;
  const child = spawn(process.execPath, ['scripts/archive.mjs'], {cwd: root, stdio: 'inherit'});
  child.on('exit', code => {
    archiving = false;
    console.log(JSON.stringify({archive: code === 0 ? 'ok' : 'failed', code}));
    if(code === 0) archiveTries = 0;
    else if(archiveTries < 6){archiveTries += 1; setTimeout(archive, 20_000 * archiveTries)}
  });
}
function dailyArchive(){
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 45, 0, 0));
  if(next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => {archive(); setInterval(archive, 24 * 60 * 60 * 1000)}, next - now);
}
if(process.env.SKIP_JOBS !== '1' && !MAINTENANCE){
  setTimeout(crawl, 1500);
  setInterval(crawl, 10 * 60 * 1000);
  setTimeout(archive, 2000);
  dailyArchive();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  if(MAINTENANCE){
    if(pathname === '/score-logo.jpg'){
      const logo = existing(path.join(root, 'public', 'score-logo.jpg')) || existing(path.join(dist, 'score-logo.jpg'));
      if(logo){send(res, logo); return}
    }
    if(pathname.startsWith('/api/')){
      res.writeHead(503, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*'});
      res.end(maintenanceBody);
      return;
    }
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
    res.end(maintenancePage);
    return;
  }
  if(pathname === '/api/confirm'){
    const body = JSON.stringify(lookup(url.searchParams.get('did') || '', path.join(root, 'data', 'archive')));
    res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*'});
    res.end(body);
    return;
  }
  if(pathname.startsWith('/api/')){
    const rel = pathname.slice(5);
    const file = existing(resolveInside(api, rel)) || existing(resolveInside(path.join(dist, 'api'), rel));
    if(!file){res.writeHead(404, {'content-type':'text/plain; charset=utf-8'}); res.end('Not found in this snapshot'); return}
    send(res, file); return;
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const file = existing(resolveInside(dist, rel)) || existing(resolveInside(dist, path.join(rel, 'index.html'))) || existing(path.join(dist, 'index.html'));
  if(!file){res.writeHead(404); res.end('Not found'); return}
  send(res, file);
});
server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({score: true, port})));
