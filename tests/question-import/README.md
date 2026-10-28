# Bulk Question Import — core tests

Pure unit tests for `src/lib/question-import` and `src/types/question-import.ts`.

```
node tests/question-import/run.mjs
```

`run.mjs` transpiles the TypeScript core with the project's own `typescript`
into a temporary folder and runs Node's built-in test runner — no extra
packages and no `package.json` scripts.

## Fingerprint parity with 0013

`fixtures/fingerprint-vectors.json` holds inputs (from
`fixtures/make-vector-inputs.mjs`) together with the values computed by the
**real 0013 SQL functions** on PostgreSQL 18:

- `public.question_import_normalize(text)` → `expected.normalizedText` / `normalizedOptions`
- `public.question_import_fingerprint(course_id, type, text, options)` → `expected.fingerprint`
- `public.question_import_text_fingerprint(course_id, text)` → `expected.textFingerprint`

The tests require the TypeScript implementation to reproduce every value
exactly. If 0013's formula ever changes, regenerate the file by running, on a
database with 0013 applied:

```sql
select jsonb_pretty(jsonb_agg(v || jsonb_build_object('expected', jsonb_build_object(
  'normalizedText',    public.question_import_normalize(v->>'text'),
  'normalizedOptions', (select jsonb_agg(public.question_import_normalize(o) order by n)
                          from jsonb_array_elements_text(v->'options') with ordinality x(o, n)),
  'fingerprint',       public.question_import_fingerprint((v->>'courseId')::uuid, (v->>'type')::public.question_type, v->>'text',
                          array(select o from jsonb_array_elements_text(v->'options') with ordinality x(o, n) order by n)),
  'textFingerprint',   public.question_import_text_fingerprint((v->>'courseId')::uuid, v->>'text'))) order by i))
from jsonb_array_elements(:'inputs'::jsonb) with ordinality e(v, i);
```

where `inputs` is `JSON.stringify(VECTOR_INPUTS)`.
