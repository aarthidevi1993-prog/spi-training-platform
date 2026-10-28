import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.COURSES_CORE) throw new Error("Run through tests/courses/run.mjs");
const lib = await import(process.env.COURSES_CORE);
const { createCourseManagementService } = await import(`${process.env.COURSES_BUILD}/services/course-management.service.core.mjs`);
const repoCore = await import(`${process.env.COURSES_BUILD}/repositories/course-management.repository.core.mjs`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const COURSE = "c0000000-0000-4000-8000-000000000001";
const MODULE = "d0000000-0000-4000-8000-000000000001";
const ADMIN = "a0000000-0000-4000-8000-000000000001";
const user = (role) => ({ id: ADMIN, email: "x@test", fullName: "X", role, isActive: true, createdAt: "2026-01-01" });
const course = (over = {}) => ({ title: "  Instrumentation Fundamentals ", description: " Sensors. ", level: "foundation", durationHours: 40, status: "draft", ...over });

/** A fake repository recording every call; answers can be overridden per method. */
function fakeRepo(answers = {}) {
  const calls = [];
  const ok = (data = {}) => ({ ok: true, data });
  const rec = (name, dflt) => async (...args) => {
    calls.push({ name, args });
    const a = answers[name];
    if (a instanceof Error) throw a;
    return a ?? dflt;
  };
  return {
    calls,
    repo: {
      createCourse: rec("createCourse", ok({ course_id: COURSE, course_code: "CRS-00007" })),
      updateCourse: rec("updateCourse", ok({ fields: ["title"] })),
      setCourseStatus: rec("setCourseStatus", ok({ from: "draft", to: "published" })),
      deleteCourse: rec("deleteCourse", ok({ course_code: "CRS-00007" })),
      createModule: rec("createModule", ok({ module_id: MODULE, module_code: "M03", sequence: 3 })),
      updateModule: rec("updateModule", ok({ fields: ["title"] })),
      moveModule: rec("moveModule", ok({ from: 2, to: 1 })),
      deleteModule: rec("deleteModule", ok({})),
      getUsage: rec("getUsage", { hasHistory: false, canDelete: true, batchCount: 0, classCount: 0, questionCount: 0, batches: [] }),
      listEvents: rec("listEvents", [
        { id: 2, occurred_at: "2026-10-10T10:00:00Z", event_type: "course_status_changed", actor_id: ADMIN, detail: { from: "draft", to: "published" } },
        { id: 1, occurred_at: "2026-10-10T09:00:00Z", event_type: "course_created", actor_id: "b0000000-0000-4000-8000-000000000009", detail: { course_code: "CRS-00007", status: "draft" } },
      ]),
    },
  };
}
const service = (role = "admin", answers = {}, demo = false) => {
  const f = fakeRepo(answers);
  return { ...f, svc: createCourseManagementService({ repository: f.repo, getCurrentUser: async () => (role ? user(role) : null), isDemo: () => demo }) };
};

// ---- validation ----
test("course validation: required title / level / hours, limits, one decimal, Draft or Published only", () => {
  assert.deepEqual(lib.validateCreateCourse(course()).errors, {});
  assert.deepEqual(lib.validateCreateCourse(course()).clean, { title: "Instrumentation Fundamentals", description: "Sensors.", level: "foundation", durationHours: 40, status: "draft" });
  const cases = [
    [{ title: " " }, "title"],
    [{ title: "T".repeat(151) }, "title"],
    [{ description: "d".repeat(2001) }, "description"],
    [{ level: "expert" }, "level"],
    [{ durationHours: -1 }, "durationHours"],
    [{ durationHours: 0 }, "durationHours"],
    [{ durationHours: undefined }, "durationHours"],
    [{ durationHours: Number.NaN }, "durationHours"],
    [{ durationHours: "40" }, "durationHours"],
    [{ durationHours: 10000 }, "durationHours"],
    [{ durationHours: 1.25 }, "durationHours"],
    [{ status: "archived" }, "status"],
  ];
  for (const [over, field] of cases) assert.ok(lib.validateCreateCourse(course(over)).errors[field], JSON.stringify(over));
  assert.equal(lib.validateCreateCourse(course({ durationHours: 12.5 })).errors.durationHours, undefined);
  assert.equal(lib.validateCreateCourse(course({ durationHours: 9999.9 })).errors.durationHours, undefined);
  assert.ok(!("courseCode" in lib.validateCreateCourse({ ...course(), courseCode: "HACK-1" }).clean), "a code is never part of the input");
});

test("module validation: title and planned hours (more than 0) required on add; hours optional (unchanged) on edit", () => {
  assert.deepEqual(lib.validateModule({ title: " Loops ", description: "", durationHours: 0.5 }), { errors: {}, clean: { title: "Loops", description: "", durationHours: 0.5 } });
  for (const bad of [0, -2, Number.NaN, "3", 1.25, 10000, undefined]) {
    assert.ok(lib.validateModule({ title: "x", durationHours: bad }).errors.durationHours, `add: ${String(bad)}`);
    if (bad !== undefined) assert.ok(lib.validateModuleUpdate({ title: "x", durationHours: bad }).errors.durationHours, `edit: ${String(bad)}`);
  }
  assert.match(lib.validateModule({ title: "x", durationHours: 0 }).errors.durationHours, /more than 0 hours/);
  // Edit without hours (unchanged): valid, and nothing about hours is sent — a legacy 0-hour module stays editable.
  assert.deepEqual(lib.validateModuleUpdate({ title: "x", description: "" }), { errors: {}, clean: { title: "x", description: "" } });
  assert.ok(lib.validateModule({ title: "" }).errors.title);
  assert.ok(lib.validateModule({ title: "x", description: "d".repeat(1001) }).errors.description);
  assert.ok(lib.validateModule({ title: "x" }).errors.durationHours, "missing hours are refused on add (never turned into 0)");
});

// ---- authorization ----
test("only a Super Admin: trainers, students and signed-out callers are refused before any database call", async () => {
  for (const role of ["trainer", "student", null]) {
    const { svc, calls } = service(role);
    const results = [
      await svc.createCourse(course()),
      await svc.updateCourse(COURSE, course()),
      await svc.setCourseStatus(COURSE, "archived"),
      await svc.deleteCourse(COURSE),
      await svc.createModule(COURSE, { title: "M" }),
      await svc.updateModule(MODULE, { title: "M" }),
      await svc.moveModule(MODULE, "up"),
      await svc.deleteModule(MODULE),
    ];
    for (const r of results) assert.equal(r.ok, false, String(role));
    assert.equal(calls.length, 0, `${role}: no database call`);
    await assert.rejects(svc.getManagement(COURSE), (e) => e.name === "CourseManagementAuthorizationError");
  }
  // Even invalid input from a non-admin gets the permission answer, not field errors.
  assert.equal((await service("trainer").svc.createCourse(course({ title: "" }))).error, lib.COURSE_PERMISSION_ERROR);
});

test("the database's own permission refusal (42501) and unexpected failures become fixed sentences", async () => {
  const perm = service("admin", { createCourse: new repoCore.CourseManagementPermissionError() });
  assert.deepEqual(await perm.svc.createCourse(course()), { ok: false, error: lib.COURSE_PERMISSION_ERROR });
  const boom = service("admin", { updateCourse: new Error("connection reset") });
  assert.deepEqual(await boom.svc.updateCourse(COURSE, course()), { ok: false, error: lib.COURSE_GENERIC_ERROR });
});

test("demo mode: writes are refused clearly; the page gets no management state", async () => {
  const { svc, calls } = service("admin", {}, true);
  assert.deepEqual(await svc.createCourse(course()), { ok: false, error: lib.COURSE_DEMO_ERROR });
  assert.equal(await svc.getManagement(COURSE), null);
  assert.equal(calls.length, 0);
});

// ---- create / edit payloads ----
test("create: only the known fields are sent (never a code); the generated code is reported", async () => {
  const { svc, calls } = service();
  const r = await svc.createCourse({ ...course({ status: "published" }), courseCode: "HACK-1", course_code: "HACK-2", id: COURSE });
  assert.deepEqual(r, { ok: true, message: "Course CRS-00007 created.", courseId: COURSE, courseCode: "CRS-00007" });
  assert.deepEqual(calls, [{ name: "createCourse", args: [{ title: "Instrumentation Fundamentals", description: "Sensors.", level: "foundation", duration_hours: 40, status: "published" }] }]);
});

test("edit: details only (no code, no status); invalid ids never reach the database", async () => {
  const { svc, calls } = service();
  assert.equal((await svc.updateCourse(COURSE, { ...course(), courseCode: "X", status: "archived" })).ok, true);
  assert.deepEqual(calls[0], { name: "updateCourse", args: [COURSE, { title: "Instrumentation Fundamentals", description: "Sensors.", level: "foundation", duration_hours: 40 }] });
  for (const bad of ["", "crs_001", "1; drop table courses", null, 42]) {
    assert.equal((await svc.updateCourse(bad, course())).ok, false);
    assert.equal((await svc.deleteCourse(bad)).ok, false);
    assert.equal((await svc.moveModule(bad, "up")).ok, false);
  }
  assert.equal((await svc.setCourseStatus(COURSE, "deleted")).ok, false);
  assert.equal((await svc.moveModule(MODULE, "sideways")).ok, false);
  assert.equal(calls.length, 1, "nothing else reached the repository");
});

test("validation errors come back per field and nothing is sent", async () => {
  const { svc, calls } = service();
  const r = await svc.createCourse(course({ title: "", level: "x" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.title && r.errors.level);
  assert.equal(calls.length, 0);
});

// ---- database refusals ----
test("refusals: duplicate title (with the existing code, on the title field), history lock, batches, in use, unchanged", async () => {
  const refuse = (reason, data = {}) => ({ ok: false, reason, data });
  const dup = await service("admin", { createCourse: refuse("duplicate_title", { existing_course_code: "CRS-00003" }) }).svc.createCourse(course());
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already exists \(CRS-00003\)\. Reuse that course/);
  assert.equal(dup.errors.title, dup.error);
  assert.match((await service("admin", { updateCourse: refuse("course_has_history") }).svc.updateCourse(COURSE, course())).error, /locked to protect batch history/);
  assert.match((await service("admin", { createModule: refuse("course_has_history") }).svc.createModule(COURSE, { title: "M", durationHours: 1 })).error, /locked/);
  assert.match((await service("admin", { setCourseStatus: refuse("has_batches") }).svc.setCourseStatus(COURSE, "draft")).error, /Deactivate it instead/);
  assert.match((await service("admin", { deleteCourse: refuse("course_in_use") }).svc.deleteCourse(COURSE)).error, /can't be deleted\. Deactivate it instead/);
  assert.match((await service("admin", { deleteModule: refuse("module_in_use") }).svc.deleteModule(MODULE)).error, /used by classes or questions/);
  assert.equal((await service("admin", { updateModule: refuse("unchanged") }).svc.updateModule(MODULE, { title: "M" })).error, "Nothing changed.");
  assert.match((await service("admin", { deleteCourse: refuse("not_found") }).svc.deleteCourse(COURSE)).error, /no longer exists/);
});

test("success messages: status changes explain their effect on batches", async () => {
  const { svc } = service();
  assert.match((await svc.setCourseStatus(COURSE, "archived")).message, /existing batches continue normally/);
  assert.match((await svc.setCourseStatus(COURSE, "published")).message, /new batches/);
  assert.equal((await svc.createModule(COURSE, { title: "Loops", durationHours: 1 })).message, "Module M03 added.");
});

test("getManagement: usage plus history as sentences; the caller's own actions read 'you'", async () => {
  const { svc } = service();
  const m = await svc.getManagement(COURSE);
  assert.equal(m.usage.canDelete, true);
  assert.deepEqual(m.history.map((h) => [h.actor, h.summary]), [
    ["you", "Status changed from Draft to Active."],
    ["b0000000-0000-4000-8000-000000000009", "Course created as draft (CRS-00007)."],
  ]);
  assert.equal(await svc.getManagement("not-a-uuid"), null);
});

test("status actions offered match what the database accepts", () => {
  assert.deepEqual(lib.statusActionsFor("draft", 0), ["published", "archived"]);
  assert.deepEqual(lib.statusActionsFor("published", 0), ["archived", "draft"]);
  assert.deepEqual(lib.statusActionsFor("published", 2), ["archived"], "no Move to draft once batches exist");
  assert.deepEqual(lib.statusActionsFor("archived", 3), ["published"]);
  assert.equal(lib.courseHistorySummary("course_updated", { fields: ["title", "duration_hours"] }), "Details changed: title, planned duration.");
  assert.equal(lib.courseHistorySummary("module_moved", { module_code: "M02", from: 2, to: 1 }), "Module M02 moved from position 2 to 1.");
});

// ---- wiring (source level) ----
test("forms and pages: no typed course code; writes only through the course server actions", () => {
  const form = strip(src("src/components/modules/CourseForm.tsx"));
  assert.match(form, /name="courseCode"[\s\S]*?readOnly\s+disabled/, "the code field is display-only");
  assert.doesNotMatch(form, /set\("courseCode"/, "the code is never editable");
  for (const f of ["src/components/modules/CourseForm.tsx", "src/components/modules/CourseAdminActions.tsx", "src/components/modules/CourseModulesManager.tsx"]) {
    const code = strip(src(f));
    assert.match(code, /from "@\/services\/courses\.actions"/, f);
    assert.doesNotMatch(code, /@\/services\/(?!courses\.actions)|@\/repositories\/|@\/lib\/supabase\/|SUPABASE_SERVICE_ROLE_KEY/, `${f} never touches the database directly`);
  }
  const actions = src("src/services/courses.actions.ts");
  assert.match(actions, /^"use server";/);
  assert.doesNotMatch(strip(actions), /@\/repositories\/|@\/lib\/supabase\//, "actions go through the service");
  assert.match(src("src/app/admin/courses/page.tsx"), /<Link href="\/admin\/courses\/new">/);
  assert.match(src("src/app/admin/courses/[courseId]/edit/page.tsx"), /locked=\{usage\.hasHistory\}/);
});

test("repository: database functions only — no direct table writes, never the service role", () => {
  const repo = strip(src("src/repositories/course-management.repository.core.ts"));
  assert.doesNotMatch(repo, /\.(insert|update|upsert|delete)\(/, "no direct writes (the 0030 guards refuse them anyway)");
  assert.match(repo, /await supabase\.rpc\(fn, /, "rpc is called as a method (supabase-js needs its client as `this`)");
  for (const fn of ["admin_create_course", "admin_update_course", "admin_set_course_status", "admin_delete_course", "admin_create_module", "admin_update_module", "admin_move_module", "admin_delete_module", "admin_course_usage"]) {
    assert.match(repo, new RegExp(`"${fn}"`), fn);
  }
  assert.doesNotMatch(src("src/repositories/course-management.repository.ts"), /createSupabaseAdminClient|SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(strip(src("src/repositories/courses.repository.ts")), /\.(insert|update|upsert|delete)\(/, "the read repository never writes");
});

test("role restrictions: trainer and student course pages are read-only; the shared view has no dead buttons", () => {
  for (const f of ["src/app/trainer/courses/[courseId]/page.tsx", "src/app/student/courses/[courseId]/page.tsx", "src/app/trainer/courses/page.tsx"]) {
    assert.doesNotMatch(src(f), /CourseAdminActions|CourseModulesManager|courseManagementService|courses\.actions|courses\/new/, f);
  }
  const view = strip(src("src/components/modules/CourseDetailView.tsx"));
  assert.doesNotMatch(view, /<Button/, "no placeholder buttons (Start Course / View) remain");
  assert.match(view, /actions=\{actions\}/);
});

// ---- review fixes ----
test("edit sends only the changed fields: an unchanged legacy value is never re-validated; a changed one always is", async () => {
  assert.deepEqual(lib.validateCourseDetailsPatch({ description: " Only this. " }), { errors: {}, patch: { description: "Only this." } });
  assert.deepEqual(lib.validateCourseDetailsPatch({}), { errors: {}, patch: {} });
  assert.ok(lib.validateCourseDetailsPatch({ title: "T".repeat(151) }).errors.title, "a new over-long title is refused");
  assert.ok(lib.validateCourseDetailsPatch({ title: "  " }).errors.title, "a title can't be blanked");
  assert.ok(lib.validateCourseDetailsPatch({ durationHours: -1 }).errors.durationHours);
  assert.deepEqual(lib.validateCourseDetailsPatch({ level: "advanced", courseCode: "X", status: "archived" }).patch, { level: "advanced" }, "unknown keys ignored");

  const { svc, calls } = service();
  assert.equal((await svc.updateCourse(COURSE, { description: "New." })).ok, true);
  assert.deepEqual(calls.at(-1), { name: "updateCourse", args: [COURSE, { description: "New." }] }, "only the description is sent");
  assert.equal((await svc.updateCourse(COURSE, {})).error, "Nothing changed.");
  assert.equal(calls.length, 1, "an empty edit never reaches the database");
});

test("the course form: edits send only changed fields; a refusal is shown once (inline), never also as a toast", () => {
  const form = strip(src("src/components/modules/CourseForm.tsx"));
  assert.match(form, /updateCourseAction\(initial\.id, changes\)/);
  assert.match(form, /if \(details\.title\.trim\(\) !== initial\.title\.trim\(\)\) changes\.title = details\.title;/);
  assert.equal((form.match(/showToast\(/g) ?? []).length, 1, "only the success toast remains");
  assert.match(form, /showToast\(\{ variant: "success"/);
  assert.match(lib.HISTORY_LOCK_MESSAGE, /attendance, tests, assignments or completion/);
});

test("archive confirmation: names what archiving affects (ongoing continue, upcoming closed, pending invitations)", () => {
  assert.deepEqual(lib.archiveImpactLines({ upcoming: 0, ongoing: 0, pendingInvitations: 0 }), []);
  assert.deepEqual(lib.archiveImpactLines(undefined), []);
  const lines = lib.archiveImpactLines({ upcoming: 2, ongoing: 1, pendingInvitations: 1 });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^1 ongoing batch continues normally, including new enrolments\.$/);
  assert.match(lines[1], /^2 upcoming batches keep its students and classes but will take no new students/);
  assert.match(lines[2], /^1 pending invitation into those upcoming batches will activate the account without enrolling it — revoke or re-issue it/);
  assert.match(lib.archiveImpactLines({ upcoming: 1, ongoing: 3, pendingInvitations: 2 })[0], /^3 ongoing batches continue/);
  const actions = src("src/components/modules/CourseAdminActions.tsx");
  assert.match(actions, /confirm\.kind === "status" && confirm\.status === "archived" && impactLines\.length > 0/);
  assert.match(src("src/app/admin/courses/[courseId]/page.tsx"), /pendingInvitations: management\.usage\.pendingUpcomingInvitationCount/);
  assert.match(src("src/components/modules/CourseAdminSections.tsx"), /usage\.batches\.length < usage\.batchCount/, "a truncated batch list says so");
});

test("REGRESSION: Course Detail on a database without migration 0030 — a specific 'migration missing' error, not 'Please try again'", async () => {
  // What Supabase answers when admin_course_usage (created by 0030) doesn't exist; 42883 is the Postgres equivalent.
  for (const code of ["PGRST202", "42883"]) {
    const client = { rpc: async () => ({ data: null, error: { code, message: "Could not find the function public.admin_course_usage(p_course_id) in the schema cache" } }) };
    const repo = repoCore.createCourseManagementRepository(async () => client);
    const saved = console.error;
    let logged = "";
    console.error = (...a) => { logged += a.join(" "); };
    try {
      await assert.rejects(repo.getUsage(COURSE), (e) => e instanceof repoCore.CourseManagementUnavailableError && e instanceof repoCore.CourseManagementRepositoryError, code);
      // The page loads management through the service: the same error reaches it (so it can show the right message).
      const svc = createCourseManagementService({ repository: repo, getCurrentUser: async () => user("admin") });
      await assert.rejects(svc.getManagement(COURSE), repoCore.CourseManagementUnavailableError);
      // Writes answer with the same explanation instead of "Something went wrong".
      const write = await createCourseManagementService({ repository: { ...repo, setCourseStatus: () => repo.setCourseStatus(COURSE, "archived") }, getCurrentUser: async () => user("admin") }).setCourseStatus(COURSE, "archived");
      assert.deepEqual(write, { ok: false, error: lib.COURSE_MIGRATION_MISSING_ERROR });
    } finally {
      console.error = saved;
    }
    assert.match(logged, /database function missing — migration 0030_course_management\.sql is not applied/, "the server log names the dependency");
    assert.doesNotMatch(logged, /schema cache/, "the raw database message is not logged or shown");
  }
  // Other database failures keep the generic error (no false "migration" claims).
  const other = repoCore.createCourseManagementRepository(async () => ({ rpc: async () => ({ data: null, error: { code: "08006", message: "connection failure" } }) }));
  const saved = console.error;
  console.error = () => {};
  try {
    await assert.rejects(other.getUsage(COURSE), (e) => e instanceof repoCore.CourseManagementRepositoryError && !(e instanceof repoCore.CourseManagementUnavailableError));
  } finally {
    console.error = saved;
  }
  // The detail and edit pages show the specific message for this error only.
  // The edit page needs the functions: it says exactly what is missing.
  assert.match(
    src("src/app/admin/courses/[courseId]/edit/page.tsx"),
    /if \(err instanceof CourseManagementUnavailableError\) \{\s*return <ErrorState title=\{COURSE_MIGRATION_MISSING_TITLE\} description=\{COURSE_MIGRATION_MISSING_ERROR\} \/>;/
  );
  // The detail page still shows the course read-only (as before 0030) when ONLY the management state is missing;
  // any other failure (including loading the course itself) still shows the error page.
  const detail = src("src/app/admin/courses/[courseId]/page.tsx");
  assert.match(detail, /management = await courseManagementService\.getManagement\(course\.id\);\s*\} catch \(err\) \{[\s\S]*?if \(!\(err instanceof CourseManagementUnavailableError\)\) throw err;/);
  assert.match(detail, /if \(!management\) \{[\s\S]*?return <CourseDetailView course=\{course\} backHref="\/admin\/courses" classesPanel=\{classesPanel\} \/>;/);
  // ...and, only when 0030 is missing (not in demo mode), says why the management controls are absent.
  assert.match(detail, /if \(!\(err instanceof CourseManagementUnavailableError\)\) throw err;\s*managementMissing = true;/);
  assert.match(detail, /if \(managementMissing\) \{[\s\S]*?\{COURSE_MIGRATION_MISSING_TITLE\}[\s\S]*?title=\{COURSE_MIGRATION_MISSING_ERROR\}|if \(managementMissing\) \{[\s\S]*?title=\{COURSE_MIGRATION_MISSING_ERROR\}[\s\S]*?\{COURSE_MIGRATION_MISSING_TITLE\}/);
  assert.match(detail, /return <ErrorState title="We couldn't load this course" description="Please try again\." \/>;/);
  assert.match(lib.COURSE_MIGRATION_MISSING_ERROR, /migration 0030_course_management\.sql/);
});

test("approved lifecycle wording: Draft / Active / Inactive; Publish / Deactivate / Reactivate; delete refusals explained", async () => {
  assert.deepEqual(["draft", "published", "archived"].map(lib.courseStatusLabel), ["Draft", "Active", "Inactive"]);
  assert.equal(lib.statusActionLabel("draft", "published"), "Publish");
  assert.equal(lib.statusActionLabel("archived", "published"), "Reactivate");
  assert.equal(lib.statusActionLabel("published", "archived"), "Deactivate");
  assert.equal(lib.courseHistorySummary("course_status_changed", { from: "published", to: "archived" }), "Status changed from Active to Inactive.");
  assert.match(lib.courseRefusalMessage("not_draft"), /Only a draft course can be deleted/);
  assert.match(lib.courseRefusalMessage("was_published"), /published before, so it is kept permanently/);
  const refuse = (reason) => ({ ok: false, reason, data: {} });
  assert.match((await service("admin", { deleteCourse: refuse("was_published") }).svc.deleteCourse(COURSE)).error, /Deactivate it instead/);
  // Reactivation vs first publication messages.
  const reactivated = await service("admin", { setCourseStatus: { ok: true, data: { from: "archived", to: "published" } } }).svc.setCourseStatus(COURSE, "published");
  assert.equal(reactivated.message, lib.COURSE_REACTIVATED_MESSAGE);
  const published = await service("admin", { setCourseStatus: { ok: true, data: { from: "draft", to: "published" } } }).svc.setCourseStatus(COURSE, "published");
  assert.match(published.message, /now active/);
  // Course badges show the lifecycle names; other badges are unchanged.
  assert.match(src("src/components/modules/CourseCard.tsx"), /label=\{courseStatusLabel\(course\.status\)\}/);
  assert.match(src("src/components/modules/CourseDetailView.tsx"), /label=\{courseStatusLabel\(course\.status\)\}/);
  assert.match(src("src/components/ui/StatusBadge.tsx"), /\{label \?\? toLabel\(status\)\}/);
});

test("course lists: a loading state for the admin and trainer course routes; 'no courses at all' is not shown as 'no search results'", () => {
  for (const [file, label] of [["src/app/admin/courses/loading.tsx", "Loading courses…"], ["src/app/trainer/courses/loading.tsx", "Loading courses…"]]) {
    assert.match(src(file), new RegExp(`return <LoadingState label="${label}" />;`), file);
  }
  const grid = src("src/components/modules/CoursesGrid.tsx");
  // The empty catalog / no assigned courses state comes first; the search message only when a filter hides courses.
  assert.match(grid, /if \(courses\.length === 0\) \{\s*return <EmptyState icon=\{BookOpen\} title=\{empty\.title\} description=\{empty\.description\} \/>;/);
  assert.ok(grid.indexOf("courses.length === 0") < grid.indexOf("No courses match your search"));
  assert.match(grid, /title: "No courses yet",\s*description: "Add the first course to start the SPI catalog\."/);
  // Hooks run before the early return (React rules of hooks).
  assert.ok(grid.indexOf("useMemo(") < grid.indexOf("if (courses.length === 0)"));
  assert.match(src("src/app/trainer/courses/page.tsx"), /empty=\{\{ title: "No courses assigned yet", description: "Courses appear here once you are assigned to a batch\." \}\}/);
  // The admin page keeps the default (Super Admin) wording.
  assert.match(src("src/app/admin/courses/page.tsx"), /<CoursesGrid courses=\{courses\} \/>/);
});
