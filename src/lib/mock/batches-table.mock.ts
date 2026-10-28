/** PART 3 UI-only mock rows for the Batches page. */
import type { BatchSummary } from "@/types/batch";

/** Demo-mode batch row shape — the same view model Supabase mode returns. */
export type BatchTableRow = BatchSummary;

export const batchTableRows: BatchTableRow[] = [
  { id: "bat_001", name: "Batch A", course: "Instrumentation Basics", trainer: "Rajesh Kumar", students: 28, maxSeats: 30, startDate: "2026-01-12", endDate: "2026-03-06", status: "ongoing" },
  { id: "bat_002", name: "Batch B", course: "Control Systems", trainer: "Anita Desai", students: 22, maxSeats: 25, startDate: "2026-02-02", endDate: "2026-04-10", status: "ongoing" },
  { id: "bat_003", name: "Batch C", course: "Process Safety", trainer: "Karthik Raman", students: 18, maxSeats: 20, startDate: "2026-03-16", endDate: "2026-05-01", status: "upcoming" },
  { id: "bat_004", name: "Batch D", course: "Instrumentation Basics", trainer: "Rajesh Kumar", students: 30, maxSeats: 30, startDate: "2025-10-06", endDate: "2025-12-05", status: "completed" },
  { id: "bat_005", name: "Batch E", course: "Advanced Process Control", trainer: "Karthik Raman", students: 0, maxSeats: 20, startDate: "2026-04-01", endDate: "2026-06-15", status: "cancelled" },
];

export function getBatchesForTrainer(trainerName: string): BatchTableRow[] {
  return batchTableRows.filter((b) => b.trainer === trainerName);
}
