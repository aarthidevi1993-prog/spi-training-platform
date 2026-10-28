"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, MoreHorizontal, Pencil, Trash2, HelpCircle, Plus, CheckCircle2, Archive, RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "@/components/ui/Table";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { QuestionBankTransferMenu } from "./QuestionBankTransferMenu";
import { useToast } from "@/components/ui/Toast";
import {
  activateQuestion,
  archiveQuestion,
  deleteDraftQuestion,
  restoreQuestion,
  type QuestionActionResult,
} from "@/services/questions.actions";
import type { QuestionBankData, QuestionDetail } from "@/types/question";
import { QuestionEditor, QUESTION_TYPE_LABEL } from "./QuestionEditor";

export interface QuestionsViewProps {
  data: QuestionBankData;
}

type EditorState = { mode: "create" } | { mode: "edit"; question: QuestionDetail } | null;

/**
 * Question Bank list for super admins and current course trainers:
 * search + course/status filters, a create/edit modal, and lifecycle
 * actions valid for each status (draft: edit/activate/delete*;
 * active: edit/archive; archived: restore). *Delete is super admin only.
 */
export function QuestionsView({ data }: QuestionsViewProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [courseFilter, setCourseFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [editor, setEditor] = useState<EditorState>(null);
  const [toDelete, setToDelete] = useState<QuestionDetail | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.questions.filter(
      (question) =>
        (q === "" || question.text.toLowerCase().includes(q)) &&
        (courseFilter === "all" || question.courseId === courseFilter) &&
        (statusFilter === "all" || question.status === statusFilter)
    );
  }, [data.questions, query, courseFilter, statusFilter]);

  if (!data.enabled) {
    return (
      <EmptyState
        icon={HelpCircle}
        title="Question Bank requires Supabase mode."
        description="Sign in with a Supabase account to create and manage questions."
      />
    );
  }

  function runAction(action: () => Promise<QuestionActionResult>, success: string, failure: string) {
    startTransition(async () => {
      const result = await action();
      setToDelete(null);
      if (!result.ok) {
        showToast({ variant: "error", title: failure, description: result.error });
        return;
      }
      showToast({ variant: "success", title: success });
      router.refresh();
    });
  }

  const canCreate = data.courses.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input
              aria-label="Search questions"
              placeholder="Search questions…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select
            aria-label="Filter by course"
            value={courseFilter}
            onChange={(e) => setCourseFilter(e.target.value)}
            className="sm:w-56"
            options={[
              { label: "All courses", value: "all" },
              ...data.courses.map((c) => ({ label: `${c.code} — ${c.title}`, value: c.id })),
            ]}
          />
          <Select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="sm:w-40"
            options={[
              { label: "All statuses", value: "all" },
              { label: "Draft", value: "draft" },
              { label: "Active", value: "active" },
              { label: "Archived", value: "archived" },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <QuestionBankTransferMenu />
          <Button size="sm" onClick={() => setEditor({ mode: "create" })} disabled={!canCreate || isPending}>
            <Plus className="h-4 w-4" /> Add question
          </Button>
        </div>
      </div>

      {!canCreate && data.questions.length === 0 ? (
        <EmptyState
          icon={HelpCircle}
          title="No courses to manage yet"
          description="You can add questions once you're the trainer of an upcoming or ongoing batch."
        />
      ) : data.questions.length === 0 ? (
        <EmptyState
          icon={HelpCircle}
          title="No questions yet"
          description="Add a question, then activate it when it's ready to be used in tests."
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={HelpCircle} title="No questions match your filters" description="Try a different search, course or status." />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Question</TableHeaderCell>
              <TableHeaderCell>Course / Module</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Marks</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell className="text-right">Actions</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filtered.map((q) => (
              <TableRow key={q.id}>
                <TableCell className="max-w-sm">
                  <p className="truncate font-medium text-ink">{q.text}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">{q.optionCount} options</p>
                </TableCell>
                <TableCell>
                  <p className="text-ink">{q.courseCode || q.courseTitle}</p>
                  <p className="text-xs text-ink-muted">{q.moduleTitle ?? "Course-level"}</p>
                </TableCell>
                <TableCell>{QUESTION_TYPE_LABEL[q.type]}</TableCell>
                <TableCell>{q.marks}</TableCell>
                <TableCell>
                  <StatusBadge status={q.status} />
                </TableCell>
                <TableCell className="text-right">
                  <Dropdown
                    align="right"
                    trigger={
                      <button
                        aria-label={`Actions for question: ${q.text}`}
                        disabled={isPending}
                        className="rounded p-1.5 text-ink-muted hover:bg-surface-sunken"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    }
                  >
                    {q.status !== "archived" && (
                      <DropdownItem onClick={() => setEditor({ mode: "edit", question: q })}>
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </DropdownItem>
                    )}
                    {q.status === "draft" && (
                      <DropdownItem
                        onClick={() => runAction(() => activateQuestion(q.id), "Question activated.", "Couldn't activate the question")}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" /> Activate
                      </DropdownItem>
                    )}
                    {q.status === "active" && (
                      <DropdownItem
                        onClick={() => runAction(() => archiveQuestion(q.id), "Question archived.", "Couldn't archive the question")}
                      >
                        <Archive className="h-3.5 w-3.5" /> Archive
                      </DropdownItem>
                    )}
                    {q.status === "archived" && (
                      <DropdownItem
                        onClick={() => runAction(() => restoreQuestion(q.id), "Question restored.", "Couldn't restore the question")}
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> Restore
                      </DropdownItem>
                    )}
                    {data.canDelete && q.status === "draft" && (
                      <DropdownItem onClick={() => setToDelete(q)} className="text-signal-red">
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </DropdownItem>
                    )}
                  </Dropdown>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {editor && (
        <QuestionEditor
          key={editor.mode === "edit" ? editor.question.id : "new"}
          courses={data.courses}
          question={editor.mode === "edit" ? editor.question : undefined}
          onClose={() => setEditor(null)}
        />
      )}

      <Dialog
        isOpen={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={() => {
          const target = toDelete;
          if (target) runAction(() => deleteDraftQuestion(target.id), "Draft question deleted.", "Couldn't delete the question");
        }}
        title="Delete this draft question?"
        description="It will be removed permanently. Only drafts that were never activated can be deleted."
        confirmLabel="Delete draft"
        tone="danger"
        isLoading={isPending}
      />
    </div>
  );
}
