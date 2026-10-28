export type UserRole = "admin" | "trainer" | "student";

export type UserStatus = "active" | "inactive" | "invited";

export interface User {
  id: string;
  fullName: string;
  email: string;
  phone?: string;
  role: UserRole;
  status: UserStatus;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
}
