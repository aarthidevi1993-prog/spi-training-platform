import type { ClassWithRelations } from "@/types/class";

/**
 * Demo-mode class data.
 *
 * Used ONLY when the app is running in demo auth mode (no Supabase
 * project configured) — see src/config/auth.ts. When Supabase is
 * configured, classesRepository queries the real `classes` table and
 * this file is never read. Shaped as ClassWithRelations so demo mode
 * and the real joined query return exactly the same type.
 *
 * IDs are UUID-shaped so they behave the same as real rows in
 * routing and lookups.
 */

const COURSE_SPI = "11111111-1111-4111-8111-111111111101";
const COURSE_CONTROL = "11111111-1111-4111-8111-111111111102";
const COURSE_SAFETY = "11111111-1111-4111-8111-111111111103";

const MODULE_FUNDAMENTALS = "22222222-2222-4222-8222-222222222201";
const MODULE_SENSORS = "22222222-2222-4222-8222-222222222202";
const MODULE_LOOPS = "22222222-2222-4222-8222-222222222203";

const BATCH_A = "33333333-3333-4333-8333-333333333301";
const BATCH_B = "33333333-3333-4333-8333-333333333302";
const BATCH_C = "33333333-3333-4333-8333-333333333303";

const TRAINER_RAJESH = "44444444-4444-4444-8444-444444444401";
const TRAINER_ANITA = "44444444-4444-4444-8444-444444444402";
const TRAINER_KARTHIK = "44444444-4444-4444-8444-444444444403";

/** Demo identity mapping, mirroring DEMO_ACCOUNTS in src/config/auth.ts. */
export const DEMO_TRAINER_ID = TRAINER_RAJESH;
export const DEMO_STUDENT_BATCH_ID = BATCH_A;

function iso(daysFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
}

const base = {
  description: null,
  teamsMeetingUrl: null,
  notes: null,
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  moduleTitle: null as string | null,
};

export const mockClasses: ClassWithRelations[] = [
  {
    ...base,
    id: "55555555-5555-4555-8555-555555555501",
    courseId: COURSE_SPI,
    moduleId: MODULE_FUNDAMENTALS,
    batchId: BATCH_A,
    trainerId: TRAINER_RAJESH,
    title: "Instrument Index",
    description: "Building and maintaining the instrument index inside SPI, including tag conventions.",
    classDate: iso(0),
    startTime: "09:00",
    endTime: "12:00",
    teamsMeetingUrl: "https://teams.microsoft.com/l/meetup-join/demo-instrument-index",
    status: "scheduled",
    classType: "online",
    courseTitle: "SPI Training",
    moduleTitle: "Instrumentation Fundamentals",
    batchName: "Batch A",
    trainerName: "Rajesh Kumar",
  },
  {
    ...base,
    id: "55555555-5555-4555-8555-555555555502",
    courseId: COURSE_SPI,
    moduleId: MODULE_SENSORS,
    batchId: BATCH_A,
    trainerId: TRAINER_RAJESH,
    title: "Sensors and Transmitters",
    description: "Selection and configuration of field sensors and transmitters.",
    classDate: iso(2),
    startTime: "10:00",
    endTime: "13:00",
    teamsMeetingUrl: "https://teams.microsoft.com/l/meetup-join/demo-sensors",
    status: "scheduled",
    classType: "online",
    courseTitle: "SPI Training",
    moduleTitle: "Sensors and Transmitters",
    batchName: "Batch A",
    trainerName: "Rajesh Kumar",
  },
  {
    ...base,
    id: "55555555-5555-4555-8555-555555555503",
    courseId: COURSE_CONTROL,
    moduleId: MODULE_LOOPS,
    batchId: BATCH_B,
    trainerId: TRAINER_ANITA,
    title: "Control Loop Configuration",
    description: "Configuring and tuning regulatory control loops.",
    classDate: iso(1),
    startTime: "14:00",
    endTime: "16:30",
    teamsMeetingUrl: null,
    status: "scheduled",
    classType: "hybrid",
    courseTitle: "Control Systems",
    moduleTitle: "Control Loops",
    batchName: "Batch B",
    trainerName: "Anita Desai",
  },
  {
    ...base,
    id: "55555555-5555-4555-8555-555555555504",
    courseId: COURSE_SPI,
    moduleId: MODULE_FUNDAMENTALS,
    batchId: BATCH_A,
    trainerId: TRAINER_RAJESH,
    title: "Introduction to Instrumentation",
    description: "Course orientation and instrumentation overview.",
    classDate: iso(-5),
    startTime: "09:00",
    endTime: "12:00",
    teamsMeetingUrl: null,
    status: "completed",
    classType: "offline",
    courseTitle: "SPI Training",
    moduleTitle: "Instrumentation Fundamentals",
    batchName: "Batch A",
    trainerName: "Rajesh Kumar",
  },
  {
    ...base,
    id: "55555555-5555-4555-8555-555555555505",
    courseId: COURSE_CONTROL,
    moduleId: null,
    batchId: BATCH_B,
    trainerId: TRAINER_ANITA,
    title: "Batch B Orientation",
    description: "Welcome session, schedule walkthrough and platform onboarding.",
    classDate: iso(-9),
    startTime: "11:00",
    endTime: "12:00",
    teamsMeetingUrl: null,
    status: "completed",
    classType: "online",
    courseTitle: "Control Systems",
    moduleTitle: null,
    batchName: "Batch B",
    trainerName: "Anita Desai",
  },
  {
    ...base,
    id: "55555555-5555-4555-8555-555555555506",
    courseId: COURSE_SAFETY,
    moduleId: null,
    batchId: BATCH_C,
    trainerId: TRAINER_KARTHIK,
    title: "Process Safety Workshop",
    description: "Cancelled — to be rescheduled after the plant shutdown window.",
    classDate: iso(-2),
    startTime: "10:00",
    endTime: "11:30",
    teamsMeetingUrl: null,
    status: "cancelled",
    classType: "offline",
    courseTitle: "Process Safety",
    moduleTitle: null,
    batchName: "Batch C",
    trainerName: "Karthik Raman",
  },
];

/** Filter option lists for the Classes filter bar, derived from the demo data. */
export const mockClassFilterOptions = {
  // All demo courses/batches/trainers are published/upcoming/active,
  // so every entry is selectable (same validity rules as Supabase mode).
  courses: [
    { id: COURSE_SPI, title: "SPI Training", selectable: true },
    { id: COURSE_CONTROL, title: "Control Systems", selectable: true },
    { id: COURSE_SAFETY, title: "Process Safety", selectable: true },
  ],
  modules: [
    { id: MODULE_FUNDAMENTALS, title: "Instrumentation Fundamentals", courseId: COURSE_SPI },
    { id: MODULE_SENSORS, title: "Sensors and Transmitters", courseId: COURSE_SPI },
    { id: MODULE_LOOPS, title: "Control Loops", courseId: COURSE_CONTROL },
  ],
  batches: [
    { id: BATCH_A, name: "Batch A", courseId: COURSE_SPI, trainerId: TRAINER_RAJESH, selectable: true },
    { id: BATCH_B, name: "Batch B", courseId: COURSE_CONTROL, trainerId: TRAINER_ANITA, selectable: true },
    { id: BATCH_C, name: "Batch C", courseId: COURSE_SAFETY, trainerId: TRAINER_KARTHIK, selectable: true },
  ],
  trainers: [
    { id: TRAINER_RAJESH, name: "Rajesh Kumar", selectable: true },
    { id: TRAINER_ANITA, name: "Anita Desai", selectable: true },
    { id: TRAINER_KARTHIK, name: "Karthik Raman", selectable: true },
  ],
};
