"use client";

import { useState, useTransition } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { Card, CardContent, CardFooter } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { createClassAction, updateClassAction } from "@/services/classes.actions";
import type { ClassValidationErrors, ClassWithRelations, CreateClassInput } from "@/types/class";
import type { ClassFilterOptions } from "@/types/class";

export interface ClassFormProps {
  options: ClassFilterOptions;
  /** Present when editing; omitted when creating. */
  initial?: ClassWithRelations;
  /** Where to return after save/cancel, e.g. "/admin/classes". */
  basePath: string;
  /** Trainers can't reassign a class to someone else. */
  lockTrainer?: boolean;
}

function emptyDraft(): CreateClassInput {
  return {
    courseId: "",
    moduleId: null,
    batchId: "",
    trainerId: "",
    title: "",
    description: null,
    classDate: "",
    startTime: "",
    endTime: "",
    teamsMeetingUrl: null,
    classType: "online",
    status: "scheduled",
    notes: null,
  };
}

function toDraft(c: ClassWithRelations): CreateClassInput {
  return {
    courseId: c.courseId,
    moduleId: c.moduleId,
    batchId: c.batchId,
    trainerId: c.trainerId,
    title: c.title,
    description: c.description,
    classDate: c.classDate,
    startTime: c.startTime,
    endTime: c.endTime,
    teamsMeetingUrl: c.teamsMeetingUrl,
    classType: c.classType,
    status: c.status,
    notes: c.notes,
  };
}

export function ClassForm({ options, initial, basePath, lockTrainer = false }: ClassFormProps) {
  const isEdit = Boolean(initial);
  const [draft, setDraft] = useState<CreateClassInput>(() => (initial ? toDraft(initial) : emptyDraft()));
  const [errors, setErrors] = useState<ClassValidationErrors>({});
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const { showToast } = useToast();

  function set<K extends keyof CreateClassInput>(key: K, value: CreateClassInput[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  // Only selectable entries (published course — or an archived one that
  // still has an upcoming/ongoing batch — upcoming/ongoing batch, active
  // trainer) are offered — plus the class's current value when
  // editing, so an existing class still shows what it's linked to.
  const availableCourses = options.courses.filter((c) => c.selectable || c.id === initial?.courseId);
  const availableTrainers = options.trainers.filter((t) => t.selectable || t.id === initial?.trainerId);

  // Modules and batches are scoped to the chosen course so an invalid
  // course/module or course/batch pairing can't be submitted.
  const availableModules = options.modules.filter((m) => m.courseId === draft.courseId);
  const availableBatches = options.batches.filter(
    (b) => b.courseId === draft.courseId && (b.selectable || b.id === initial?.batchId)
  );

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors({});

    startTransition(async () => {
      const result = isEdit && initial
        ? await updateClassAction(initial.id, draft)
        : await createClassAction(draft);

      if (!result.ok) {
        setErrors(result.errors ?? {});
        // Field errors are shown inline; only surface a toast for a
        // form-level failure so it isn't missed.
        if (result.errors?.form) {
          showToast({ variant: "error", title: "Couldn't save the class", description: result.errors.form });
        }
        return;
      }

      showToast({
        variant: "success",
        title: isEdit ? "Class updated successfully." : "Class created successfully.",
      });
      router.push(result.classId ? `${basePath}/${result.classId}` : basePath);
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <Card>
        <CardContent className="flex flex-col gap-5">
          {errors.form && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-redSoft px-3 py-2.5 text-sm text-signal-red"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{errors.form}</span>
            </div>
          )}

          <Input
            label="Class title"
            name="title"
            value={draft.title}
            onChange={(e) => set("title", e.target.value)}
            error={errors.title}
            disabled={isPending}
            placeholder="e.g. Instrument Index"
            autoFocus
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select
              label="Course"
              name="courseId"
              value={draft.courseId}
              onChange={(e) => {
                set("courseId", e.target.value);
                // Clear a module/batch (and the batch's trainer) that
                // belong to the previous course.
                set("moduleId", null);
                set("batchId", "");
                if (!lockTrainer) set("trainerId", "");
              }}
              error={errors.courseId}
              disabled={isPending}
              placeholder="Select a course"
              options={availableCourses.map((c) => ({ label: c.status === "archived" ? `${c.title} (inactive — existing batches only)` : c.title, value: c.id }))}
            />

            <Select
              label="Module (optional)"
              name="moduleId"
              value={draft.moduleId ?? ""}
              onChange={(e) => set("moduleId", e.target.value || null)}
              error={errors.moduleId}
              disabled={isPending || !draft.courseId}
              hint={!draft.courseId ? "Choose a course first." : undefined}
              placeholder="No specific module"
              options={availableModules.map((m) => ({ label: m.title, value: m.id }))}
            />

            <Select
              label="Batch"
              name="batchId"
              value={draft.batchId}
              onChange={(e) => {
                const batchId = e.target.value;
                set("batchId", batchId);
                // A class's trainer is its batch's assigned trainer
                // (enforced by the database), so follow the batch.
                if (!lockTrainer) {
                  const batch = options.batches.find((b) => b.id === batchId);
                  set("trainerId", batch?.trainerId ?? "");
                }
              }}
              error={errors.batchId}
              disabled={isPending || !draft.courseId}
              hint={!draft.courseId ? "Choose a course first." : undefined}
              placeholder="Select a batch"
              options={availableBatches.map((b) => ({ label: b.name, value: b.id }))}
            />

            <Select
              label="Trainer"
              name="trainerId"
              value={draft.trainerId}
              onChange={(e) => set("trainerId", e.target.value)}
              error={errors.trainerId}
              disabled={isPending || lockTrainer}
              hint={lockTrainer ? "Classes you schedule are assigned to you." : undefined}
              placeholder="Select a trainer"
              options={availableTrainers.map((t) => ({ label: t.name, value: t.id }))}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Input
              label="Date"
              name="classDate"
              type="date"
              value={draft.classDate}
              onChange={(e) => set("classDate", e.target.value)}
              error={errors.classDate}
              disabled={isPending}
            />
            <Input
              label="Start time"
              name="startTime"
              type="time"
              value={draft.startTime}
              onChange={(e) => set("startTime", e.target.value)}
              error={errors.startTime}
              disabled={isPending}
            />
            <Input
              label="End time"
              name="endTime"
              type="time"
              value={draft.endTime}
              onChange={(e) => set("endTime", e.target.value)}
              error={errors.endTime}
              disabled={isPending}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select
              label="Class type"
              name="classType"
              value={draft.classType}
              onChange={(e) => set("classType", e.target.value as CreateClassInput["classType"])}
              disabled={isPending}
              options={[
                { label: "Online", value: "online" },
                { label: "Offline", value: "offline" },
                { label: "Hybrid", value: "hybrid" },
              ]}
            />
            <Select
              label="Status"
              name="status"
              value={draft.status}
              onChange={(e) => set("status", e.target.value as CreateClassInput["status"])}
              disabled={isPending}
              options={[
                { label: "Scheduled", value: "scheduled" },
                { label: "Live", value: "live" },
                { label: "Completed", value: "completed" },
                { label: "Cancelled", value: "cancelled" },
              ]}
            />
          </div>

          <Input
            label="Teams meeting link (optional)"
            name="teamsMeetingUrl"
            type="url"
            inputMode="url"
            value={draft.teamsMeetingUrl ?? ""}
            onChange={(e) => set("teamsMeetingUrl", e.target.value || null)}
            error={errors.teamsMeetingUrl}
            disabled={isPending}
            placeholder="https://teams.microsoft.com/l/meetup-join/…"
            hint="Students see a Join button when this is set."
          />

          <div className="flex flex-col gap-1.5">
            <label htmlFor="description" className="text-sm font-medium text-ink">
              Description (optional)
            </label>
            <textarea
              id="description"
              name="description"
              rows={3}
              value={draft.description ?? ""}
              onChange={(e) => set("description", e.target.value || null)}
              disabled={isPending}
              className="rounded border border-surface-border bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-signal-blue"
              placeholder="What this class covers…"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="notes" className="text-sm font-medium text-ink">
              Internal notes (optional)
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={2}
              value={draft.notes ?? ""}
              onChange={(e) => set("notes", e.target.value || null)}
              disabled={isPending}
              className="rounded border border-surface-border bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-signal-blue"
              placeholder="Only visible to admins and trainers."
            />
          </div>
        </CardContent>

        <CardFooter>
          <Button type="button" variant="secondary" onClick={() => router.push(basePath)} disabled={isPending}>
            Cancel
          </Button>
          {/* isLoading also disables the button, preventing duplicate submissions. */}
          <Button type="submit" isLoading={isPending}>
            {isPending ? "Saving…" : isEdit ? "Save changes" : "Create class"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
