import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";

// Input is an inherited, already-authorized file descriptor. No filenames, URLs,
// shell commands, external document links or macros are executed by the worker.
const [extension = "", pageArg = "1", offsetArg = "0", lengthArg = "32000"] = process.argv.slice(2);
const page = Number(pageArg), offset = Number(offsetArg), length = Number(lengthArg);
console.log = console.info = console.warn = () => undefined;
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", removeNSPrefix: true,
  parseTagValue: false, parseAttributeValue: false, processEntities: false });
const orderedParser = new XMLParser({ preserveOrder: true, ignoreAttributes: true, removeNSPrefix: true,
  parseTagValue: false, processEntities: false });
function xml(source: string, ordered = false): any {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("XML_DTD_UNSUPPORTED");
  return (ordered ? orderedParser : xmlParser).parse(source);
}
function entities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, k: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[k]!);
}
function arr<T>(x: T | T[] | undefined): T[] { return x === undefined ? [] : Array.isArray(x) ? x : [x]; }
function richText(nodes: any): string {
  if (typeof nodes === "string" || typeof nodes === "number") return entities(String(nodes));
  if (Array.isArray(nodes)) return nodes.map(richText).join("");
  if (!nodes || typeof nodes !== "object") return "";
  let out = "";
  for (const [key, value] of Object.entries(nodes)) {
    if (key === "#text") out += entities(String(value));
    else if (key === "tab") out += "\t";
    else if (key === "br" || key === "cr") out += "\n";
    else if (!key.startsWith("@") && key !== ":@") out += richText(value) + (key === "p" || key === "tr" ? "\n" : "");
  }
  return out;
}
function spreadsheetText(root: any, shared: string[]): string {
  const rows = arr<any>(root.worksheet?.sheetData?.row);
  return rows.map(row => arr<any>(row.c).map(cell => {
    const raw = String(cell.v ?? "");
    const value = cell["@t"] === "s" ? shared[Number(raw)] ?? "" : cell["@t"] === "inlineStr" ? richText(cell.is) : raw;
    return `${cell["@r"] ?? ""}: ${value}${cell.f !== undefined ? ` [formula: ${typeof cell.f === "object" ? cell.f["#text"] ?? "" : cell.f}]` : ""}`;
  }).join("\t")).join("\n");
}

async function main() {
  const bytes = readFileSync(3);
  let text = "", pageCount = 1, pageLabel = "document", warnings: string[] = [];
  if (extension === ".pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({ data: new Uint8Array(bytes), enableXfa: false, useSystemFonts: false,
      disableFontFace: true, useWorkerFetch: false });
    try {
      const document = await task.promise;
      pageCount = document.numPages;
      if (page > pageCount) throw new Error("PAGE_OUT_OF_RANGE");
      const pdfPage = await document.getPage(page);
      const content = await pdfPage.getTextContent();
      text = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("");
      pageLabel = `PDF page ${page}`;
      if (!text.trim()) warnings.push("NO_EXTRACTABLE_TEXT: this page may need OCR; original bytes remain available through read_file.");
    } finally { await task.destroy(); }
  } else if ([".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"].includes(extension)) {
    let expanded = 0;
    const files = unzipSync(bytes, { filter: file => {
      const wanted = /^(word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml|xl\/(sharedStrings|workbook)\.xml|xl\/worksheets\/sheet\d+\.xml|ppt\/slides\/slide\d+\.xml|content\.xml)$/.test(file.name);
      if (wanted) { expanded += file.originalSize; if (expanded > 128 * 1024 * 1024) throw new Error("DOCUMENT_EXPANSION_LIMIT"); }
      return wanted;
    } });
    const source = (name: string) => files[name] ? strFromU8(files[name]!) : "";
    if (extension === ".xlsx") {
      const names = Object.keys(files).filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a,b) => a.localeCompare(b, undefined, { numeric: true }));
      pageCount = names.length;
      if (!names[page - 1]) throw new Error("PAGE_OUT_OF_RANGE");
      const sharedRoot = source("xl/sharedStrings.xml") ? xml(source("xl/sharedStrings.xml")) : {};
      const shared = arr<any>(sharedRoot.sst?.si).map(v => richText(v));
      const workbook = source("xl/workbook.xml") ? xml(source("xl/workbook.xml")) : {};
      pageLabel = String(arr<any>(workbook.workbook?.sheets?.sheet)[page - 1]?.["@name"] ?? `Sheet ${page}`);
      text = spreadsheetText(xml(source(names[page - 1]!)), shared);
    } else if (extension === ".pptx") {
      const names = Object.keys(files).filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a,b) => a.localeCompare(b, undefined, { numeric: true }));
      pageCount = names.length;
      if (!names[page - 1]) throw new Error("PAGE_OUT_OF_RANGE");
      pageLabel = `Slide ${page}`;
      text = richText(xml(source(names[page - 1]!), true));
    } else if (extension === ".docx") {
      if (page !== 1) throw new Error("PAGE_OUT_OF_RANGE");
      if (!files["word/document.xml"]) throw new Error("INVALID_DOCUMENT");
      text = richText(xml(source("word/document.xml"), true));
      for (const name of Object.keys(files).filter(k => /^word\/(header|footer|footnote|endnote)/.test(k)).sort()) text += `\n[${name}]\n` + richText(xml(source(name), true));
      warnings.push("Word layout pages are not inferred; use text_offset to read all document text.");
    } else {
      if (!files["content.xml"]) throw new Error("INVALID_DOCUMENT");
      if (page !== 1) throw new Error("PAGE_OUT_OF_RANGE");
      text = richText(xml(source("content.xml"), true));
    }
  } else throw new Error("DOCUMENT_FORMAT_UNSUPPORTED");
  if (offset > text.length) throw new Error("TEXT_OFFSET_OUT_OF_RANGE");
  const selected = text.slice(offset, offset + length);
  return { format: extension.slice(1), page, page_count: pageCount, page_label: pageLabel,
    text_offset: offset, next_text_offset: offset + selected.length, total_characters: text.length,
    page_complete: offset + selected.length === text.length, next_page: page < pageCount ? page + 1 : null,
    text: selected, warnings };
}
main().then(result => process.stdout.write(JSON.stringify({ result }))).catch(error => {
  const name = error instanceof Error ? error.message : "DOCUMENT_PARSE_FAILED";
  const code = /^[A-Z_]+$/.test(name) ? name : error?.name === "PasswordException" ? "DOCUMENT_PASSWORD_REQUIRED" : "DOCUMENT_PARSE_FAILED";
  process.stdout.write(JSON.stringify({ error: code })); process.exitCode = 1;
});
