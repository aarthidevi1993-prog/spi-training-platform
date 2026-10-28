/** Save generated file content in the browser (no upload, no server round trip). */
export function downloadFile(content: Uint8Array | string, fileName: string, mimeType: string): void {
  const blob = new Blob([content as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const CSV_MIME = "text/csv;charset=utf-8";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
