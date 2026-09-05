import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { afterEach, expect, test } from "vitest";
import { FileBridgePolicy, FileBridgeConfigSchema } from "../src/filePolicy.js";
import { readDocument } from "../src/documents.js";

const dirs: string[] = [];
test("directory pagination reaches entries beyond the first page", async () => {
  const { dir, policy } = await fixture();
  for (let i=0;i<13;i++) await writeFile(path.join(dir, `report-${i}.txt`), "report");
  let offset=0, version: string | undefined; const names: string[]=[];
  for (;;) { const r=await policy.listDirectory("reports", "", 3, offset, version); names.push(...r.entries.map(e=>e.name)); if(r.eof) break; offset=r.next_offset!; version=r.directory_version; }
  expect(new Set(names).size).toBe(13); expect(names.length).toBe(13);
});
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(path.join(process.cwd(), ".pc-filebridge-full-test-")); dirs.push(dir);
  const policy = await FileBridgePolicy.fromConfig(FileBridgeConfigSchema.parse({ version: 1,
    roots: [{ id: "reports", label: "Reports", path: dir, read: true, create: true }], limits: {} }));
  return { dir, policy };
}
test("every byte of a multi-page binary file is accessible and hash-verifiable", async () => {
  const { dir, policy } = await fixture();
  const original = Buffer.alloc(700001); for (let i = 0; i < original.length; i++) original[i] = i % 256;
  await writeFile(path.join(dir, "arbitrary.dat"), original);
  const chunks: Buffer[] = []; let offset = 0, version: string | undefined;
  for (;;) {
    const r = await policy.readFileChunk("reports", "arbitrary.dat", offset, 131072, version);
    const bytes = Buffer.from(r.data_base64, "base64");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(r.sha256_returned);
    chunks.push(bytes); version = r.file_version; offset = r.next_offset;
    if (r.eof) break;
  }
  expect(Buffer.concat(chunks)).toEqual(original);
  expect(offset).toBe(700001);
});
test("a changed file cannot be silently mixed into a prior download", async () => {
  const { dir, policy } = await fixture();
  await writeFile(path.join(dir, "report.txt"), "first version");
  const first = await policy.readFileChunk("reports", "report.txt", 0, 4);
  await writeFile(path.join(dir, "report.txt"), "changed report version");
  await expect(policy.readFileChunk("reports", "report.txt", 4, 4, first.file_version)).rejects.toMatchObject({ code: "FILE_CHANGED" });
});
test("BOM-detected UTF-16 and multibyte UTF-8 survive page boundaries", async () => {
  const { dir, policy } = await fixture(); const value = "Zażółć gęślą jaźń 😀 ".repeat(100);
  for (const [name, bytes] of [["utf8.txt", Buffer.from(value)], ["utf16.txt", Buffer.concat([Buffer.from([255,254]), Buffer.from(value, "utf16le")])]] as const) {
    await writeFile(path.join(dir, name), bytes);
    let offset = 0, all = "";
    for (;;) { const r = await policy.readTextPage("reports", name, offset, 103); all += r.text; offset = r.next_offset; if (r.eof) break; }
    expect(all).toBe(value);
  }
});
test("explicit legacy encoding is decoded and errors identify the alternative", async () => {
  const { dir, policy } = await fixture(); await writeFile(path.join(dir, "legacy.txt"), Buffer.from([90,97,191,243,179,230]));
  expect((await policy.readTextPage("reports", "legacy.txt", 0, 1024, "windows-1250")).text).toBe("Zażółć");
  await expect(policy.readTextPage("reports", "legacy.txt")).rejects.toMatchObject({ code: "NON_TEXT_FILE" });
});
test("raw download and binary creation retain root and existing-file protections", async () => {
  const { dir, policy } = await fixture();
  const data = Buffer.from([0,255,22,37]);
  await policy.createBinaryFile("reports", "result.bin", data.toString("base64"));
  await expect(policy.createBinaryFile("reports", "result.bin", "AAAA")).rejects.toMatchObject({ code: "TARGET_EXISTS" });
  expect(await readFile(path.join(dir, "result.bin"))).toEqual(data);
  await expect(policy.readFileChunk("reports", "../outside.bin")).rejects.toBeDefined();
  await expect(policy.readFileChunk("reports", ".env")).rejects.toMatchObject({ code: "SENSITIVE_PATH_BLOCKED" });
});
test("DOCX text is readable and resumable", async () => {
  const { dir, policy } = await fixture();
  const sentence = "Codex report &amp; Classic review. ".repeat(60);
  await writeFile(path.join(dir, "report.docx"), zipSync({ "word/document.xml": strToU8(`<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>${sentence}</w:t></w:r></w:p></w:body></w:document>`) }));
  const first = await readDocument(policy, "reports", "report.docx", 1, 0, 256);
  const next = await readDocument(policy, "reports", "report.docx", 1, first.next_text_offset, 10000, first.file_version);
  expect(first.text + next.text).toContain("Codex report & Classic review.");
  expect(next.page_complete).toBe(true);
  expect(first.page_complete).toBe(false);
}, 20000);
test("XLSX resolves shared strings, coordinates and formulas", async () => {
  const { dir, policy } = await fixture();
  await writeFile(path.join(dir, "report.xlsx"), zipSync({
    "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="Results"/></sheets></workbook>'),
    "xl/sharedStrings.xml": strToU8('<sst><si><t>Verified</t></si></sst>'),
    "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>') }));
  const r = await readDocument(policy, "reports", "report.xlsx");
  expect(r.text).toContain("A1: Verified"); expect(r.text).toContain("B1: 2 [formula: 1+1]"); expect(r.page_label).toBe("Results");
}, 20000);
test("PPTX exposes slides separately and OpenDocument exposes its text", async () => {
  const { dir, policy } = await fixture();
  await writeFile(path.join(dir, "report.pptx"), zipSync({
    "ppt/slides/slide1.xml": strToU8('<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>First result</a:t></a:r></a:p></p:sld>'),
    "ppt/slides/slide2.xml": strToU8('<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Second result</a:t></a:r></a:p></p:sld>') }));
  const r = await readDocument(policy, "reports", "report.pptx", 2); expect(r.text).toContain("Second result"); expect(r.page_count).toBe(2);
  await writeFile(path.join(dir, "report.odt"), zipSync({ "content.xml": strToU8('<document><body><p>OpenDocument report</p></body></document>') }));
  expect((await readDocument(policy, "reports", "report.odt")).text).toContain("OpenDocument report");
}, 20000);
test("PDF content is extracted without requiring a desktop app", async () => {
  const { dir, policy } = await fixture();
  const stream = 'BT /F1 12 Tf 40 100 Td (Codex PDF report verified) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((o,i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i+1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(o => String(o).padStart(10,'0')+' 00000 n \n').join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(path.join(dir, "report.pdf"), pdf);
  const r = await readDocument(policy, "reports", "report.pdf"); expect(r.text).toContain("Codex PDF report verified"); expect(r.page_count).toBe(1);
}, 30000);
test("document failures are explicit while original bytes stay accessible", async () => {
  const { dir, policy } = await fixture(); await writeFile(path.join(dir, "bad.docx"), "not a zip");
  await expect(readDocument(policy, "reports", "bad.docx")).rejects.toHaveProperty("code");
  expect(Buffer.from((await policy.readFileChunk("reports", "bad.docx")).data_base64, "base64").toString()).toBe("not a zip");
}, 15000);
