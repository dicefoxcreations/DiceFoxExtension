/* Read passive resources already loaded by Chrome. This avoids re-requesting
   authenticated CDN assets from a different extension/network context. */
(() => {
  "use strict";
  function headers(text) {
    const result = {};
    for (const line of text.replace(/\r?\n[ \t]+/g," ").split(/\r?\n/)) {
      const colon=line.indexOf(":");
      if(colon>0)result[line.slice(0,colon).toLowerCase()]=line.slice(colon+1).trim();
    }
    return result;
  }
  function rawBytes(raw) {
    const bytes=new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    return bytes;
  }
  function decode(body, encoding) {
    if (encoding === "base64") return rawBytes(atob(body.replace(/\s/g,"")));
    if (encoding === "quoted-printable") {
      const raw=body.replace(/=\r?\n/g,"").replace(/=([a-f0-9]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
      return rawBytes(raw);
    }
    return rawBytes(body);
  }
  // Keep only one bounded MIME resource in memory. In particular, the HTML
  // parts are skipped without decoding/copying the complete page snapshot.
  async function forEach(blob, visit, {maxResourceBytes = 6 * 1024 * 1024, stopped = () => false} = {}) {
    const CHUNK = 65536, HEADER_LIMIT = 65536;
    let offset = 0, buffer = "", eof = false;
    async function more() {
      if (stopped()) throw new Error("Resource extraction deadline exceeded");
      if (offset >= blob.size) { eof = true; return; }
      const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
      offset += bytes.length;
      // Latin-1 byte preservation, including 0x80..0x9f (not Windows-1252).
      for (let i=0;i<bytes.length;i+=8192) buffer += String.fromCharCode(...bytes.subarray(i,i+8192));
    }
    async function header() {
      for (;;) {
        const sep = /\r?\n\r?\n/.exec(buffer);
        if (sep) { const out=headers(buffer.slice(0,sep.index));buffer=buffer.slice(sep.index+sep[0].length);return out; }
        if (buffer.length > HEADER_LIMIT || eof) throw new Error("Invalid MHTML headers");
        await more();
      }
    }
    const head = await header();
    const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(head["content-type"]||"");
    if (!match) throw new Error("MHTML boundary missing");
    const boundary = `--${match[1]||match[2]}`, delimiter = `\n${boundary}`;
    // Discard the MIME preamble, preserving a marker crossing a chunk edge.
    while (!buffer.includes(boundary)) {
      if (eof) throw new Error("MHTML opening boundary missing");
      buffer=buffer.slice(-boundary.length);await more();
    }
    buffer=buffer.slice(buffer.indexOf(boundary)+boundary.length);
    for (;;) {
      if (stopped()) throw new Error("Resource extraction deadline exceeded");
      while (buffer.length<2 && !eof) await more();
      if (buffer.startsWith("--")) return;
      if (!/^\r?\n/.test(buffer)) throw new Error("Invalid MHTML boundary");
      buffer=buffer.replace(/^\r?\n/,"");
      const meta=await header(),type=(meta["content-type"]||"").split(";")[0].trim().toLowerCase(),url=meta["content-location"];
      let keep=Boolean(url && /^https?:\/\//i.test(url) && /^(text\/css|image\/|font\/|application\/(?:font-|x-font-|vnd.ms-fontobject))/.test(type));
      const pieces=[];let length=0;
      const append=text=>{
        if (!keep) return;
        length+=text.length;
        // Quoted-printable is at most three encoded bytes per decoded byte.
        if(length>maxResourceBytes*3+4096){keep=false;pieces.length=0;}else pieces.push(text);
      };
      for (;;) {
        const end=buffer.indexOf(delimiter);
        if(end>=0){append(buffer.slice(0,end));buffer=buffer.slice(end+delimiter.length);break;}
        if(eof)throw new Error("Incomplete MHTML resource");
        const consumed=Math.max(0,buffer.length-delimiter.length-2);
        append(buffer.slice(0,consumed));buffer=buffer.slice(consumed);await more();
      }
      if(keep){
        let resource;
        try {
          const bytes=decode(pieces.join("").replace(/\r$/, ""),(meta["content-transfer-encoding"]||"").toLowerCase());
          if(bytes.length<=maxResourceBytes)resource={url,type,blob:new Blob([bytes],{type})};
        } catch { /* malformed resource is reported as missing by the builder */ }
        if(resource)await visit(resource); // Await persistence before reading the next part.
      }
    }
  }
  async function read(blob, options) {
    const out=[];await forEach(blob,resource=>{out.push(resource);},options);return out;
  }
  globalThis.LWLMhtmlResources=Object.freeze({read,forEach});
})();
