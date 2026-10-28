"use client";

import { useState } from "react";
import { Info, PencilLine, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { ClassAssignmentsPanelData } from "@/types/assignment";
import { AssignmentCard } from "./AssignmentCard";
import { AssignmentEditor } from "./AssignmentEditor";

/**
 * Class detail → Assignment tab. Managers (super admin / the batch's
 * current trainer) create, edit, publish, close and review; students see
 * published/closed assignments and their own submission; a previous
 * trainer sees assignment details only.
 */
export function AssignmentsPanel({ data }: { data: ClassAssignmentsPanelData }) {
  const [creating, setCreating] = useState(false);
  const isManager = data.viewer === "manager";
  const canCreate = isManager && !data.classCancelled;

  return (
    <div className="flex flex-col gap-4">
      {data.notice && (
        <div className="flex items-start gap-2 rounded-md border border-surface-border bg-surface px-3 py-2.5 text-sm text-ink-muted">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{data.notice}</span>
        </div>
      )}

      {canCreate &&
        (creating ? (
          <AssignmentEditor classId={data.classId} onDone={() => setCreating(false)} />
        ) : (
          <div>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New assignment
            </Button>
          </div>
        ))}

      {data.assignments.length === 0 ? (
        <EmptyState
          icon={PencilLine}
          title="No assignments yet"
          description={
            isManager
              ? "Create a draft, then publish it when it's ready for students."
              : "Assignments for this class will appear here once they're published."
          }
        />
      ) : (
        data.assignments.map((a) => (
          <AssignmentCard key={a.id} assignment={a} viewer={data.viewer} classCancelled={data.classCancelled} />
        ))
      )}
    </div>
  );
}
