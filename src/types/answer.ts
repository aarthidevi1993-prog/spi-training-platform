export interface Answer {
  id: string;
  attemptId: string;
  questionId: string;
  selectedOptionIds?: string[];
  textAnswer?: string;
  isCorrect?: boolean;
  marksAwarded?: number;
}
