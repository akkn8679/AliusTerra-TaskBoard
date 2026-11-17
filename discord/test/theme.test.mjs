import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const script=readFileSync(new URL('../../theme.js',import.meta.url),'utf8');
function fixture(saved=null,{blocked=false,loading=false}={}){
  const listeners={},documentListeners={},writes=[];
  const button={textContent:'',attributes:{},events:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,fn){this.events[k]=fn;}};
  const document={documentElement:{dataset:{}},readyState:loading?'loading':'complete',getElementById:()=>loading?null:button,addEventListener(name,fn){documentListeners[name]=fn;}};
  vm.runInContext(script,vm.createContext({document,window:{addEventListener(name,fn){listeners[name]=fn;}},
    localStorage:{getItem(){if(blocked)throw new Error('storage blocked');return saved;},setItem(k,v){if(blocked)throw new Error('storage blocked');writes.push([k,v]);}}}));
  return {document,button,listeners,writes,ready(){document.getElementById=()=>button;documentListeners.DOMContentLoaded();}};
}
test('theme defaults to light and restores dark before body parsing',()=>{
  const light=fixture();assert.equal(light.document.documentElement.dataset.theme,'light');assert.equal(light.button.attributes['aria-label'],'ダークモードに切り替え');assert.equal(light.writes.length,0);
  const dark=fixture('dark',{loading:true});assert.equal(dark.document.documentElement.dataset.theme,'dark');assert.equal(dark.button.events.click,undefined);dark.ready();assert.equal(dark.button.attributes['aria-pressed'],'true');
});
test('theme toggle stores an Alius-only preference and another tab follows without a write loop',()=>{
  const f=fixture();f.button.events.click();assert.deepEqual(f.writes,[['aliusTerraTaskBoard.theme.v1','dark']]);
  f.listeners.storage({key:'aliusTerraTaskBoard.theme.v1',newValue:'light'});assert.equal(f.document.documentElement.dataset.theme,'light');assert.equal(f.writes.length,1);
  f.listeners.storage({key:'roverTaskBoard.theme.v1',newValue:'dark'});assert.equal(f.document.documentElement.dataset.theme,'light');
});
test('blocked local storage permits theme changes without network or board mutations',()=>{
  const f=fixture(null,{blocked:true});assert.doesNotThrow(()=>f.button.events.click());assert.equal(f.document.documentElement.dataset.theme,'dark');
  assert.ok(!/firebase|boardRef|render\(|fetch\(|innerHTML/.test(script));
});
