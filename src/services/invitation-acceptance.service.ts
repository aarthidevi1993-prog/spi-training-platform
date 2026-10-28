import "server-only";
import { invitationAcceptanceRepository } from "@/repositories/invitation-acceptance.repository";
import { createInvitationAcceptanceService } from "./invitation-acceptance.service.core";

/** The invitation acceptance service bound to the invitee's own session (see the repository). */
export const invitationAcceptanceService = createInvitationAcceptanceService({
  repository: invitationAcceptanceRepository,
});

export type { AcceptPageState } from "./invitation-acceptance.service.core";
