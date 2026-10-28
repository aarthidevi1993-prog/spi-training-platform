/**
 * PART 3 UI-only mock rows for the Trainers table page. See the note
 * in students-table.mock.ts — presentation data only, kept separate
 * from the future trainers repository.
 */
import type { TrainerSummary } from "@/types/trainer";

/** Demo-mode trainer row shape — the same view model Supabase mode returns. */
export type TrainerTableRow = TrainerSummary;

export const trainerTableRows: TrainerTableRow[] = [
  { id: "trn_001", name: "Rajesh Kumar", email: "rajesh.kumar@arsene-tech.example", courses: ["Instrumentation Basics", "P&ID Fundamentals"], batches: ["Batch A"], students: 28, status: "active" },
  { id: "trn_002", name: "Anita Desai", email: "anita.desai@arsene-tech.example", courses: ["Control Systems", "SPI Tag Configuration"], batches: ["Batch B"], students: 22, status: "active" },
  { id: "trn_003", name: "Karthik Raman", email: "karthik.raman@arsene-tech.example", courses: ["Process Safety", "Advanced Process Control"], batches: ["Batch C"], students: 18, status: "active" },
  { id: "trn_004", name: "Meena Iyengar", email: "meena.iyengar@arsene-tech.example", courses: ["Instrumentation Basics"], batches: [], students: 0, status: "invited" },
  { id: "trn_005", name: "Suresh Pillai", email: "suresh.pillai@arsene-tech.example", courses: ["Control Systems"], batches: ["Batch B"], students: 15, status: "inactive" },
];
