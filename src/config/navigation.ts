import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  BookOpen,
  Users,
  GraduationCap,
  Layers,
  CalendarDays,
  ClipboardCheck,
  FileQuestion,
  HelpCircle,
  LineChart,
  FileBarChart,
  Award,
  Bell,
  Settings,
  ShieldCheck,
  UserCog,
} from "lucide-react";

export type PortalRole = "admin" | "trainer" | "student";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

/**
 * Sidebar navigation, keyed by portal role. Each route below is a
 * PART 1 placeholder — see the module's page component for its
 * current implementation status.
 */
export const navigationByRole: Record<PortalRole, NavItem[]> = {
  admin: [
    { label: "Dashboard", href: "/admin", icon: LayoutDashboard },
    { label: "Courses", href: "/admin/courses", icon: BookOpen },
    { label: "Users", href: "/admin/users", icon: UserCog },
    { label: "Trainers", href: "/admin/trainers", icon: Users },
    { label: "Students", href: "/admin/students", icon: GraduationCap },
    { label: "Batches", href: "/admin/batches", icon: Layers },
    { label: "Classes", href: "/admin/classes", icon: CalendarDays },
    { label: "Attendance", href: "/admin/attendance", icon: ClipboardCheck },
    { label: "Tests", href: "/admin/tests", icon: FileQuestion },
    { label: "Exam Monitoring", href: "/admin/exam-monitoring", icon: ShieldCheck },
    { label: "Question Bank", href: "/admin/questions", icon: HelpCircle },
    { label: "Performance", href: "/admin/performance", icon: LineChart },
    { label: "Reports", href: "/admin/reports", icon: FileBarChart },
    { label: "Certificates", href: "/admin/certificates", icon: Award },
    { label: "Notifications", href: "/admin/notifications", icon: Bell },
    { label: "Settings", href: "/admin/settings", icon: Settings },
  ],
  trainer: [
    { label: "Dashboard", href: "/trainer", icon: LayoutDashboard },
    { label: "Courses", href: "/trainer/courses", icon: BookOpen },
    { label: "Students", href: "/trainer/students", icon: GraduationCap },
    { label: "Batches", href: "/trainer/batches", icon: Layers },
    { label: "Classes", href: "/trainer/classes", icon: CalendarDays },
    { label: "Attendance", href: "/trainer/attendance", icon: ClipboardCheck },
    { label: "Tests", href: "/trainer/tests", icon: FileQuestion },
    { label: "Exam Monitoring", href: "/trainer/exam-monitoring", icon: ShieldCheck },
    { label: "Question Bank", href: "/trainer/questions", icon: HelpCircle },
    { label: "Performance", href: "/trainer/performance", icon: LineChart },
    { label: "Reports", href: "/trainer/reports", icon: FileBarChart },
    { label: "Certificates", href: "/trainer/certificates", icon: Award },
    { label: "Notifications", href: "/trainer/notifications", icon: Bell },
  ],
  student: [
    { label: "Dashboard", href: "/student", icon: LayoutDashboard },
    { label: "Courses", href: "/student/courses", icon: BookOpen },
    { label: "Classes", href: "/student/classes", icon: CalendarDays },
    { label: "Attendance", href: "/student/attendance", icon: ClipboardCheck },
    { label: "Tests", href: "/student/tests", icon: FileQuestion },
    { label: "Results", href: "/student/results", icon: LineChart },
    { label: "Performance", href: "/student/performance", icon: FileBarChart },
    { label: "Certificates", href: "/student/certificates", icon: Award },
    { label: "Notifications", href: "/student/notifications", icon: Bell },
  ],
};

export const portalLabel: Record<PortalRole, string> = {
  admin: "Admin",
  trainer: "Trainer",
  student: "Student",
};
