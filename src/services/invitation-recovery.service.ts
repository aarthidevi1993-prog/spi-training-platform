import "server-only";
import { invitationAcceptanceRepository } from "@/repositories/invitation-acceptance.repository";
import { createInvitationRecoveryService } from "./invitation-recovery.service.core";

/** The invitation recovery service (P5.2) bound to the person's own session (never the service role). */
export const invitationRecoveryService = createInvitationRecoveryService({
  repository: invitationAcceptanceRepository,
});
