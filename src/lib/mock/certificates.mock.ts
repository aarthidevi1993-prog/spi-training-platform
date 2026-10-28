/** PART 3 UI-only mock rows for the Certificates page. */
export interface CertificateRow {
  id: string;
  certificateNumber: string;
  student: string;
  course: string;
  completionDate: string;
  status: "issued" | "revoked" | "expired";
}

export const certificateRows: CertificateRow[] = [
  { id: "cert_001", certificateNumber: "SPI-CERT-2026-0001", student: "Priya Nair", course: "Instrumentation Basics", completionDate: "2026-03-06", status: "issued" },
  { id: "cert_002", certificateNumber: "SPI-CERT-2026-0002", student: "Arun Kumar", course: "Instrumentation Basics", completionDate: "2026-03-06", status: "issued" },
  { id: "cert_003", certificateNumber: "SPI-CERT-2025-0044", student: "Karthik Raman", course: "Process Safety", completionDate: "2025-12-01", status: "expired" },
  { id: "cert_004", certificateNumber: "SPI-CERT-2025-0039", student: "Meera Pillai", course: "Control Systems", completionDate: "2025-11-14", status: "revoked" },
];

export function getCertificatesForStudent(studentName: string): CertificateRow[] {
  return certificateRows.filter((c) => c.student === studentName);
}
