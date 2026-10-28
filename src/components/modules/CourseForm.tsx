"use client";

import { useState, useTransition } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Lock } from "lucide-react";
import { Card, CardContent, CardFooter } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { createCourseAction, updateCourseAction } from "@/services/courses.actions";
import { HISTORY_LOCK_MESSAGE } from "@/lib/courses/course-management";
import { COURSE_INPUT_LIMITS, type CourseLevel, type CourseValidationErrors, type CreateCourseInput } from "@/types/course";

interface Draft {
  title: string;
  description: string;
  level: string;
  durationHours: string;
  status: string;
}

export interface CourseFormInitial {
  id: string;
  courseCode?: string;
  title: string;
  description: string;
  level?: CourseLevel;
  durationHours: number;
}

const LEVEL_OPTIONS = [
  { label: "Foundation", value: "foundation" },
  { label: "Intermediate", value: "intermediate" },
  { label: "Advanced", value: "advanced" },
];

/**
 * Add / Edit Course (Super Admin). The course code is assigned by the
 * database when the course is created and never changes; it is shown,
 * never typed. A new course starts as Draft (not offered for batches) or
 * Active (published). When the course already has delivered training (`locked`),
 * title, level and planned duration are read-only — the database refuses
 * those changes anyway (0030) — and only the description can be edited.
 */
export function CourseForm({ basePath, initial, locked = false }: { basePath: string; initial?: CourseFormInitial; locked?: boolean }) {
  const editing = Boolean(initial);
  const [draft, setDraft] = useState<Draft>({
    title: initial?.title ?? "",
    description: initial?.description ?? "",
    level: initial?.level ?? "",
    durationHours: initial ? String(initial.durationHours) : "",
    status: "draft",
  });
  const [errors, setErrors] = useState<CourseValidationErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const { showToast } = useToast();

  const set = (key: keyof Draft, value: string) => setDraft((prev) => ({ ...prev, [key]: value }));
  const cancelHref = initial ? `${basePath}/${initial.id}` : basePath;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isPending) return;
    setErrors({});
    setFormError(null);
    const hours = draft.durationHours.trim();
    const details = {
      title: draft.title,
      description: draft.description,
      level: draft.level as CourseLevel,
      durationHours: /^\d+(\.\d+)?$/.test(hours) ? Number(hours) : Number.NaN,
    };
    // Editing sends only what changed: an unchanged (possibly legacy) value is never re-validated or rewritten.
    const changes: Partial<typeof details> = {};
    if (initial) {
      if (details.title.trim() !== initial.title.trim()) changes.title = details.title;
      if (details.description.trim() !== initial.description.trim()) changes.description = details.description;
      if (details.level !== initial.level) changes.level = details.level;
      if (hours !== String(initial.durationHours)) changes.durationHours = details.durationHours;
    }
    startTransition(async () => {
      const result = initial
        ? await updateCourseAction(initial.id, changes)
        : await createCourseAction({ ...details, status: draft.status as CreateCourseInput["status"] });
      if (!result.ok) {
        // One place per error: field messages beside their fields, anything else in the form banner (no toast).
        setErrors(result.errors ?? {});
        setFormError(result.errors && Object.keys(result.errors).length > 0 ? null : result.error);
        return;
      }
      showToast({ variant: "success", title: result.message });
      router.push(initial ? `${basePath}/${initial.id}` : result.courseId ? `${basePath}/${result.courseId}` : basePath);
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <Card>
        <CardContent className="flex flex-col gap-5">
          {formError && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-redSoft px-3 py-2.5 text-sm text-signal-red">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{formError}</span>
            </div>
          )}
          {locked && (
            <div role="note" className="flex items-start gap-2 rounded-md border border-surface-border bg-surface-sunken px-3 py-2.5 text-sm text-ink-muted">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{HISTORY_LOCK_MESSAGE}</span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Course code"
              name="courseCode"
              value={initial?.courseCode ?? "Assigned automatically when the course is created"}
              readOnly
              disabled
              hint={editing ? "Course codes never change." : "For example CRS-00012. Unique and permanent."}
            />
            <Input
              label="Course title"
              name="title"
              value={draft.title}
              onChange={(e) => set("title", e.target.value)}
              error={errors.title}
              disabled={isPending || locked}
              maxLength={COURSE_INPUT_LIMITS.titleMax}
              placeholder="e.g. Instrumentation Fundamentals"
              hint="One catalogue course is reused by every batch — don't create a copy per batch."
              autoFocus={!locked}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="description" className="text-sm font-medium text-ink">
              Description (optional)
            </label>
            <textarea
              id="description"
              name="description"
              rows={3}
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              disabled={isPending}
              maxLength={COURSE_INPUT_LIMITS.descriptionMax}
              aria-invalid={Boolean(errors.description)}
              className="rounded border border-surface-border bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-signal-blue"
              placeholder="What this course covers…"
            />
            {errors.description && <span className="text-xs text-signal-red">{errors.description}</span>}
          </div>

          <div className={editing ? "grid grid-cols-1 gap-4 sm:grid-cols-2" : "grid grid-cols-1 gap-4 sm:grid-cols-3"}>
            <Select
              label="Level"
              name="level"
              value={draft.level}
              onChange={(e) => set("level", e.target.value)}
              error={errors.level}
              disabled={isPending || locked}
              placeholder="Select a level"
              options={LEVEL_OPTIONS}
            />
            <Input
              label="Planned duration (hours)"
              name="durationHours"
              type="number"
              inputMode="decimal"
              min={0.5}
              step={0.5}
              value={draft.durationHours}
              onChange={(e) => set("durationHours", e.target.value)}
              error={errors.durationHours}
              disabled={isPending || locked}
              placeholder="e.g. 40"
              hint="Total planned training hours for the whole course."
            />
            {!editing && (
              <Select
                label="Status"
                name="status"
                value={draft.status}
                onChange={(e) => set("status", e.target.value)}
                error={errors.status}
                disabled={isPending}
                options={[
                  { label: "Draft", value: "draft" },
                  { label: "Active (published)", value: "published" },
                ]}
              />
            )}
          </div>

          {!editing && (
            <p className="text-xs text-ink-muted">
              Only <strong>Active</strong> courses can be selected for new batches. A draft can be deleted until it is first published. Add modules on the course page after creating it.
            </p>
          )}
        </CardContent>

        <CardFooter>
          <Button type="button" variant="secondary" onClick={() => router.push(cancelHref)} disabled={isPending}>
            Cancel
          </Button>
          {/* isLoading also disables the button, preventing duplicate submissions. */}
          <Button type="submit" isLoading={isPending}>
            {editing ? (isPending ? "Saving…" : "Save changes") : isPending ? "Creating…" : "Create course"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
