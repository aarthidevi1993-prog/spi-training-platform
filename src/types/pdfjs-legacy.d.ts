// pdf.js legacy builds (loaded on demand by src/lib/question-import/pdf.ts).
declare module "pdfjs-dist/legacy/build/pdf.min.mjs" {
  export * from "pdfjs-dist";
}
// The worker module only registers globalThis.pdfjsWorker; it has no exports we use.
declare module "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
