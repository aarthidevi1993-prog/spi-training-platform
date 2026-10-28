// Test-only PDF writer: real PDF files for the Phase G tests (no packages).
// Text pages in Helvetica (WinAnsi), optional FlateDecode, optional RC4 encryption
// (standard security handler, revision 2), and image-only "scanned" pages.
import { createHash } from "node:crypto";
import zlib from "node:zlib";

const WIN_ANSI = { "—": 0x97, "–": 0x96, "•": 0x95, "’": 0x92, "‘": 0x91, "“": 0x93, "”": 0x94, "€": 0x80 };

function winAnsi(text) {
  const out = [];
  for (const ch of text) {
    const code = WIN_ANSI[ch] ?? ch.codePointAt(0);
    if (code > 0xff) throw new Error(`pdf-writer: character not in WinAnsi: ${ch}`);
    out.push(code);
  }
  return Buffer.from(out);
}

function pdfString(text) {
  const bytes = winAnsi(text);
  let s = "(";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += "\\" + String.fromCharCode(b);
    else if (b < 0x20 || b > 0x7e) s += "\\" + b.toString(8).padStart(3, "0");
    else s += String.fromCharCode(b);
  }
  return s + ")";
}

// --- RC4 / standard security handler (R2, 40-bit) ---------------------------
const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
const md5 = (...parts) => createHash("md5").update(Buffer.concat(parts)).digest();
function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}
const padPw = (pw) => Buffer.concat([Buffer.from(pw, "latin1"), PAD]).subarray(0, 32);

/**
 * pages: array of pages; each page is { lines: string[] } (text) or { image: true } (scanned).
 * Options: compress, encrypt ({ user, owner }), fontSize, lineGap, x (left margin), columns (second column lines).
 */
export function makePdf(pages, { compress = false, encrypt = null, fontSize = 11, lineGap = 14 } = {}) {
  const objects = []; // index = object number - 1
  const add = (build) => {
    objects.push(build);
    return objects.length;
  };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add(() => "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pageRefs = [];
  for (const page of pages) {
    let content;
    let resources;
    if (page.image) {
      const img = add({ stream: Buffer.alloc(64 * 64, 0x80), dict: "/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 8" });
      content = "q 400 0 0 400 100 300 cm /Im1 Do Q";
      resources = `<< /XObject << /Im1 ${img} 0 R >> >>`;
    } else {
      const parts = [`BT /F1 ${fontSize} Tf ${lineGap} TL`];
      let y = 780;
      for (const line of page.lines) {
        const segments = Array.isArray(line) ? line : [[72, line]];
        for (const [x, text] of segments) parts.push(`1 0 0 1 ${x} ${y} Tm ${pdfString(text)} Tj`);
        y -= lineGap;
      }
      parts.push("ET");
      content = parts.join("\n");
      resources = `<< /Font << /F1 ${font} 0 R >> >>`;
    }
    const contentObj = add({ stream: Buffer.from(content, "latin1") });
    pageRefs.push(add(() => `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources ${resources} /Contents ${contentObj} 0 R >>`));
  }
  objects[catalog - 1] = () => `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = () => `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(" ")}] /Count ${pageRefs.length} >>`;

  const id = createHash("md5").update(JSON.stringify(pages)).digest();
  let fileKey = null;
  let encryptObj = null;
  if (encrypt) {
    const P = -44;
    const pBytes = Buffer.alloc(4);
    pBytes.writeInt32LE(P);
    const O = rc4(md5(padPw(encrypt.owner || encrypt.user)).subarray(0, 5), padPw(encrypt.user));
    fileKey = md5(padPw(encrypt.user), O, pBytes, id).subarray(0, 5);
    const U = rc4(fileKey, PAD);
    encryptObj = add(() => `<< /Filter /Standard /V 1 /R 2 /O <${O.toString("hex")}> /U <${U.toString("hex")}> /P ${P} >>`);
  }

  const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((obj, i) => {
    const num = i + 1;
    offsets.push(offset);
    let body;
    if (typeof obj === "function") {
      body = Buffer.from(`${num} 0 obj\n${obj()}\nendobj\n`, "latin1");
    } else {
      let data = obj.stream;
      let dict = obj.dict ?? "";
      if (compress) {
        data = zlib.deflateSync(data);
        dict += " /Filter /FlateDecode";
      }
      if (fileKey && num !== encryptObj) {
        const objKey = md5(fileKey, Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, 0, 0])).subarray(0, 10);
        data = rc4(objKey, data);
      }
      body = Buffer.concat([Buffer.from(`${num} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1")]);
    }
    chunks.push(body);
    offset += body.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>]${encryptObj ? ` /Encrypt ${encryptObj} 0 R` : ""} >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}

/** One page of lines. */
export const pdfOf = (lines, options) => makePdf([{ lines }], options);
