'use strict';

// Compose in the browser so remote Agent icons never trigger server-side requests.
function visitorQrScript() {
  return `<script>(async function(){
    var preview=document.getElementById('visitor-qr-image'),download=document.getElementById('visitor-qr-download'),error=document.getElementById('visitor-qr-error');
    function load(src){return new Promise(function(resolve,reject){var img=new Image();img.crossOrigin='anonymous';img.onload=function(){resolve(img)};img.onerror=reject;img.src=src})}
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
module.exports={visitorQrScript};
