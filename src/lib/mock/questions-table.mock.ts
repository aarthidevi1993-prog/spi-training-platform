/** PART 3 UI-only mock rows for the Question Bank module. */
export interface QuestionTableRow {
  id: string;
  prompt: string;
  course: string;
  type: "single_choice" | "multiple_choice" | "true_false" | "short_answer";
  difficulty: "easy" | "medium" | "hard";
  marks: number;
  tags: string[];
}

export const questionTableRows: QuestionTableRow[] = [
  { id: "q_001", prompt: "What is the main purpose of a pressure transmitter?", course: "Instrumentation Basics", type: "single_choice", difficulty: "easy", marks: 2, tags: ["pressure", "transmitters"] },
  { id: "q_002", prompt: "Which signal type is most common for analog field instrumentation?", course: "Instrumentation Basics", type: "single_choice", difficulty: "easy", marks: 2, tags: ["signals"] },
  { id: "q_003", prompt: "Explain the difference between open-loop and closed-loop control.", course: "Control Systems", type: "short_answer", difficulty: "medium", marks: 5, tags: ["control-loops"] },
  { id: "q_004", prompt: "A SIL rating describes the reliability of a safety instrumented function.", course: "Process Safety", type: "true_false", difficulty: "medium", marks: 1, tags: ["safety", "SIL"] },
  { id: "q_005", prompt: "Select all valid actuator types used in control valves.", course: "Control Systems", type: "multiple_choice", difficulty: "hard", marks: 4, tags: ["valves", "actuators"] },
  { id: "q_006", prompt: "What does the tag \"FT-101\" represent on a P&ID?", course: "P&ID Fundamentals", type: "single_choice", difficulty: "medium", marks: 2, tags: ["tagging", "P&ID"] },
];

export function getQuestionsForCourse(course: string): QuestionTableRow[] {
  return questionTableRows.filter((q) => q.course === course);
}
