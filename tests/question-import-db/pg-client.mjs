// A minimal stand-in for the Supabase JS client, executing against a local
// PostgreSQL through psql. Each request runs in its own session as the
// given role ("authenticated" / "anon") with request.jwt.claims set, so RLS,
// grants and the 0013 functions behave as they do behind PostgREST.
// Supports exactly what question-import.repository.core.ts uses:
//   rpc(fn, args) · from(table).select(cols) · eq · in · gt · gte · lte · order · limit · maybeSingle
// plus range(from, to) and several order() calls, applied in sequence as PostgREST does
// (trainer-dashboard.repository.core.ts pages on a multi-column order).
// plus PostgREST resource embedding in select (users.repository.core.ts):
//   "id, students!students_id_fkey ( code, student_details ( email ) )"
// resolved from the real foreign keys like PostgREST does (to-one → object or
// null, to-many → array); each embedded table is read under the same role, so
// RLS applies to it exactly as behind PostgREST.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SET_RETURNING = new Set(["question_import_fingerprints"]);

function lit(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) return quote(`{${value.join(",")}}`); // untyped array literal (e.g. uuid[])
    return dollar(JSON.stringify(value)); // jsonb
  }
  if (typeof value === "object") return dollar(JSON.stringify(value));
  return quote(String(value));
}
const quote = (s) => `'${s.replace(/'/g, "''")}'`;
function dollar(s) {
  let tag = "qi";
  while (s.includes(`$${tag}$`)) tag += "x";
  return `$${tag}$${s}$${tag}$`;
}
const ident = (name) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad identifier ${name}`);
  return name;
};

// --- PostgREST resource embedding -------------------------------------------
/** "a, b!fk ( c, d ( e ) )" → [{ name, hint, children }]. */
function parseSelect(text) {
  let i = 0;
  const skip = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  function list(nested) {
    const items = [];
    for (;;) {
      skip();
      const m = /^([a-z_][a-z0-9_]*)(?:!([a-z_][a-z0-9_]*))?/.exec(text.slice(i));
      if (!m) throw new Error(`bad select near "${text.slice(i, i + 20)}"`);
      i += m[0].length;
      skip();
      let children = null;
      if (text[i] === "(") {
        i++;
        children = list(true);
      }
      items.push({ name: ident(m[1]), hint: m[2] ?? null, children });
      skip();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (nested && text[i] === ")") {
        i++;
        return items;
      }
      if (!nested && i >= text.length) return items;
      throw new Error(`bad select near "${text.slice(i, i + 20)}"`);
    }
  }
  return list(false);
}

/** Foreign keys between public tables: { name, child, childCols, parent, parentCols, unique (child cols are a PK/unique key) }. */
const FK_QUERY = `select coalesce(jsonb_agg(jsonb_build_object(
    'name', c.conname, 'child', cr.relname, 'parent', pr.relname,
    'childCols', (select jsonb_agg(a.attname order by k.ord) from unnest(c.conkey) with ordinality k(n, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n),
    'parentCols', (select jsonb_agg(a.attname order by k.ord) from unnest(c.confkey) with ordinality k(n, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n),
    'unique', exists (select 1 from pg_constraint u where u.conrelid = c.conrelid and u.contype in ('p', 'u')
                        and (select array_agg(x order by x) from unnest(u.conkey) x) = (select array_agg(x order by x) from unnest(c.conkey) x)))), '[]'::jsonb)
  from pg_constraint c
  join pg_class cr on cr.oid = c.conrelid join pg_namespace cn on cn.oid = cr.relnamespace
  join pg_class pr on pr.oid = c.confrelid join pg_namespace pn on pn.oid = pr.relnamespace
 where c.contype = 'f' and cn.nspname = 'public' and pn.nspname = 'public'`;

function renderEmbedded(table, alias, items, fks, next) {
  const parts = items.map((it) => {
    if (!it.children) {
      if (it.hint) throw new Error(`hint on plain column ${it.name}`);
      return `'${it.name}', ${alias}.${it.name}`;
    }
    const candidates = fks.filter(
      (f) => (!it.hint || f.name === it.hint) && ((f.child === it.name && f.parent === table) || (f.child === table && f.parent === it.name))
    );
    // PostgREST refuses missing (PGRST200) and ambiguous (PGRST201) relationships the same way.
    if (candidates.length !== 1) throw new Error(`embed ${table} -> ${it.name}: ${candidates.length} relationships found`);
    const f = candidates[0];
    const ea = `e${next()}`;
    const body = renderEmbedded(it.name, ea, it.children, fks, next);
    const childSide = f.child === it.name; // the embedded table holds the foreign key
    const cond = f.childCols
      .map((col, k) => (childSide ? `${ea}.${col} = ${alias}.${f.parentCols[k]}` : `${ea}.${f.parentCols[k]} = ${alias}.${col}`))
      .join(" and ");
    const sub =
      !childSide || f.unique
        ? `(select ${body} from public.${it.name} ${ea} where ${cond} limit 1)`
        : `coalesce((select jsonb_agg(${body}) from public.${it.name} ${ea} where ${cond}), '[]'::jsonb)`;
    return `'${it.name}', ${sub}`;
  });
  return `jsonb_build_object(${parts.join(", ")})`;
}

export class PgDatabase {
  constructor({ psql, host = "localhost", port, user = "postgres", database }) {
    Object.assign(this, { psql, host, port, user, database });
  }
  /** Run SQL (whole script) and return { stdout, stderr, code }. */
  run(sql) {
    const file = path.join(os.tmpdir(), `qi-${randomUUID()}.sql`);
    fs.writeFileSync(file, sql, "utf8");
    return new Promise((resolve) => {
      execFile(
        this.psql,
        ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-h", this.host, "-p", String(this.port), "-U", this.user, "-d", this.database, "-f", file],
        { env: { ...process.env, PGCLIENTENCODING: "UTF8" }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
        (error, stdout, stderr) => {
          fs.rmSync(file, { force: true });
          resolve({ stdout, stderr, code: error ? error.code ?? 1 : 0 });
        }
      );
    });
  }
  /** Run one query as the superuser (test setup) and return its single JSON value. */
  async admin(query) {
    // jsonb text is always one line (json_agg output is not).
    const { stdout, stderr, code } = await this.run(`select to_jsonb((${query}))::text;`);
    if (code) throw new Error(stderr);
    const line = stdout.split(/\r?\n/).filter(Boolean).pop();
    return line === undefined ? null : JSON.parse(line);
  }
  /** Run statements as the superuser with a signed-in user's claims (e.g. bank edits by the normal editor). */
  async exec(sql, userId = null) {
    const claims = userId ? JSON.stringify({ sub: userId }) : "";
    const { stderr, code } = await this.run(`select set_config('request.jwt.claims', ${quote(claims)}, false);\n${sql}`);
    if (code) throw new Error(stderr);
  }
  client(identity) {
    return new PgClient(this, identity);
  }
  /** Foreign keys of the public schema (cached; read as the superuser, like PostgREST's schema cache). */
  async foreignKeys() {
    this.fkCache ??= await this.admin(FK_QUERY);
    return this.fkCache;
  }
}

export class PgClient {
  /** identity: { role: "authenticated" | "anon" | "service_role", userId?: string, sessionId?: string (the JWT "session_id" claim), amr?: { method: string, timestamp: number }[] (the JWT "amr" claim) } */
  constructor(db, identity) {
    this.db = db;
    this.identity = identity;
  }
  rpc(fn, args = {}) {
    return new Builder(this, { kind: "rpc", fn: ident(fn), args });
  }
  from(table) {
    return {
      select: (cols, opts) => {
        // Exact HEAD counts (select("id", { count: "exact", head: true })), as the dashboard repository uses: no rows, only `count`.
        if (opts !== undefined && !(opts && opts.count === "exact" && opts.head === true)) throw new Error("only { count: 'exact', head: true } is supported");
        return new Builder(this, { kind: "select", table: ident(table), cols, count: opts !== undefined });
      },
    };
  }
  /** Raw SQL (JSON-returning) under this identity. */
  async sql(query) {
    return this.execute(`select coalesce(to_jsonb((${query})), 'null'::jsonb)::text`);
  }
  async execute(query) {
    const { role, userId, sessionId, amr } = this.identity;
    // amr (P5.2): the JWT "amr" claim — the sign-in methods and their Unix timestamps — as Supabase Auth issues it.
    const claims = userId ? JSON.stringify({ sub: userId, ...(sessionId ? { session_id: sessionId } : {}), ...(amr ? { amr } : {}) }) : "";
    const dbRole = role === "anon" || role === "service_role" ? role : "authenticated";
    const sql = `set role ${dbRole};\nselect set_config('request.jwt.claims', ${quote(claims)}, false);\n${query};\n`;
    const { stdout, stderr, code } = await this.db.run(sql);
    if (code) {
      const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(stderr);
      return { data: null, error: { code: m ? m[1] : "XX000", message: m ? m[2].trim() : stderr.trim() } };
    }
    const line = stdout.split(/\r?\n/).filter(Boolean).pop();
    return { data: line === undefined ? null : JSON.parse(line), error: null };
  }
}

class Builder {
  constructor(client, spec) {
    this.client = client;
    this.spec = spec;
    this.filters = [];
    this.orders = [];
    this.limitN = null;
    this.offsetN = null;
    this.single = false;
  }
  eq(col, v) { this.filters.push(`${ident(col)} = ${lit(v)}`); return this; }
  gt(col, v) { this.filters.push(`${ident(col)} > ${lit(v)}`); return this; }
  gte(col, v) { this.filters.push(`${ident(col)} >= ${lit(v)}`); return this; }
  lte(col, v) { this.filters.push(`${ident(col)} <= ${lit(v)}`); return this; }
  in(col, values) { this.filters.push(values.length ? `${ident(col)} in (${values.map(lit).join(", ")})` : "false"); return this; }
  order(col, opts = {}) { this.orders.push(`${ident(col)} ${opts.ascending === false ? "desc" : "asc"}`); return this; }
  limit(n) { this.limitN = n; return this; }
  range(from, to) { this.offsetN = from; this.limitN = to - from + 1; return this; }
  maybeSingle() { this.single = true; return this; }

  toSql(fks = null) {
    const where = this.filters.length ? ` where ${this.filters.join(" and ")}` : "";
    const order = this.orders.length ? ` order by ${this.orders.join(", ")}` : "";
    const limit = (this.limitN !== null ? ` limit ${Number(this.limitN)}` : "") + (this.offsetN !== null ? ` offset ${Number(this.offsetN)}` : "");
    const { spec } = this;
    if (spec.kind === "select" && fks) {
      let n = 0;
      const row = renderEmbedded(spec.table, "t0", parseSelect(spec.cols), fks, () => ++n);
      return `select coalesce(jsonb_agg(t.x), '[]'::jsonb)::text from (select ${row} as x from public.${spec.table} t0${where}${order}${limit}) t`;
    }
    if (spec.kind === "rpc") {
      const args = Object.entries(spec.args).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(", ");
      const call = `public.${spec.fn}(${args})`;
      if (SET_RETURNING.has(spec.fn)) return `select coalesce(jsonb_agg(t), '[]'::jsonb)::text from (select * from ${call}${where}${order}${limit}) t`;
      return `select to_jsonb(${call})::text`;
    }
    const cols = spec.cols.split(",").map((c) => ident(c.trim())).join(", ");
    return `select coalesce(jsonb_agg(t), '[]'::jsonb)::text from (select ${cols} from public.${spec.table}${where}${order}${limit}) t`;
  }
  async execute() {
    if (this.spec.count) {
      const where = this.filters.length ? ` where ${this.filters.join(" and ")}` : "";
      const result = await this.client.execute(`select count(*)::text from public.${this.spec.table}${where}`);
      if (result.error) return { data: null, count: null, error: result.error };
      return { data: null, count: Number(result.data), error: null };
    }
    const embeds = this.spec.kind === "select" && this.spec.cols.includes("(");
    const result = await this.client.execute(this.toSql(embeds ? await this.client.db.foreignKeys() : null));
    if (result.error || !this.single) return result;
    return { data: Array.isArray(result.data) ? result.data[0] ?? null : result.data, error: null };
  }
  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}
