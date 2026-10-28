// Course detail → Classes tab: the real CourseClassesList rendered to static HTML, plus the wiring in
// the three portals (each loads the course's classes through the role-scoped classes service).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const build = process.env.COURSES_BUILD;
const { renderToStaticMarkup } = await import(process.env.COURSES_REACT_DOM_SERVER);
const React = await import(process.env.COURSES_REACT);
const list = await import(`${build}/components/modules/CourseClassesList.mjs`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const render = (classes, basePath = "/admin/classes") => renderToStaticMarkup(React.createElement(list.CourseClassesList, { classes, basePath }));

const cls = (over = {}) => ({
  id: "c-1",
  courseId: "course-1",
  moduleId: "m-1",
  batchId: "b-1",
  trainerId: "t-1",
  title: "Loop tuning workshop",
  description: null,
  classDate: "2026-10-20",
  startTime: "10:00",
  endTime: "11:30",
  teamsMeetingUrl: null,
  status: "scheduled",
  classType: "online",
  notes: null,
  createdBy: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  courseTitle: "Control Systems",
  moduleTitle: "PID basics",
  batchName: "Batch Oct-26",
  trainerName: "Trainer One",
  ...over,
});

test("classes tab: lists each class with its module, batch, date, time and status, linked to the portal's class page", () => {
  const html = render([cls(), cls({ id: "c 2", title: "Orientation", moduleId: null, moduleTitle: null, status: "cancelled" })], "/trainer/classes");
  assert.match(html, /href="\/trainer\/classes\/c-1"[^>]*>Loop tuning workshop<\/a>/);
  assert.match(html, /PID basics · Batch Oct-26/, "the class↔module link is shown");
  assert.match(html, /10:00–11:30/);
  assert.match(html, /20 Oct 2026/);
  // A class without a module says so; ids are URL-encoded.
  assert.match(html, /href="\/trainer\/classes\/c%202"[^>]*>Orientation<\/a>/);
  assert.match(html, /No specific module · Batch Oct-26/);
  assert.match(html, /Scheduled/);
  assert.match(html, /Cancelled/);
  // Order is the service's (newest first): rendered as given.
  assert.ok(html.indexOf("Loop tuning workshop") < html.indexOf("Orientation"));
});

test("classes tab: empty course → the empty state; failed read → an error notice (not an empty state)", () => {
  const empty = render([]);
  assert.match(empty, new RegExp(list.COURSE_CLASSES_EMPTY_TITLE));
  assert.doesNotMatch(empty, /role="alert"/);
  const failed = render(null);
  assert.match(failed, /role="alert"/);
  assert.match(failed, /We couldn(&#x27;|')t load this course(&#x27;|')s classes/);
  assert.doesNotMatch(failed, new RegExp(list.COURSE_CLASSES_EMPTY_TITLE), "a read failure is never shown as 'no classes'");
  // Class text is escaped by React (no HTML injection from a class title).
  assert.match(render([cls({ title: "<b>x</b>" })]), /&lt;b&gt;x&lt;\/b&gt;/);
});

test("classes tab wiring: every portal loads the course's classes through the scoped service; failures don't break the course page", () => {
  const service = src("src/services/courses.service.ts");
  // Delegates to classesService (which resolves the caller's role scope server-side) — no new read path.
  assert.match(service, /async listCourseClasses\(courseId: string\): Promise<ClassWithRelations\[\] \| null> \{\s*try \{\s*return await classesService\.listClasses\(\{ courseId \}\);\s*\} catch \(err\) \{[\s\S]*?return null;/);
  for (const [portal, file] of [
    ["admin", "src/app/admin/courses/[courseId]/page.tsx"],
    ["trainer", "src/app/trainer/courses/[courseId]/page.tsx"],
    ["student", "src/app/student/courses/[courseId]/page.tsx"],
  ]) {
    const page = src(file);
    assert.match(page, /coursesService\.listCourseClasses\(course\.id\)/, file);
    assert.match(page, new RegExp(`<CourseClassesList classes=\\{[^}]+\\} basePath="/${portal}/classes" />`), file);
    // Loaded only after the course itself was found in the caller's scope.
    assert.ok(page.indexOf("if (!course) notFound();") < page.indexOf("listCourseClasses("), file);
  }
  // The admin page passes the classes in every branch (missing 0030, demo, full management).
  assert.equal((src("src/app/admin/courses/[courseId]/page.tsx").match(/classesPanel=\{classesPanel\}/g) ?? []).length, 3);
  // The view keeps its empty state as the fallback when no panel is given.
  const view = src("src/components/modules/CourseDetailView.tsx");
  assert.match(view, /<TabsContent value="classes">\s*\{classesPanel \?\? \(/);
});
