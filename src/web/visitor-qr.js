'use strict';

const { oss } = require('../endpoints.json');
const ICON_ORIGINS = new Set([oss.endpoint, oss.publicUrl].map(value => new URL(value).origin));
const MAX_ICON_BYTES = 500 * 1024;

// Only saved public Agent icons from our storage may be read by the server.
// Custom image URLs still load directly in the browser, without a URL proxy.
function officialVisitorQrIconUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !ICON_ORIGINS.has(url.origin)
      || url.username || url.password || url.search || url.hash
      || !/^\/(?:public\/agent_icon|agent-icons)\/[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp|gif)$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

async function readVisitorQrIcon(value, fetchIcon = globalThis.fetch) {
  const url = officialVisitorQrIconUrl(value);
  if (!url) throw new Error('Unsupported Agent icon URL');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchIcon(url, { redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_ICON_BYTES) {
      throw new Error('Agent icon unavailable');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_ICON_BYTES) throw new Error('Agent icon too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Compose in the browser, using a same-origin source for official uploads.
function visitorQrScript() {
  return `<script>(async function(){
    var preview=document.getElementById('visitor-qr-image'),download=document.getElementById('visitor-qr-download'),error=document.getElementById('visitor-qr-error');
    function load(src){return new Promise(function(resolve,reject){var img=new Image(),timer=setTimeout(function(){img.onload=img.onerror=null;img.src='';reject(new Error('Image load timed out'))},10000);img.crossOrigin='anonymous';img.onload=function(){clearTimeout(timer);resolve(img)};img.onerror=function(){clearTimeout(timer);reject(new Error('Image load failed'))};img.src=src})}
    try{
      var images=await Promise.all([load(preview.dataset.qr),load(preview.dataset.icon)]);
      var canvas=document.createElement('canvas');canvas.width=canvas.height=768;
      var ctx=canvas.getContext('2d');ctx.drawImage(images[0],0,0,768,768);
      // A small white frame separates the avatar from modules; H correction
      // leaves room for this central overlay while retaining the quiet zone.
      var size=128,padding=10,start=(768-size)/2;
      ctx.fillStyle='#fff';ctx.beginPath();ctx.roundRect(start-padding,start-padding,size+padding*2,size+padding*2,18);ctx.fill();
      ctx.save();ctx.beginPath();ctx.roundRect(start,start,size,size,10);ctx.clip();
      var icon=images[1],crop=Math.min(icon.naturalWidth,icon.naturalHeight);
      ctx.drawImage(icon,(icon.naturalWidth-crop)/2,(icon.naturalHeight-crop)/2,crop,crop,start,start,size,size);ctx.restore();
      var result=canvas.toDataURL('image/png');preview.src=result;preview.hidden=false;download.href=result;download.hidden=false;
    }catch(e){error.hidden=false}
  })();</script>`;
}
module.exports={visitorQrScript,officialVisitorQrIconUrl,readVisitorQrIcon};
