import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {lookup} from './confirm.mjs';

const root = process.cwd();
const dist = path.join(root, 'dist');
const api = path.join(root, 'public', 'api');
const port = Number(process.env.PORT || 3000);
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

let crawling = false, archiving = false;
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
  child.on('exit', code => {archiving = false; console.log(JSON.stringify({archive: code === 0 ? 'ok' : 'failed', code}))});
}
function dailyArchive(){
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 45, 0, 0));
  if(next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => {archive(); setInterval(archive, 24 * 60 * 60 * 1000)}, next - now);
}
if(process.env.SKIP_JOBS !== '1'){
  setTimeout(crawl, 1500);
  setInterval(crawl, 10 * 60 * 1000);
  setTimeout(archive, 2000);
  dailyArchive();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
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
