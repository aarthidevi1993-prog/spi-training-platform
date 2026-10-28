/**
 * Bulk import — the Word (.docx) template, generated in the browser (no
 * packages): a minimal WordprocessingML package (document, styles-free)
 * zipped without compression. The same writer builds test documents.
 */
import { zipStored } from "./zip";

export type DocxWriteBlock =
  | { text: string; bold?: boolean; size?: number }
  | { table: string[][] };

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function run(text: string, bold?: boolean, size?: number): string {
  const props = [bold ? "<w:b/>" : "", size ? `<w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/>` : ""].join("");
  return text
    .split("\n")
    .map((line, i) => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${i > 0 ? "<w:br/>" : ""}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`)
    .join("");
}

function paragraph(text: string, bold?: boolean, size?: number): string {
  return `<w:p>${text ? run(text, bold, size) : ""}</w:p>`;
}

function table(rows: string[][]): string {
  const border = '<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/></w:tblBorders>';
  const body = rows
    .map((cells, r) => `<w:tr>${cells.map((c) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph(c, r === 0)}</w:tc>`).join("")}</w:tr>`)
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${border}</w:tblPr>${body}</w:tbl>`;
}

export function docxDocumentXml(blocks: ReadonlyArray<DocxWriteBlock>): string {
  const content = blocks.map((b) => ("table" in b ? table(b.table) + "<w:p/>" : paragraph(b.text, b.bold, b.size))).join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${content}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body>` +
    "</w:document>"
  );
}

/** A .docx file whose body is the given document.xml. */
export function docxFromDocumentXml(documentXml: string): Uint8Array {
  return zipStored([
    {
      name: "[Content_Types].xml",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types>",
    },
    {
      name: "_rels/.rels",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        "</Relationships>",
    },
    { name: "word/document.xml", data: documentXml },
  ]);
}

export function buildDocx(blocks: ReadonlyArray<DocxWriteBlock>): Uint8Array {
  return docxFromDocumentXml(docxDocumentXml(blocks));
}

/** Instructions at the top of the Word template. Lines start with "•" so none is read as a question or field. */
export const DOCX_TEMPLATE_INSTRUCTIONS: string[] = [
  "• Type each question as a block of lines, exactly like the examples below. The file is read in your browser and never uploaded.",
  "• Start every question with a typed number: “Q1.”, “Q2.”, … (Word's automatic numbering is not read).",
  "• Then these lines, in any order: “Type:”, “Marks:”, the options “A)”, “B)”, …, “Answer:” and (optional) “Explanation:”.",
  "• Type: single_choice, multiple_choice or true_false.",
  "• Marks: a number greater than 0, e.g. 1 or 1.5. Missing marks are an error — they are never defaulted.",
  "• Options: 2 to 10 lines, “A)” to “J)”, one option per line, from A with no gaps. True/false questions need no options.",
  "• Answer: one letter for single choice (B), letters separated by commas for multiple choice (A, C), TRUE or FALSE for true/false.",
  "• Answers are never guessed: option text, “AC”, numbers or letters of missing options are errors.",
  "• Course: a line “Course Code: YOUR-CODE” (and optionally “Module Code: M1”) before the first question applies to every question. You can also put these lines right after a question's text, or choose the course during import.",
  "• Pictures, equations, text boxes, hidden text and tables inside a question are not imported; such questions are marked Needs review.",
  "• Every imported question is created as a DRAFT. To update draft questions, use “Export draft questions for update” (Excel) — or add “Question ID:” and “Revision:” lines from that export.",
  "• Also accepted: a Word table whose first row has the Excel template's column headers (Type, Question Text, Marks, Option A, Option B, …, Correct Answer).",
  "• Limits: 1,000 questions and 15 MB per Word file.",
  "• Delete the examples (they use the course EXAMPLE-COURSE and would be refused) and type your questions below them.",
];

const EXAMPLES: DocxWriteBlock[] = [
  { text: "Q1. EXAMPLE — Which instrument measures flow?" },
  { text: "Course Code: EXAMPLE-COURSE" },
  { text: "Type: single_choice" },
  { text: "Marks: 1" },
  { text: "A) Flow transmitter" },
  { text: "B) Pressure gauge" },
  { text: "C) Level switch" },
  { text: "Answer: A" },
  { text: "Explanation: A flow transmitter measures flow." },
  { text: "" },
  { text: "Q2. EXAMPLE — Which of these are fieldbus protocols?" },
  { text: "Course Code: EXAMPLE-COURSE" },
  { text: "Type: multiple_choice" },
  { text: "Marks: 2" },
  { text: "A) HART" },
  { text: "B) Bluetooth" },
  { text: "C) Profibus" },
  { text: "Answer: A, C" },
  { text: "" },
  { text: "Q3. EXAMPLE — A control valve is a final control element." },
  { text: "Course Code: EXAMPLE-COURSE" },
  { text: "Type: true_false" },
  { text: "Marks: 1" },
  { text: "Answer: TRUE" },
];

export function docxTemplateBlocks(): DocxWriteBlock[] {
  return [
    { text: "ARSÈNE SPI — Question Bank import template (Word)", bold: true, size: 14 },
    { text: "" },
    { text: "How to fill in this document", bold: true },
    ...DOCX_TEMPLATE_INSTRUCTIONS.map((text) => ({ text })),
    { text: "" },
    { text: "Examples", bold: true },
    ...EXAMPLES,
  ];
}

export function templateDocxBytes(): Uint8Array {
  return buildDocx(docxTemplateBlocks());
}

export const DOCX_TEMPLATE_FILE_NAME = "question-import-template.docx";
