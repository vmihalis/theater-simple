import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {WebSocketServer} from 'ws';
import {attachSoniox} from './lib/soniox.mjs';
import {preparePowerPoint} from './lib/powerpoint.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const PORT=Number(process.env.THEATER_PORT||43120);
if(!Number.isInteger(PORT)||PORT<1024||PORT>65535)throw new Error('Invalid local port.');
const dataRoot=path.resolve(process.env.THEATER_DATA_DIR||path.join(root,'data'));
const uploads=path.join(dataRoot,'uploads');
const prepared=path.join(dataRoot,'prepared');
fs.mkdirSync(uploads,{recursive:true});
fs.mkdirSync(prepared,{recursive:true});
const preparing=new Map();
const configPath=path.join(dataRoot,'settings.json');
const config=fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,'utf8')):{targetLanguage:'ja',sourceLanguages:['en'],captionEnabled:true,files:[]};
config.files=Array.isArray(config.files)?config.files.filter(f=>f&&typeof f.id==='string'&&typeof f.filename==='string'&&path.basename(f.filename)===f.filename):[];
const save=()=>fs.writeFileSync(configPath,JSON.stringify(config,null,2));
save();
let apiKey='',activeAudio=null;
const emptyText=()=>({original:'',translation:'',originalFinal:'',translationFinal:'',originalPartial:'',translationPartial:'',updatedAt:null});
let captions={...emptyText(),status:'idle',enabled:config.captionEnabled!==false,error:null};
const events=new Set();
const publicFile=f=>({id:f.id,name:f.name,type:f.type,url:`/files/${encodeURIComponent(f.id)}`});
const state=()=>({app:'theater-simple',captions:{...captions,hasKey:!!apiKey},settings:{targetLanguage:config.targetLanguage,sourceLanguages:config.sourceLanguages},files:config.files.map(publicFile)});
function broadcast(){const value=`event: state\ndata: ${JSON.stringify(state())}\n\n`;for(const response of events)response.write(value);}
function json(response,value,status=200){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(value));}
function local(req){const readOnly=['GET','HEAD'].includes(req.method)&&!req.headers.upgrade;return ['127.0.0.1:'+PORT,'localhost:'+PORT].includes(req.headers.host)&&(!req.headers.origin||['http://127.0.0.1:'+PORT,'http://localhost:'+PORT].includes(req.headers.origin))&&(readOnly||req.headers['sec-fetch-site']!=='cross-site');}
async function body(req,max=65536){if(Number(req.headers['content-length'])>max)throw new Error('File or request is too large.');const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)throw new Error('File or request is too large.');chunks.push(chunk);}return Buffer.concat(chunks);}
async function payload(req){if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new Error('JSON request required.');const value=JSON.parse((await body(req)).toString());if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid request.');return value;}
const aliases={'/':'index.html','/stage':'stage.html','/demo':'demo.html'};
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.wasm':'application/wasm'};
const allowedExtensions=new Set(['.pdf','.ppt','.pptx','.pps','.ppsx']);
const ole=Buffer.from('d0cf11e0a1b11ae1','hex');
function validFile(data,extension){if(extension==='.pdf')return data.subarray(0,1024).includes(Buffer.from('%PDF-'));if(['.pptx','.ppsx'].includes(extension))return data.subarray(0,4).equals(Buffer.from([80,75,3,4]));return data.subarray(0,8).equals(ole);}
function sendFile(req,res,file,type,extra={}){
  const size=fs.statSync(file).size;let start=0,end=size-1,status=200;
  if(req.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}
    if(!match[1])start=Math.max(0,size-Number(match[2]));else start=Number(match[1]);
    if(match[1]&&match[2])end=Math.min(end,Number(match[2]));
    if(start<0||start>=size||end<start){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}status=206;
  }
  res.writeHead(status,{'Content-Type':type,'Content-Length':Math.max(0,end-start+1),'Accept-Ranges':'bytes','Cache-Control':'no-store',...(status===206?{'Content-Range':`bytes ${start}-${end}/${size}`} : {}),...extra});
  if(req.method==='HEAD'||!size)return res.end();
  const stream=fs.createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  try{
    if(!local(req))return json(res,{error:'Local access only.'},403);
    const url=new URL(req.url,`http://127.0.0.1:${PORT}`);
    if(req.method==='GET'&&url.pathname==='/api/state')return json(res,state());
    if(req.method==='GET'&&url.pathname==='/events'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
      res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);events.add(res);req.on('close',()=>events.delete(res));return;
    }
    if(req.method==='POST'&&url.pathname==='/api/upload'){
      if(!String(req.headers['content-type']||'').startsWith('application/octet-stream'))throw new Error('Send the presentation file as binary data.');
      const name=path.win32.basename(url.searchParams.get('name')||'presentation').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,150);
      const extension=path.extname(name).toLowerCase();if(!allowedExtensions.has(extension))throw new Error('Choose a PDF or PowerPoint file. Use Open website for websites.');
      const data=await body(req,150*1024*1024);if(!validFile(data,extension))throw new Error('This file does not match its PDF or PowerPoint extension.');
      const id=randomUUID(),file={id,name,type:extension==='.pdf'?'pdf':'powerpoint',filename:id+extension};
      fs.writeFileSync(path.join(uploads,file.filename),data,{flag:'wx'});config.files.push(file);save();broadcast();return json(res,{file:publicFile(file)});
    }
    if(req.method==='POST'&&url.pathname.startsWith('/api/')){
      const data=await payload(req);
      switch(url.pathname){
        case '/api/prepare-file': {
          const file=config.files.find(f=>f.id===data.id);
          if(!file||!fs.existsSync(path.join(uploads,file.filename)))throw new Error('Presentation not found. Choose the file again.');
          if(file.type==='pdf')return json(res,{file:{...publicFile(file),presentationUrl:`/files/${encodeURIComponent(file.id)}`}});
          const outputPath=path.join(prepared,file.id+'.pdf');
          if(!fs.existsSync(outputPath)) {
            if(!preparing.has(file.id)) {
              const job=preparePowerPoint({inputPath:path.join(uploads,file.filename),outputPath}).finally(()=>preparing.delete(file.id));
              preparing.set(file.id,job);
            }
            await preparing.get(file.id);
          }
          return json(res,{file:{...publicFile(file),presentationUrl:`/slides/${encodeURIComponent(file.id)}`}});
        }
        case '/api/open-desktop': {
          const macApp=path.resolve(root,'../../..');
          const isMacBundle=process.platform==='darwin'&&macApp.endsWith('.app')&&fs.existsSync(path.join(macApp,'Contents','Info.plist'));
          const executable=isMacBundle?'/usr/bin/open':path.join(root,'runtime','electron','electron.exe');
          if(!fs.existsSync(executable))throw new Error('Open the Theater Simple desktop package to show websites automatically.');
          const child=spawn(executable,isMacBundle?['-a',macApp]:[path.join(root,'desktop')],{cwd:root,windowsHide:true,detached:true,stdio:'ignore'});
          await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new Error('The desktop app could not open. Run Start Theater.cmd.')));});
          child.unref();break;
        }
        case '/api/caption-key':
          if(typeof data.key!=='string'||data.key.trim().length<1||data.key.length>2048)throw new Error('Enter a Soniox API key.');
          if(activeAudio)throw new Error('Stop captions before changing the key.');apiKey=data.key.trim();break;
        case '/api/caption-settings':
          if(activeAudio)throw new Error('Stop captions before changing languages.');
          if(!/^[a-z]{2,3}$/.test(data.targetLanguage||'')||!Array.isArray(data.sourceLanguages)||data.sourceLanguages.length>12||data.sourceLanguages.some(x=>typeof x!=='string'||!/^[a-z]{2,3}$/.test(x)))throw new Error('Use language codes such as en and ja.');
          config.targetLanguage=data.targetLanguage;config.sourceLanguages=[...new Set(data.sourceLanguages)];save();break;
        case '/api/caption-test':
          if(activeAudio)throw new Error('Stop live captions before playing test captions.');
          captions={...captions,...emptyText(),translation:String(data.text||'Welcome to the theater. ようこそ。').slice(0,500),updatedAt:Date.now(),status:'test',error:null};break;
        case '/api/caption-clear':activeAudio?.clear();captions={...captions,...emptyText(),updatedAt:Date.now()};break;
        case '/api/captions-visible':captions.enabled=!!data.enabled;config.captionEnabled=captions.enabled;save();break;
        case '/api/open-file':{
          const file=config.files.find(f=>f.id===data.id);if(!file||!fs.existsSync(path.join(uploads,file.filename)))throw new Error('Presentation not found. Add the file again.');
          if(file.type==='pdf')throw new Error('Open this PDF using its browser link.');
          await new Promise((resolve,reject)=>{
            const mac=process.platform==='darwin';
            const child=mac?spawn('/usr/bin/open',['-a','Microsoft PowerPoint',path.join(uploads,file.filename)]):spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'open-presentation.ps1'),'-PresentationPath',path.join(uploads,file.filename)],{windowsHide:true});
            const timeout=setTimeout(()=>{child.kill();reject(new Error('PowerPoint did not open in time. Open the file manually, then choose its window.'));},25000);
            child.on('error',()=>{clearTimeout(timeout);reject(new Error('Cannot open PowerPoint. Install and activate PowerPoint, or open the file in your presentation app.'));});
            child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(new Error('PowerPoint could not open the deck. Check that PowerPoint is installed and activated, or open the file manually.'));});
          });break;
        }
        default:return json(res,{error:'Unknown action.'},404);
      }
      broadcast();return json(res,{ok:true,state:state()});
    }
    if(!['GET','HEAD'].includes(req.method))return json(res,{error:'Method not allowed.'},405);
    if(url.pathname.startsWith('/slides/')){
      const id=url.pathname.slice('/slides/'.length);
      const file=config.files.find(f=>f.id===id&&f.type==='powerpoint');
      const converted=file?path.join(prepared,file.id+'.pdf'):null;
      if(!converted||!fs.existsSync(converted))return json(res,{error:'Prepare this PowerPoint first.'},404);
      return sendFile(req,res,converted,'application/pdf',{'Content-Disposition':'inline'});
    }
    if(url.pathname.startsWith('/files/')){
      const file=config.files.find(f=>f.id===url.pathname.slice('/files/'.length));
      if(!file||!fs.existsSync(path.join(uploads,file.filename)))return json(res,{error:'Presentation not found.'},404);
      const type=file.type==='pdf'?'application/pdf':'application/octet-stream';
      return sendFile(req,res,path.join(uploads,file.filename),type,{'Content-Disposition':`${file.type==='pdf'?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`});
    }
    const name=aliases[url.pathname]||decodeURIComponent(url.pathname.slice(1));
    const file=path.resolve(root,'public',name),publicRoot=path.resolve(root,'public')+path.sep;
    if(!file.startsWith(publicRoot)||!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,{error:'Not found.'},404);
    return sendFile(req,res,file,types[path.extname(file)]||'application/octet-stream');
  }catch(error){if(!res.headersSent)json(res,{error:error instanceof SyntaxError?'Invalid JSON request.':error.message},400);else res.destroy();}
});
const wss=new WebSocketServer({noServer:true,maxPayload:1048576});
server.on('upgrade',(req,socket,head)=>{
  if(!local(req)||req.url!=='/audio'){socket.destroy();return;}
  if(activeAudio){socket.end('HTTP/1.1 409 Conflict\r\n\r\n');return;}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
});
wss.on('connection',ws=>{
  activeAudio=attachSoniox(ws,{getApiKey:()=>apiKey,onCaption:value=>{captions={...captions,...value};broadcast();},onStatus:value=>{captions.status=value.state;captions.error=value.state==='error'?value.message:null;broadcast();}});
  ws.on('close',()=>{activeAudio=null;if(captions.status!=='error')captions.status='stopped';broadcast();});
});
const heartbeat=setInterval(()=>{for(const res of events)res.write(': keepalive\n\n');},15000);heartbeat.unref();
function shutdown(){clearInterval(heartbeat);activeAudio?.close();for(const ws of wss.clients)ws.terminate();for(const res of events)res.end();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
server.listen(PORT,'127.0.0.1',()=>console.log(`Theater Simple: http://127.0.0.1:${PORT}`));
