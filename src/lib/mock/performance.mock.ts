/** PART 3 UI-only mock data for the Performance analytics page. */
export const performanceSummary = {
  overall: 78,
  averageScore: 81,
  attendance: 92,
  testsCompleted: 48,
};

export const topicPerformance = [
  { topic: "Pressure Instruments", score: 88 },
  { topic: "Flow Measurement", score: 82 },
  { topic: "Control Valves", score: 74 },
  { topic: "Loop Diagrams", score: 65 },
  { topic: "Safety Systems", score: 58 },
];

export const strongTopics = ["Pressure Instruments", "Flow Measurement", "Temperature Sensors"];
export const weakTopics = ["Safety Systems", "Loop Diagrams"];
export const recommendedImprovements = [
  "Revisit the Safety Instrumented Systems module before the next test.",
  "Practice reading loop drawings with the P&ID Fundamentals exercises.",
  "Schedule a 1:1 review with your trainer on control valve sizing.",
];
