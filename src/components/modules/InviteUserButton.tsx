"use client";

import { useState } from "react";
import { ShieldPlus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { InviteUserDialog, type InviteBatchOption, type InviteKind } from "./InviteUserDialog";

const LABEL: Record<InviteKind, string> = { student: "Add Student", trainer: "Add Trainer", super_admin: "Invite Super Admin" };

/**
 * The Add Student / Add Trainer / Invite Super Admin (P3.12) header button
 * and its invitation dialog. Open/close state only — no business logic.
 */
export function InviteUserButton({ kind, batches }: { kind: InviteKind; batches?: InviteBatchOption[] }) {
  const [open, setOpen] = useState(false);
  const Icon = kind === "super_admin" ? ShieldPlus : UserPlus;
  return (
    <>
      <Button size="sm" variant={kind === "super_admin" ? "secondary" : "primary"} onClick={() => setOpen(true)}>
        <Icon className="h-4 w-4" /> {LABEL[kind]}
      </Button>
      <InviteUserDialog kind={kind} open={open} onClose={() => setOpen(false)} batches={batches} />
    </>
  );
}
