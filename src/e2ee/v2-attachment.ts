import crypto from 'node:crypto';
import path from 'node:path';

const FORMAT='voko.e2ee.attachment/2';
const TAG_SIZE=16;

export interface E2eeV2AttachmentManifest {
  format:typeof FORMAT;messageId:string;uploadId:string;url:string;cek:string;noncePrefix:string;
  chunkSize:number;chunkCount:number;plaintextSize:number;plaintextSha256:string;
  kind:'image'|'file';fileName:string;mediaType:string;width?:number;height?:number;
}

function decode(value:unknown,size:number):Buffer{
  const text=String(value||'');const bytes=Buffer.from(text,'base64url');
  if(bytes.length!==size||bytes.toString('base64url')!==text)throw new Error('E2EE_V2_ATTACHMENT_MANIFEST_INVALID');
  return bytes;
}

export function parseE2eeV2Attachment(value:string):E2eeV2AttachmentManifest{
  let row:any;try{row=JSON.parse(value);}catch{throw new Error('E2EE_V2_ATTACHMENT_MANIFEST_INVALID');}
  const fileName=path.basename(String(row?.fileName||'')).replace(/[\x00-\x1f\\/]/g,'_').slice(0,255);
  const mediaType=String(row?.mediaType||'').slice(0,255);
  if(row?.format!==FORMAT||!['image','file'].includes(row.kind)||!/^e2ee-[0-9a-f-]{36}$/.test(String(row.messageId||''))
      ||!/^[A-Za-z0-9_-]{8,128}$/.test(String(row.uploadId||''))||!fileName||!mediaType
      ||!Number.isSafeInteger(row.chunkSize)||row.chunkSize<64*1024||row.chunkSize>4*1024*1024
      ||!Number.isSafeInteger(row.chunkCount)||row.chunkCount<1
      ||!Number.isSafeInteger(row.plaintextSize)||row.plaintextSize<0||row.plaintextSize>100*1024*1024){
    throw new Error('E2EE_V2_ATTACHMENT_MANIFEST_INVALID');
  }
  decode(row.cek,32);decode(row.noncePrefix,8);decode(row.plaintextSha256,32);
  return{...row,fileName,mediaType};
}

function nonce(prefix:Buffer,index:number):Buffer{
  const value=Buffer.alloc(12);prefix.copy(value);value.writeUInt32BE(index,8);return value;
}

function aad(messageId:string,index:number,count:number):Buffer{
  return Buffer.from(`${FORMAT}\0${messageId}\0${index}\0${count}`,'utf8');
}

export function decryptE2eeV2Attachment(ciphertext:Uint8Array,manifest:E2eeV2AttachmentManifest):Buffer{
  const source=Buffer.from(ciphertext);const key=decode(manifest.cek,32);const prefix=decode(manifest.noncePrefix,8);
  const chunks:Buffer[]=[];let offset=0;
  try{
    for(let index=0;index<manifest.chunkCount;index+=1){
      const plaintextLength=index===manifest.chunkCount-1
        ?manifest.plaintextSize-index*manifest.chunkSize:manifest.chunkSize;
      const encryptedLength=plaintextLength+TAG_SIZE;
      if(offset+encryptedLength>source.length)throw new Error('E2EE_V2_ATTACHMENT_TRUNCATED');
      const encrypted=source.subarray(offset,offset+encryptedLength);
      const decipher=crypto.createDecipheriv('aes-256-gcm',key,nonce(prefix,index));
      decipher.setAAD(aad(manifest.messageId,index,manifest.chunkCount));
      decipher.setAuthTag(encrypted.subarray(encrypted.length-TAG_SIZE));
      chunks.push(Buffer.concat([decipher.update(encrypted.subarray(0,-TAG_SIZE)),decipher.final()]));
      offset+=encryptedLength;
    }
    if(offset!==source.length)throw new Error('E2EE_V2_ATTACHMENT_SIZE_MISMATCH');
    const plaintext=Buffer.concat(chunks);
    if(plaintext.length!==manifest.plaintextSize
        ||crypto.createHash('sha256').update(plaintext).digest('base64url')!==manifest.plaintextSha256){
      plaintext.fill(0);throw new Error('E2EE_V2_ATTACHMENT_HASH_MISMATCH');
    }
    return plaintext;
  }finally{key.fill(0);}
}

module.exports={parseE2eeV2Attachment,decryptE2eeV2Attachment};
