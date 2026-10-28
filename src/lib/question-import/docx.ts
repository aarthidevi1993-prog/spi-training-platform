/**
 * Bulk import — Word (.docx) reader, in the browser (the file is never
 * uploaded). Two layouts are accepted, never mixed in one document:
 *
 *  1. Question blocks (docx-template.ts writes the official example):
 *
 *       Course Code: SPI-101          ← optional, before the first question
 *       Q1. Which instrument measures flow?
 *       Type: single_choice
 *       Marks: 2
 *       A) Flow transmitter
 *       B) Pressure gauge
 *       Answer: A
 *       Explanation: …                ← optional
 *
 *  2. Tables whose first row holds the Excel/CSV template headers
 *     (Type, Question Text, Marks, Option A, … Correct Answer).
 *
 * Both become the same raw rows as an Excel sheet (via rowsFromSheet), so
 * Question ID + Revision, the question limit, validation, fingerprints
 * and duplicates behave exactly as for Excel/CSV. Nothing is guessed:
 * content that cannot be read with certainty (pictures, equations, hidden
 * text, automatic numbering, lines that fit no pattern) makes the
 * question NEEDS REVIEW; conflicting lines make it an ERROR.
 *
 * The XML reader accepts plain WordprocessingML only: a DOCTYPE (entity
 * declarations) is refused, and only the five XML entities and numeric
 * character references are decoded.
 */
import { OPTION_LETTERS, type ImportField, type ImportIssue, type ParsedImportFile, type RawImportRow } from "@/types/question-import";
import { TEMPLATE_HEADERS, mapHeaders, type TemplateColumn } from "./headers";
import { cleanText } from "./normalize";
import { checkFileSize, rowsFromSheet, type SheetCell, type SheetRow } from "./sheet";
import { checkQuestionCount } from "./validate";
import { ZipError, isCompoundFile, listZipEntries, readZipEntry } from "./zip";

/** Largest document.xml accepted after decompression. */
export const DOCX_XML_MAX_BYTES = 60 * 1024 * 1024;

export class DocxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxError";
  }
}

// ---------------------------------------------------------------------------
// WordprocessingML → paragraphs and tables
// ---------------------------------------------------------------------------

/** Content in a paragraph (or table row) that is not imported as text. */
export interface DocxFlags {
  /** A picture, shape, chart, embedded object or text box. */
  image?: boolean;
  /** A Word equation (its text is read, but its layout is lost). */
  equation?: boolean;
  /** A character from a symbol font (w:sym), which has no plain-text value. */
  symbol?: boolean;
  /** Text formatted as hidden. */
  hidden?: boolean;
  /** PDF: the line is laid out in columns or a table, so its reading order is uncertain. */
  layout?: boolean;
  /** PDF: a page with no selectable text (probably scanned) follows this point. */
  scanned?: boolean;
}

export interface DocxParagraph {
  kind: "p";
  /** Position among the body's paragraphs and tables (1-based). */
  index: number;
  /** PDF: the page the line is on. */
  page?: number;
  /** PDF: the line was read by OCR from a scanned page, with this confidence (0–100; lowest word). */
  ocr?: boolean;
  confidence?: number;
  text: string;
  /** Word's automatic numbering or bullets (the number/letter is not part of the text). */
  numbered: boolean;
  flags: DocxFlags;
}

export interface DocxTableRow {
  cells: string[];
  flags: DocxFlags;
}

export interface DocxTable {
  kind: "table";
  index: number;
  rows: DocxTableRow[];
  /** A table inside a cell (its text is merged into the outer cell). */
  nested: boolean;
}

export interface DocxBody {
  blocks: Array<DocxParagraph | DocxTable>;
  /** Insertions/deletions are present (read as if every change were accepted). */
  trackedChanges: boolean;
}

const W_NS = ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"];
const M_NS = ["http://schemas.openxmlformats.org/officeDocument/2006/math", "http://purl.oclc.org/ooxml/officeDocument/math"];
const MC_NS = ["http://schemas.openxmlformats.org/markup-compatibility/2006"];

function prefixFor(xml: string, namespaces: string[], fallback: string): string {
  const head = xml.slice(0, 20_000);
  for (const ns of namespaces) {
    const m = new RegExp(`xmlns:([A-Za-z_][\\w.-]*)\\s*=\\s*["']${ns.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']`).exec(head);
    if (m) return m[1]!;
  }
  return fallback;
}

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeXmlText(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES[ref] ?? whole;
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name.replace(/[.]/g, "\\.")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decodeXmlText(m[1] ?? m[2] ?? "") : null;
}

const isOff = (value: string | null) => value === "0" || value === "false" || value === "off";

/** Read document.xml into body paragraphs and tables. Throws DocxError on malformed XML. */
export function parseDocumentXml(xml: string): DocxBody {
  const W = prefixFor(xml, W_NS, "w");
  const M = prefixFor(xml, M_NS, "m");
  const MC = prefixFor(xml, MC_NS, "mc");
  const w = (local: string) => `${W}:${local}`;

  // Content that is never read as text: deleted/moved-away revisions, the
  // fallback copy of alternate content, and drawing/object internals.
  const SKIP = new Set([w("del"), w("moveFrom"), `${MC}:Fallback`, w("drawing"), w("pict"), w("object"), w("txbxContent")]);
  const IMAGE = new Set([w("drawing"), w("pict"), w("object"), w("txbxContent")]);

  const body: DocxBody = { blocks: [], trackedChanges: false };
  const stack: string[] = [];
  let skip = 0;
  let inBody = false;
  let inText = false;
  let pPrDepth = 0;
  let rPrOfRun = false;
  let runHidden = false;
  let blockIndex = 0;

  interface Para { text: string; numbered: boolean; flags: DocxFlags }
  interface Cell { paras: string[]; span: number }
  interface Table { table: DocxTable; row: DocxTableRow | null; cell: Cell | null }
  let para: Para | null = null;
  const tables: Table[] = [];

  const flag = (key: keyof DocxFlags) => {
    if (para) para.flags[key] = true;
    else if (tables[0]?.row) tables[0].row.flags[key] = true;
  };

  const onOpen = (name: string, tag: string, selfClosing: boolean) => {
    if (skip > 0) {
      if (!selfClosing) {
        if (SKIP.has(name)) skip++;
        stack.push(name);
      }
      return;
    }
    if (name === w("body")) inBody = true;
    if (!inBody) {
      if (!selfClosing) stack.push(name);
      return;
    }
    if (name === w("ins") || name === w("moveTo") || name === w("del") || name === w("moveFrom")) body.trackedChanges = true;
    if (IMAGE.has(name)) flag("image");
    if (SKIP.has(name)) {
      if (!selfClosing) {
        skip = 1;
        stack.push(name);
      }
      return;
    }

    switch (name) {
      case w("p"):
        para = { text: "", numbered: false, flags: {} };
        if (selfClosing) closeParagraph();
        break;
      case w("pPr"):
        if (!selfClosing) pPrDepth++;
        break;
      case w("numPr"):
        if (para && pPrDepth > 0) para.numbered = true;
        break;
      case w("pStyle"):
        if (para && pPrDepth > 0 && /^list\s*(number|bullet)/i.test(attr(tag, w("val")) ?? "")) para.numbered = true;
        break;
      case w("r"):
        runHidden = false;
        break;
      case w("rPr"):
        if (!selfClosing && pPrDepth === 0) rPrOfRun = true;
        break;
      case w("vanish"):
      case w("specVanish"):
        if (rPrOfRun && !isOff(attr(tag, w("val")))) runHidden = true;
        break;
      case w("t"):
      case `${M}:t`:
        if (!selfClosing) inText = true;
        break;
      case w("tab"):
        if (para && pPrDepth === 0) para.text += "\t";
        break;
      case w("br"):
      case w("cr"):
        if (para && pPrDepth === 0) para.text += "\n";
        break;
      case w("noBreakHyphen"):
        if (para) para.text += "-";
        break;
      case w("sym"):
        flag("symbol");
        break;
      case `${M}:oMath`:
      case `${M}:oMathPara`:
        flag("equation");
        break;
      case w("tbl"): {
        const nested = tables.length > 0;
        if (nested) tables[0]!.table.nested = true;
        tables.push({ table: { kind: "table", index: nested ? 0 : ++blockIndex, rows: [], nested: false }, row: null, cell: null });
        break;
      }
      case w("tr"):
        if (tables.length === 1) tables[0]!.row = { cells: [], flags: {} };
        break;
      case w("tc"):
        if (tables.length === 1) tables[0]!.cell = { paras: [], span: 1 };
        break;
      case w("gridSpan"): {
        const span = Number(attr(tag, w("val")));
        if (tables.length === 1 && tables[0]!.cell && Number.isInteger(span) && span > 1 && span <= 64) tables[0]!.cell.span = span;
        break;
      }
    }
    if (!selfClosing) stack.push(name);
  };

  const closeParagraph = () => {
    if (!para) return;
    const outer = tables[0];
    if (outer) {
      if (outer.cell) outer.cell.paras.push(para.text);
      if (outer.row) Object.assign(outer.row.flags, para.flags);
    } else {
      body.blocks.push({ kind: "p", index: ++blockIndex, text: para.text, numbered: para.numbered, flags: para.flags });
    }
    para = null;
  };

  const onClose = (name: string) => {
    const open = stack.pop();
    if (open !== name) throw new DocxError("malformed XML");
    if (skip > 0) {
      if (SKIP.has(name)) skip--;
      return;
    }
    if (!inBody) return;
    switch (name) {
      case w("body"):
        inBody = false;
        break;
      case w("p"):
        closeParagraph();
        break;
      case w("pPr"):
        pPrDepth = Math.max(0, pPrDepth - 1);
        break;
      case w("rPr"):
        rPrOfRun = false;
        break;
      case w("t"):
      case `${M}:t`:
        inText = false;
        break;
      case w("tc"): {
        const t = tables[0];
        if (tables.length === 1 && t?.row && t.cell) {
          t.row.cells.push(t.cell.paras.join("\n"));
          for (let i = 1; i < t.cell.span; i++) t.row.cells.push("");
          t.cell = null;
        }
        break;
      }
      case w("tr"): {
        const t = tables[0];
        if (tables.length === 1 && t?.row) {
          t.table.rows.push(t.row);
          t.row = null;
        }
        break;
      }
      case w("tbl"): {
        const t = tables.pop();
        if (t && tables.length === 0) body.blocks.push(t.table);
        break;
      }
    }
  };

  const onText = (raw: string) => {
    if (skip > 0 || !inText || !para) return;
    para.text += decodeXmlText(raw);
    if (runHidden) para.flags.hidden = true;
  };

  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      onText(xml.slice(i));
      break;
    }
    if (lt > i) onText(xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) throw new DocxError("malformed XML");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) throw new DocxError("malformed XML");
      if (skip === 0 && inText && para) (para as Para).text += xml.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<!", lt)) throw new DocxError("DOCTYPE and entity declarations are not allowed");
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) throw new DocxError("malformed XML");
      i = end + 2;
      continue;
    }
    // Find the end of the tag, honouring quoted attribute values.
    let j = lt + 1;
    let quote = "";
    for (; j < n; j++) {
      const c = xml[j]!;
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (j >= n) throw new DocxError("malformed XML");
    const tag = xml.slice(lt, j + 1);
    i = j + 1;
    if (tag[1] === "/") {
      onClose(tag.slice(2, -1).trim());
      continue;
    }
    const selfClosing = tag[tag.length - 2] === "/";
    const name = /^<([^\s/>]+)/.exec(tag)?.[1];
    if (!name) throw new DocxError("malformed XML");
    onOpen(name, tag, selfClosing);
  }
  if (stack.length > 0) throw new DocxError("malformed XML");
  return body;
}

// ---------------------------------------------------------------------------
// Paragraphs / tables → raw import rows
// ---------------------------------------------------------------------------

type Field = "questionId" | "courseCode" | "moduleCode" | "questionType" | "marks" | "correctAnswer" | "explanation" | "status" | "revision";

const labelKey = (text: string) => text.toLowerCase().replace(/[\s_\-]+/g, "");
/** "Label: value" lines of a question block. */
const FIELD_LABELS = new Map<string, Field>(
  (
    [
      ["Question ID", "questionId"],
      ["Course Code", "courseCode"],
      ["Module Code", "moduleCode"],
      ["Type", "questionType"],
      ["Question Type", "questionType"],
      ["Marks", "marks"],
      ["Mark", "marks"],
      ["Answer", "correctAnswer"],
      ["Correct Answer", "correctAnswer"],
      ["Explanation", "explanation"],
      ["Status", "status"],
      ["Revision", "revision"],
    ] as const
  ).map(([label, field]) => [labelKey(label), field])
);
const FIELD_NAME: Record<Field, string> = {
  questionId: "Question ID",
  courseCode: "Course Code",
  moduleCode: "Module Code",
  questionType: "Type",
  marks: "Marks",
  correctAnswer: "Answer",
  explanation: "Explanation",
  status: "Status",
  revision: "Revision",
};

/** "Q1. text", "Q 12) text", "Question 3: text", "Q.4 - text". */
const QUESTION_LINE = /^(?:Q\.?|Question)\s*(\d{1,7})\s*[.):\-–—]\s*(.*)$/i;
/** "A) text", "A. text", "(A) text", "a) text", "Option A: text". Lower-case letters need ")" so "e.g." is not an option. */
const OPTION_LINE = /^(?:[Oo]ption\s+([A-Ja-j])\s*[.):\-–—]?|\(([A-Ja-j])\)|([A-J])\s*[.):]|([a-j])\s*\))\s*(.*)$/;
const FIELD_LINE = /^([A-Za-z][A-Za-z _\-]{0,29}?)\s*:\s*(.*)$/;

/** A line that belongs to the question-block format (Q-line, option or labelled field). */
export function isQuestionBlockLine(line: string): boolean {
  const text = line.trim();
  if (QUESTION_LINE.test(text) || OPTION_LINE.test(text)) return true;
  const field = FIELD_LINE.exec(text);
  return !!field && FIELD_LABELS.has(labelKey(field[1]!));
}

const review = (field: ImportField, message: string): ImportIssue => ({ code: "extraction_incomplete", severity: "needs_review", field, message });
const conflict = (field: ImportField, message: string): ImportIssue => ({ code: "row_malformed", severity: "error", field, message });

const FLAG_ISSUES: Record<keyof DocxFlags, ImportIssue> = {
  image: review("questionText", "This question has a picture, shape, chart or text box, which is not imported. Remove it, or add this question in the Question Bank instead."),
  equation: review("questionText", "This question has a Word equation, which may not be read correctly. Write it as plain text."),
  symbol: review("questionText", "This question uses a character from a symbol font, which cannot be read. Type the character instead (for example Ω or °)."),
  hidden: review("questionText", "This question contains hidden text. Show or delete hidden text in Word before importing."),
  layout: review("row", "Part of this question is laid out in columns or a table in the PDF, so its reading order is uncertain. Put each option on its own line."),
  scanned: review("row", "This question is followed by a page with no selectable text (probably a scanned image), so part of it may be missing. Scanned pages are not read (OCR is not supported yet)."),
};


interface Question {
  number: number;
  paragraph: number;
  page?: number;
  text: string[];
  textDone: boolean;
  fields: Partial<Record<Field, string>>;
  options: Array<string | undefined>;
  /** What the last line added to (continuation lines). */
  last: "text" | "option" | "explanation" | "field";
  lastOption: number;
  optionsOrAnswerSeen: boolean;
  flags: DocxFlags;
  issues: ImportIssue[];
  /** OCR: some of the question's lines were read from a scanned page; the lowest line confidence. */
  ocr: boolean;
  confidence?: number;
}

interface Extracted {
  cells: SheetCell[];
  number: number | null;
  paragraph?: number;
  page?: number;
  ocr?: boolean;
  confidence?: number;
  issues: ImportIssue[];
  empty: boolean;
}

/**
 * OCR: a line the answer key or a question's identity depends on (answer,
 * marks, type, options, course/module, Question ID, revision) read with
 * less confidence than this makes the question NEEDS REVIEW — an issue the
 * reviewer's "checked against the page" tick does not clear.
 */
export const OCR_KEY_LINE_MIN_CONFIDENCE = 85;

/**
 * Where the lines come from. Word: each paragraph is intentional, so a
 * continuation paragraph is a new line and an option must stay on one
 * paragraph. PDF: text is wrapped to the page width, so a continuation
 * line continues the same text (question, option or explanation).
 */
export type BlockSource = "docx" | "pdf" | "pdf_ocr";

/** Join a wrapped PDF line: "4-" + "20 mA" → "4-20 mA", otherwise with one space. */
const joinWrapped = (a: string, b: string) => (a.endsWith("-") ? `${a}${b}` : `${a} ${b}`);

const UNIFIED_HEADER = TEMPLATE_HEADERS.map((h) => h.header);
const UNIFIED_INDEX = new Map<TemplateColumn, number>(TEMPLATE_HEADERS.map((h, i) => [h.column, i]));

function addIssue(list: ImportIssue[], issue: ImportIssue) {
  if (!list.some((i) => i.message === issue.message)) list.push(issue);
}

function flagIssues(flags: DocxFlags): ImportIssue[] {
  return (Object.keys(FLAG_ISSUES) as (keyof DocxFlags)[]).filter((k) => flags[k]).map((k) => FLAG_ISSUES[k]);
}

const oneLine = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

function blockQuestions(
  body: DocxBody,
  warnings: string[],
  source: BlockSource
): { questions: Question[]; docCourse: string | null; docModule: string | null; errors: string[]; ignoredTables: number } {
  const questions: Question[] = [];
  const errors: string[] = [];
  let current: Question | null = null;
  let docCourse: string | null = null;
  let docModule: string | null = null;
  let ignoredTables = 0;

  for (const block of body.blocks) {
    if (block.kind === "table") {
      if (current) addIssue(current.issues, review("options", "This question contains a table, which is not imported. Write the options as lines (A) …, B) …) instead."));
      else ignoredTables++;
      continue;
    }
    const lines = block.text.replace(/[\u00a0\u2007\u202f]/g, " ").split("\n");
    let flagsApplied = false;
    const lowConfidence = !!block.ocr && typeof block.confidence === "number" && block.confidence < OCR_KEY_LINE_MIN_CONFIDENCE;
    const unsure = (field: ImportField, what: string, line: string) =>
      review(field, `OCR is not sure it read ${what} correctly (\u201c${oneLine(line)}\u201d, ${Math.round(block.confidence ?? 0)}% confidence). Correct the source file and import it again, or add this question in the Question Bank.`);
    for (const rawLine of lines) {
      const line = rawLine.replace(/\t/g, " ").trim();
      const q = QUESTION_LINE.exec(line);
      if (q) {
        current = {
          number: Number(q[1]),
          paragraph: block.index,
          page: block.page,
          text: q[2] ? [q[2].trim()] : [],
          textDone: false,
          fields: {},
          options: [],
          last: "text",
          lastOption: -1,
          optionsOrAnswerSeen: false,
          flags: {},
          issues: [],
          ocr: !!block.ocr,
          confidence: block.ocr ? block.confidence : undefined,
        };
        questions.push(current);
        continue;
      }
      if (!line) continue;
      if (current && block.ocr) {
        current.ocr = true;
        if (typeof block.confidence === "number") current.confidence = Math.min(current.confidence ?? 100, block.confidence);
      }
      if (!flagsApplied && current) {
        Object.assign(current.flags, block.flags);
        flagsApplied = true;
      }

      const field = FIELD_LINE.exec(line);
      const fieldName = field ? FIELD_LABELS.get(labelKey(field[1]!)) : undefined;
      if (field && fieldName) {
        const value = field[2]!.trim();
        if (!current) {
          if (fieldName === "courseCode" || fieldName === "moduleCode") {
            if (fieldName === "courseCode" ? docCourse !== null : docModule !== null) {
              errors.push(`“${FIELD_NAME[fieldName]}:” appears more than once before the first question. Give it once, or put it inside each question.`);
            }
            if (fieldName === "courseCode") docCourse = value;
            else docModule = value;
          } else {
            warnings.push(`“${oneLine(line)}” before the first question was ignored.`);
          }
          continue;
        }
        if (current.fields[fieldName] !== undefined) {
          addIssue(current.issues, conflict(fieldName === "revision" ? "questionId" : (fieldName as ImportField), `The “${FIELD_NAME[fieldName]}:” line appears more than once in this question.`));
        } else if ((fieldName === "courseCode" || fieldName === "moduleCode") && current.optionsOrAnswerSeen) {
          addIssue(
            current.issues,
            conflict(fieldName, `“${FIELD_NAME[fieldName]}:” must come right after the question text (or once at the top of the document), not after the options or answer.`)
          );
        } else {
          current.fields[fieldName] = value;
        }
        if (lowConfidence && fieldName !== "explanation" && fieldName !== "status") {
          addIssue(current.issues, unsure(fieldName === "revision" ? "questionId" : (fieldName as ImportField), `the “${FIELD_NAME[fieldName]}:” line`, line));
        }
        if (fieldName === "correctAnswer") current.optionsOrAnswerSeen = true;
        current.textDone = true;
        current.last = fieldName === "explanation" ? "explanation" : "field";
        continue;
      }

      const option = current ? OPTION_LINE.exec(line) : null;
      if (current && option) {
        const letter = (option[1] ?? option[2] ?? option[3] ?? option[4] ?? "").toUpperCase();
        const index = OPTION_LETTERS.indexOf(letter as (typeof OPTION_LETTERS)[number]);
        const text = option[5]!.trim();
        if (current.options[index] !== undefined) {
          addIssue(current.issues, conflict("options", `Option ${letter} appears more than once in this question.`));
        } else {
          current.options[index] = text;
        }
        if (lowConfidence) addIssue(current.issues, unsure("options", `option ${letter}`, line));
        const next = OPTION_LETTERS[index + 1];
        const lower = next?.toLowerCase();
        if (next && new RegExp(`\\s(?:\\([${next}${lower}]\\)|${next}[.)]|${lower}\\))\\s`).test(` ${text} `)) {
          addIssue(current.issues, review("options", `Option ${letter} seems to contain the next option on the same line. Put each option on its own line.`));
        }
        current.optionsOrAnswerSeen = true;
        current.textDone = true;
        current.last = "option";
        current.lastOption = index;
        continue;
      }

      if (!current) continue; // titles and instructions before the first question
      if (block.numbered) {
        addIssue(current.issues, review("options", "A line in this question uses Word's automatic numbering or bullets, which is not read. Type the option letters instead (A), B), …)."));
        continue;
      }
      const pdf = source !== "docx";
      if (current.last === "text" && !current.textDone) {
        if (pdf && current.text.length > 0) current.text[current.text.length - 1] = joinWrapped(current.text[current.text.length - 1]!, line);
        else current.text.push(line);
      } else if (current.last === "explanation") {
        const before = current.fields.explanation ?? "";
        current.fields.explanation = (pdf && before ? joinWrapped(before, line) : `${before}\n${line}`).trim();
      } else if (current.last === "option" && pdf && /^[^\s]{1,2}\s*[.):]\s/.test(line)) {
        // Looks like an option label that did not read as A–J (e.g. OCR "8)" for "B)"): never joined to the previous option.
        addIssue(current.issues, review("options", `The line “${oneLine(line)}” looks like an option, but its letter could not be read as A–J. Check the options.`));
      } else if (current.last === "option" && pdf && current.options[current.lastOption] !== undefined) {
        current.options[current.lastOption] = joinWrapped(current.options[current.lastOption]!, line);
        if (lowConfidence) addIssue(current.issues, unsure("options", `option ${OPTION_LETTERS[current.lastOption]}`, line));
      } else if (current.last === "option") {
        addIssue(current.issues, review("options", `An option continues on another line (“${oneLine(line)}”). Keep each option on a single line.`));
      } else {
        addIssue(current.issues, review("row", `The line “${oneLine(line)}” was not understood. Use the question text, option lines (A), B), …) or labelled lines (Type:, Marks:, Answer:, Explanation:).`));
      }
    }
    if (current && !flagsApplied) Object.assign(current.flags, block.flags);
  }
  return { questions, docCourse, docModule, errors, ignoredTables };
}

function questionCells(q: Question, docCourse: string | null, docModule: string | null): Extracted {
  const cells: SheetCell[] = new Array(UNIFIED_HEADER.length).fill(null);
  const set = (column: TemplateColumn, value: string | null | undefined) => {
    if (value !== undefined && value !== null) cells[UNIFIED_INDEX.get(column)!] = value;
  };
  const text = q.text.join("\n").trim();
  set("questionId", q.fields.questionId);
  set("courseCode", q.fields.courseCode ?? docCourse);
  // The document's module belongs to the document's course only.
  set("moduleCode", q.fields.moduleCode ?? (q.fields.courseCode === undefined ? docModule : null));
  set("questionText", text);
  set("questionType", q.fields.questionType);
  set("marks", q.fields.marks);
  OPTION_LETTERS.forEach((l, i) => set(`option${l}` as TemplateColumn, q.options[i]));
  set("correctAnswer", q.fields.correctAnswer);
  set("explanation", q.fields.explanation);
  set("status", q.fields.status);
  set("revision", q.fields.revision);

  const issues = [...q.issues];
  for (const i of flagIssues(q.flags)) addIssue(issues, i);
  const empty = !text && Object.keys(q.fields).length === 0 && q.options.every((o) => o === undefined) && issues.length === 0;
  return { cells, number: q.number, paragraph: q.paragraph, page: q.page, ocr: q.ocr, confidence: q.confidence, issues, empty };
}

function tableRows(table: DocxTable, map: ReturnType<typeof mapHeaders>, docCourse: string | null, docModule: string | null): Extracted[] {
  const course = UNIFIED_INDEX.get("courseCode")!;
  const module_ = UNIFIED_INDEX.get("moduleCode")!;
  return table.rows.slice(1).map((row) => {
    const cells: SheetCell[] = new Array(UNIFIED_HEADER.length).fill(null);
    for (const [column, index] of Object.entries(map.columns) as [TemplateColumn, number][]) {
      const value = row.cells[index];
      if (value !== undefined) cells[UNIFIED_INDEX.get(column)!] = value.replace(/[\u00a0\u2007\u202f]/g, " ");
    }
    const blankAt = (i: number) => typeof cells[i] !== "string" || (cells[i] as string).trim() === "";
    const anyContent = cells.some((_, i) => !blankAt(i));
    // The document's Course Code / Module Code fill rows that have none (the module only with the document's course).
    if (anyContent && blankAt(course) && docCourse) {
      cells[course] = docCourse;
      if (blankAt(module_) && docModule) cells[module_] = docModule;
    }
    const issues = flagIssues(row.flags);
    if (table.nested) addIssue(issues, review("row", "This table has a table inside a cell, which is not imported. Check the question."));
    return { cells, number: null, paragraph: table.index, issues, empty: !anyContent && issues.length === 0 };
  });
}

/**
 * Turn a parsed document body into import rows (pure). Also used for PDF
 * (source "pdf"): pdf.ts turns the PDF's text lines into paragraphs.
 */
export function rowsFromDocxBody(body: DocxBody, source: BlockSource = "docx"): ParsedImportFile {
  const warnings: string[] = [];
  const fail = (...fileErrors: string[]): ParsedImportFile => ({ source, rows: [], fileErrors, warnings: [], blankRowsSkipped: 0, everyRowHasCourse: false });

  // Question tables: the first row maps to the template headers.
  const questionTables: Array<{ table: DocxTable; map: ReturnType<typeof mapHeaders> }> = [];
  const tableErrors: string[] = [];
  let tableNo = 0;
  for (const block of body.blocks) {
    if (block.kind !== "table") continue;
    tableNo++;
    const map = mapHeaders(block.rows[0]?.cells ?? [], { courseChosenInUi: true });
    if (map.errors.length === 0) questionTables.push({ table: block, map });
    else if (Object.keys(map.columns).length >= 3) tableErrors.push(`Table ${tableNo} looks like a question table, but: ${map.errors.join(" ")}`);
  }

  const blocks = blockQuestions(body, warnings, source);
  if (tableErrors.length > 0) return fail(...tableErrors);
  if (questionTables.length > 0 && blocks.questions.length > 0) {
    return fail("This document has both question tables and question paragraphs (Q1., Q2., …). Use one layout per document.");
  }
  if (blocks.errors.length > 0) return fail(...blocks.errors);

  let extracted: Extracted[];
  if (questionTables.length > 0) {
    extracted = [];
    for (const { table, map } of questionTables) {
      if (map.ignored.length > 0) warnings.push(`Ignored column${map.ignored.length === 1 ? "" : "s"}: ${map.ignored.join(", ")}.`);
      extracted.push(...tableRows(table, map, blocks.docCourse, blocks.docModule));
    }
  } else if (blocks.questions.length > 0) {
    extracted = blocks.questions.map((q) => questionCells(q, blocks.docCourse, blocks.docModule));
    if (blocks.ignoredTables > 0) {
      warnings.push(`${blocks.ignoredTables} table${blocks.ignoredTables === 1 ? "" : "s"} before the first question ${blocks.ignoredTables === 1 ? "was" : "were"} ignored.`);
    }
  } else if (source !== "docx") {
    return fail(
      (source === "pdf_ocr" ? "No questions were found in the OCR text of the scanned pages." : "No questions were found in the PDF's text.") +
        " Start each question with “Q1.”, “Q2.”, … followed by Type:, Marks:, the options A), B), … and Answer: — the same format as the Word template (fill it in and save it as PDF)."
    );
  } else {
    const numbered = body.blocks.some((b) => b.kind === "p" && b.numbered);
    return fail(
      "No questions were found. Start each question with a typed number such as “Q1.” (automatic Word numbering is not read), or use a table with the template's column headers. Download the Word template for the format." +
        (numbered ? " This document uses automatic numbering." : "")
    );
  }
  if (body.trackedChanges) warnings.push("The document has tracked changes; it was read as if every change were accepted.");

  const blank = extracted.filter((e) => e.empty).length;
  const kept = extracted.filter((e) => !e.empty);
  if (blank > 0) warnings.push(`${blank} empty question${blank === 1 ? "" : "s"} skipped.`);
  if (kept.length === 0) return fail("No questions were found: every question in the document is empty.");
  const tooMany = checkQuestionCount(source, kept.length);
  if (tooMany) return fail(tooMany);

  // Question numbers: the document's own (Q1, Q2, …) when each is used once; otherwise their order.
  const written = kept.map((e) => e.number);
  const useWritten = written.every((n): n is number => n !== null && n >= 1 && n <= 1_000_000) && new Set(written).size === written.length;
  if (!useWritten && written.some((n) => n !== null)) {
    warnings.push("Some question numbers repeat, so questions are numbered by their order in the document.");
  } else if (useWritten) {
    const sorted = [...(written as number[])].sort((a, b) => a - b);
    const gap = sorted.findIndex((n, i) => i > 0 && n !== sorted[i - 1]! + 1);
    if (gap > 0) warnings.push(`Question numbers skip from Q${sorted[gap - 1]} to Q${sorted[gap]}. Check that no question is missing.`);
  }
  const rowNumber = (e: Extracted, i: number) => (useWritten ? (e.number as number) : i + 1);

  const sheetRows: SheetRow[] = kept.map((e, i) => ({ rowNumber: rowNumber(e, i), cells: e.cells, issues: e.issues.length > 0 ? e.issues : undefined }));
  const parsed = rowsFromSheet(source, UNIFIED_HEADER, sheetRows);
  if (parsed.fileErrors.length > 0) return parsed;

  // rowsFromSheet skips rows with no text at all; a question whose only content could not be read
  // (e.g. just a picture) must still be shown — as NEEDS REVIEW — not dropped.
  const read = new Map(parsed.rows.map((r) => [r.rowNumber, r]));
  const rows: RawImportRow[] = sheetRows.map((s, i) => {
    const r: RawImportRow = read.get(s.rowNumber) ?? { rowNumber: s.rowNumber, sourceIssues: s.issues };
    const { paragraph, page, ocr, confidence } = kept[i]!;
    if (source !== "docx") {
      // OCR rows are "uncertain": NEEDS REVIEW until the reviewer confirms them against the page (validate.ts).
      const where = { ...(page ? { page } : {}), ...(ocr ? { uncertain: true, ...(typeof confidence === "number" ? { ocrConfidence: confidence } : {}) } : {}) };
      return Object.keys(where).length > 0 ? { ...r, source: where } : r;
    }
    return paragraph ? { ...r, source: { paragraph } } : r;
  });
  return {
    ...parsed,
    rows,
    warnings: [...warnings, ...parsed.warnings.filter((w) => !/blank row/.test(w))],
    blankRowsSkipped: blank,
    everyRowHasCourse: rows.every((r) => cleanText(r.courseCode) !== ""),
  };
}

// ---------------------------------------------------------------------------
// File → rows
// ---------------------------------------------------------------------------

const UNREADABLE = "This file could not be read as a Word .docx document. It may be damaged or not a Word file — open it in Word, save it as .docx and try again.";

function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

export async function parseDocx(data: ArrayBuffer): Promise<ParsedImportFile> {
  const empty = (error: string): ParsedImportFile => ({ source: "docx", rows: [], fileErrors: [error], warnings: [], blankRowsSkipped: 0, everyRowHasCourse: false });
  const tooBig = checkFileSize("docx", data.byteLength);
  if (tooBig) return empty(tooBig);
  const bytes = new Uint8Array(data);
  if (isCompoundFile(bytes)) {
    return empty("This Word file is password-protected, or it is an older .doc file. Remove the password or save it as .docx (Word Document) and try again.");
  }

  let xml: string;
  try {
    const entries = listZipEntries(bytes);
    const main = entries.find((e) => e.name === "word/document.xml");
    if (!main) {
      return empty(entries.some((e) => e.name === "xl/workbook.xml") ? "This is an Excel workbook renamed to .docx. Save it as .xlsx and import it as Excel." : UNREADABLE);
    }
    xml = decodeXmlBytes(await readZipEntry(bytes, main, DOCX_XML_MAX_BYTES));
  } catch (err) {
    if (err instanceof ZipError && err.message === "entry too large") return empty("The document's text is too large to import. Split it into smaller files.");
    return empty(UNREADABLE);
  }

  let body: DocxBody;
  try {
    body = parseDocumentXml(xml);
  } catch (err) {
    return empty(err instanceof DocxError && /DOCTYPE/.test(err.message) ? "This Word document contains XML declarations that are not allowed. Save it again from Word and try again." : UNREADABLE);
  }
  return rowsFromDocxBody(body);
}
