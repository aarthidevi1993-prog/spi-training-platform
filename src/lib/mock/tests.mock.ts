/** PART 3 UI-only mock data for the Tests module and the student exam interface. */
export interface TestCardData {
  id: string;
  title: string;
  course: string;
  questions: number;
  durationMinutes: number;
  attempts: number;
  status: "draft" | "scheduled" | "active" | "closed";
}

export const testCards: TestCardData[] = [
  { id: "tst_001", title: "Instrumentation Basics - Test 1", course: "Instrumentation Basics", questions: 10, durationMinutes: 30, attempts: 24, status: "active" },
  { id: "tst_002", title: "Control Systems - Midterm", course: "Control Systems", questions: 20, durationMinutes: 45, attempts: 18, status: "active" },
  { id: "tst_003", title: "Process Safety - Final Exam", course: "Process Safety", questions: 25, durationMinutes: 60, attempts: 0, status: "scheduled" },
  { id: "tst_004", title: "P&ID Fundamentals - Quiz 1", course: "P&ID Fundamentals", questions: 8, durationMinutes: 15, attempts: 0, status: "draft" },
];

export interface MockExamOption {
  id: string;
  text: string;
}

export interface MockExamQuestion {
  id: string;
  prompt: string;
  options: MockExamOption[];
  correctOptionId: string;
}

export interface MockExamData {
  testTitle: string;
  courseLabel: string;
  durationMinutes: number;
  questions: MockExamQuestion[];
}

export const mockExam: MockExamData = {
  testTitle: "Instrumentation Basics - Test 1",
  courseLabel: "Tests / Instrumentation Basics",
  durationMinutes: 30,
  questions: [
    {
      id: "q1",
      prompt: "What is the primary function of a control valve in a process loop?",
      options: [
        { id: "a", text: "To measure flow rate" },
        { id: "b", text: "To regulate the flow of process fluid" },
        { id: "c", text: "To generate electrical signals" },
        { id: "d", text: "To store process fluid" },
      ],
      correctOptionId: "b",
    },
    {
      id: "q2",
      prompt: "Which signal type is most commonly used for analog field instrumentation?",
      options: [
        { id: "a", text: "0–5V" },
        { id: "b", text: "RS-232" },
        { id: "c", text: "4–20mA" },
        { id: "d", text: "24VAC" },
      ],
      correctOptionId: "c",
    },
    {
      id: "q3",
      prompt: "What is the main purpose of a pressure transmitter in a process control system?",
      options: [
        { id: "a", text: "To measure and convert pressure into an electrical signal" },
        { id: "b", text: "To control the flow rate" },
        { id: "c", text: "To increase the temperature" },
        { id: "d", text: "To filter the process fluid" },
      ],
      correctOptionId: "a",
    },
    {
      id: "q4",
      prompt: "In a P&ID, what does the tag \"FT-101\" most likely represent?",
      options: [
        { id: "a", text: "Flow transmitter, loop 101" },
        { id: "b", text: "Fuel tank, unit 101" },
        { id: "c", text: "Field terminal, panel 101" },
        { id: "d", text: "Fire trip, zone 101" },
      ],
      correctOptionId: "a",
    },
    {
      id: "q5",
      prompt: "Which of these is a safety instrumented function?",
      options: [
        { id: "a", text: "Displaying a trend chart on the HMI" },
        { id: "b", text: "Automatically shutting down a reactor on high pressure" },
        { id: "c", text: "Logging operator shift notes" },
        { id: "d", text: "Adjusting screen brightness" },
      ],
      correctOptionId: "b",
    },
    {
      id: "q6",
      prompt: "What does \"SIL\" stand for in process safety?",
      options: [
        { id: "a", text: "Signal Isolation Level" },
        { id: "b", text: "Safety Integrity Level" },
        { id: "c", text: "System Input Log" },
        { id: "d", text: "Standard Instrument List" },
      ],
      correctOptionId: "b",
    },
    {
      id: "q7",
      prompt: "A thermocouple is primarily used to measure:",
      options: [
        { id: "a", text: "Flow" },
        { id: "b", text: "Level" },
        { id: "c", text: "Temperature" },
        { id: "d", text: "Pressure" },
      ],
      correctOptionId: "c",
    },
    {
      id: "q8",
      prompt: "What is the purpose of a control loop's setpoint?",
      options: [
        { id: "a", text: "The desired target value the controller tries to maintain" },
        { id: "b", text: "The maximum safe operating pressure" },
        { id: "c", text: "The physical location of the instrument" },
        { id: "d", text: "The calibration date of the device" },
      ],
      correctOptionId: "a",
    },
    {
      id: "q9",
      prompt: "Which device converts a controller's output signal into physical valve movement?",
      options: [
        { id: "a", text: "Transmitter" },
        { id: "b", text: "Actuator" },
        { id: "c", text: "Indicator" },
        { id: "d", text: "Recorder" },
      ],
      correctOptionId: "b",
    },
    {
      id: "q10",
      prompt: "In SPI, what does a loop drawing primarily document?",
      options: [
        { id: "a", text: "Employee shift schedules" },
        { id: "b", text: "The wiring and configuration of an instrument loop" },
        { id: "c", text: "Plant financial budgets" },
        { id: "d", text: "Building floor plans" },
      ],
      correctOptionId: "b",
    },
  ],
};

export function getTestsForCourses(courses: string[]): TestCardData[] {
  return testCards.filter((t) => courses.includes(t.course));
}
