import {readdir,readFile,writeFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../dist/',import.meta.url));
async function walk(dir){const out=[];for(const entry of await readdir(dir,{withFileTypes:true})){const absolute=path.join(dir,entry.name);if(entry.isDirectory())out.push(...await walk(absolute));else out.push(absolute);}return out;}
const files=(await walk(root)).filter(p=>!['sw.js','offline-manifest.json'].includes(path.basename(p))&&!p.endsWith('.map')&&!p.endsWith('.pmtiles')).sort();
const hash=createHash('sha256');let bytes=0;
for(const file of files){const data=await readFile(file);hash.update(path.relative(root,file).replaceAll('\\','/'));hash.update(data);bytes+=data.length;}
const version=hash.digest('hex').slice(0,20),precache=files.map(p=>'./'+path.relative(root,p).replaceAll('\\','/'));
const template=await readFile(fileURLToPath(new URL('../public/sw.js',import.meta.url)),'utf8');
await writeFile(path.join(root,'sw.js'),template.replace('__BUILD_VERSION__',version).replace('/*__PRECACHE__*/[]',JSON.stringify(precache)));
await writeFile(path.join(root,'offline-manifest.json'),JSON.stringify({version,bytes,files:precache},null,2)+'\n');
console.log(`Offline shell: ${precache.length} exact assets, ${(bytes/1024/1024).toFixed(2)} MB, version ${version}. No external tiles or map archives cached.`);
