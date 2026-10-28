"use client";

import { useState, useTransition } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { createModuleAction, deleteModuleAction, moveModuleAction, updateModuleAction } from "@/services/courses.actions";
import { HISTORY_LOCK_MESSAGE } from "@/lib/courses/course-management";
import { COURSE_INPUT_LIMITS, type CourseDetailModule, type ModuleValidationErrors } from "@/types/course";

type Editing = { mode: "add" } | { mode: "edit"; module: CourseDetailModule };

/**
 * Super Admin module manager on the course page. Add / edit / reorder /
 * delete go through the 0030 functions (codes and positions assigned by
 * the database, every change audited). Once the course has delivered
 * training (`locked`) the structure is read-only, and a module used by
 * classes or questions can never be deleted — the database refuses both.
 */
export function CourseModulesManager({ courseId, modules, locked }: { courseId: string; modules: CourseDetailModule[]; locked: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<CourseDetailModule | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const totalHours = modules.reduce((sum, m) => sum + (m.durationHours ?? 0), 0);

  function move(m: CourseDetailModule, direction: "up" | "down") {
    if (isPending) return;
    startTransition(async () => {
      const result = await moveModuleAction(courseId, m.id, direction);
      if (!result.ok) showToast({ variant: "error", title: "Couldn't move the module", description: result.error });
      router.refresh();
    });
  }

  function remove() {
    if (!removing || isPending) return;
    setRemoveError(null);
    startTransition(async () => {
      const result = await deleteModuleAction(courseId, removing.id);
      if (!result.ok) {
        setRemoveError(result.error);
        router.refresh();
        return;
      }
      showToast({ variant: "success", title: result.message });
      setRemoving(null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {locked ? (
        <div role="note" className="flex items-start gap-2 rounded-md border border-surface-border bg-surface-sunken px-3 py-2.5 text-sm text-ink-muted">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{HISTORY_LOCK_MESSAGE}</span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-ink-muted">
            {modules.length} {modules.length === 1 ? "module" : "modules"} · {totalHours} planned module hours
          </p>
          <Button size="sm" onClick={() => setEditing({ mode: "add" })} disabled={isPending}>
            <Plus className="h-4 w-4" /> Add module
          </Button>
        </div>
      )}

      <Card>
        <div className="divide-y divide-surface-border">
          {modules.map((m, i) => (
            <div key={m.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 break-words">
                <p className="text-sm font-medium text-ink">
                  {m.sequence}. {m.title}
                </p>
                <p className="text-xs text-ink-muted">
                  {m.moduleCode && <span className="font-mono">{m.moduleCode}</span>}
                  {m.durationHours !== undefined && <> · {m.durationHours} h</>}
                  {m.description ? <> · {m.description}</> : null}
                </p>
              </div>
              {!locked && (
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button size="sm" variant="ghost" aria-label={`Move ${m.title} up`} disabled={isPending || i === 0} onClick={() => move(m, "up")}>
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move ${m.title} down`}
                    disabled={isPending || i === modules.length - 1}
                    onClick={() => move(m, "down")}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="secondary" disabled={isPending} onClick={() => setEditing({ mode: "edit", module: m })}>
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button size="sm" variant="ghost" className="text-signal-red" aria-label={`Delete ${m.title}`} disabled={isPending} onClick={() => (setRemoveError(null), setRemoving(m))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          ))}
          {modules.length === 0 && <p className="px-5 py-4 text-sm text-ink-muted">No modules yet.{locked ? "" : " Add the first module to outline the course."}</p>}
        </div>
      </Card>

      {editing && <ModuleDialog courseId={courseId} editing={editing} onClose={() => setEditing(null)} />}

      {removing && (
        <Modal
          isOpen
          onClose={isPending ? () => undefined : () => setRemoving(null)}
          title={`Delete module ${removing.moduleCode ?? ""}?`}
          description={`"${removing.title}" is removed and the later modules move up one place. A module used by classes or questions can't be deleted.`}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRemoving(null)} disabled={isPending}>
                Cancel
              </Button>
              <Button variant="danger" isLoading={isPending} disabled={isPending} onClick={remove}>
                Delete module
              </Button>
            </>
          }
        >
          {removeError && (
            <p role="alert" className="text-sm text-signal-red">
              {removeError}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}

function ModuleDialog({ courseId, editing, onClose }: { courseId: string; editing: Editing; onClose: () => void }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const initial = editing.mode === "edit" ? editing.module : null;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [hours, setHours] = useState(initial?.durationHours !== undefined ? String(initial.durationHours) : "");
  const [errors, setErrors] = useState<ModuleValidationErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (isPending) return;
    setErrors({});
    setFormError(null);
    const h = hours.trim();
    // Empty or invalid hours are sent as NaN and refused by the validation (never silently turned into 0).
    const durationHours = /^\d+(\.\d+)?$/.test(h) ? Number(h) : Number.NaN;
    // Editing sends the hours only when they changed, so an existing 0-hour module can still be renamed or described.
    const hoursChanged = !initial || h !== String(initial.durationHours ?? "");
    startTransition(async () => {
      const result = initial
        ? await updateModuleAction(courseId, initial.id, hoursChanged ? { title, description, durationHours } : { title, description })
        : await createModuleAction(courseId, { title, description, durationHours });
      if (!result.ok) {
        setErrors(result.errors ?? {});
        setFormError(result.errors && Object.keys(result.errors).length > 0 ? null : result.error);
        return;
      }
      showToast({ variant: "success", title: result.message });
      onClose();
      router.refresh();
    });
  }

  return (
    <Modal
      isOpen
      onClose={isPending ? () => undefined : onClose}
      title={initial ? `Edit module ${initial.moduleCode ?? ""}` : "Add module"}
      description={initial ? "Module codes and positions are kept." : "The module is added at the end; its code is assigned automatically."}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" form="module-form" isLoading={isPending}>
            {initial ? "Save module" : "Add module"}
          </Button>
        </>
      }
    >
      <form id="module-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        {formError && (
          <p role="alert" className="text-sm text-signal-red">
            {formError}
          </p>
        )}
        <Input label="Module title" name="moduleTitle" value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} maxLength={COURSE_INPUT_LIMITS.titleMax} disabled={isPending} autoFocus />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="moduleDescription" className="text-sm font-medium text-ink">
            Description (optional)
          </label>
          <textarea
            id="moduleDescription"
            name="moduleDescription"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={COURSE_INPUT_LIMITS.moduleDescriptionMax}
            disabled={isPending}
            aria-invalid={Boolean(errors.description)}
            className="rounded border border-surface-border bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-signal-blue"
          />
          {errors.description && <span className="text-xs text-signal-red">{errors.description}</span>}
        </div>
        <Input
          label="Planned hours (optional)"
          name="moduleHours"
          type="number"
          inputMode="decimal"
          min={0.5}
          step={0.5}
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          error={errors.durationHours}
          disabled={isPending}
          placeholder="e.g. 6"
        />
      </form>
    </Modal>
  );
}
