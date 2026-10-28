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
import { createBatchAction } from "@/services/batches.actions";
import type { BatchFormOptions, BatchValidationErrors } from "@/types/batch";

interface Draft {
  batchCode: string;
  name: string;
  courseId: string;
  trainerId: string;
  startDate: string;
  endDate: string;
  maxSeats: string;
}

const EMPTY: Draft = { batchCode: "", name: "", courseId: "", trainerId: "", startDate: "", endDate: "", maxSeats: "" };

/**
 * Add Batch (Super Admin). New batches are always created as "upcoming";
 * there is no status field. The trainer may be left unassigned.
 */
export function BatchForm({ options, basePath }: { options: BatchFormOptions; basePath: string }) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<BatchValidationErrors>({});
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const { showToast } = useToast();

  const set = (key: keyof Draft, value: string) => setDraft((prev) => ({ ...prev, [key]: value }));
  const courses = options.courses.filter((c) => c.selectable);
  const trainers = options.trainers.filter((t) => t.selectable);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    const seats = draft.maxSeats.trim();
    startTransition(async () => {
      const result = await createBatchAction({
        batchCode: draft.batchCode,
        name: draft.name,
        courseId: draft.courseId,
        trainerId: draft.trainerId || null,
        startDate: draft.startDate,
        endDate: draft.endDate,
        maxSeats: /^\d+$/.test(seats) ? Number(seats) : Number.NaN,
      });
      if (!result.ok) {
        setErrors(result.errors ?? {});
        if (result.errors?.form) showToast({ variant: "error", title: "Couldn't create the batch", description: result.errors.form });
        return;
      }
      showToast({ variant: "success", title: "Batch created successfully." });
      router.push(basePath);
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <Card>
        <CardContent className="flex flex-col gap-5">
          {errors.form && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-redSoft px-3 py-2.5 text-sm text-signal-red">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{errors.form}</span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Batch code"
              name="batchCode"
              value={draft.batchCode}
              onChange={(e) => set("batchCode", e.target.value)}
              error={errors.batchCode}
              disabled={isPending}
              placeholder="e.g. SPI-2026-B04"
              hint="Must be unique."
              autoFocus
            />
            <Input
              label="Batch name"
              name="name"
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              error={errors.name}
              disabled={isPending}
              placeholder="e.g. SPI Fundamentals — October 2026"
            />
            <Select
              label="Course"
              name="courseId"
              value={draft.courseId}
              onChange={(e) => set("courseId", e.target.value)}
              error={errors.courseId}
              disabled={isPending}
              placeholder="Select a course"
              hint={courses.length === 0 ? "No active courses are available." : undefined}
              options={courses.map((c) => ({ label: c.title, value: c.id }))}
            />
            <Select
              label="Trainer (optional)"
              name="trainerId"
              value={draft.trainerId}
              onChange={(e) => set("trainerId", e.target.value)}
              error={errors.trainerId}
              disabled={isPending}
              placeholder="Not assigned yet"
              hint="You can assign a trainer later."
              options={trainers.map((t) => ({ label: t.name, value: t.id }))}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Input
              label="Start date"
              name="startDate"
              type="date"
              value={draft.startDate}
              onChange={(e) => set("startDate", e.target.value)}
              error={errors.startDate}
              disabled={isPending}
            />
            <Input
              label="End date"
              name="endDate"
              type="date"
              value={draft.endDate}
              min={draft.startDate || undefined}
              onChange={(e) => set("endDate", e.target.value)}
              error={errors.endDate}
              disabled={isPending}
            />
            <Input
              label="Max seats"
              name="maxSeats"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={draft.maxSeats}
              onChange={(e) => set("maxSeats", e.target.value)}
              error={errors.maxSeats}
              disabled={isPending}
              placeholder="e.g. 30"
            />
          </div>

          <p className="text-xs text-ink-muted">New batches start as <strong>Upcoming</strong>. Students are enrolled separately.</p>
        </CardContent>

        <CardFooter>
          <Button type="button" variant="secondary" onClick={() => router.push(basePath)} disabled={isPending}>
            Cancel
          </Button>
          {/* isLoading also disables the button, preventing duplicate submissions. */}
          <Button type="submit" isLoading={isPending}>
            {isPending ? "Creating…" : "Create batch"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
