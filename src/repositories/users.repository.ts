import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createUsersRepository } from "./users.repository.core";

/**
 * The Users repository bound to the caller's own Supabase session
 * (cookies; RLS applies). Never the service-role client.
 */
export const usersRepository = createUsersRepository(createSupabaseServerClient);

export { UsersRepositoryError } from "./users.repository.core";
export type { UsersRepository } from "./users.repository.core";
