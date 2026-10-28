export interface CourseModule {
  id: string;
  courseId: string;
  moduleCode: string;
  title: string;
  description?: string;
  sequence: number;
  durationHours: number;
}
