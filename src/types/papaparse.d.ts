/**
 * Minimal type declarations for the parts of papaparse (MIT) the bulk
 * question import uses. papaparse ships no types of its own.
 */
declare module "papaparse" {
  export interface ParseError {
    type: "Quotes" | "Delimiter" | "FieldMismatch";
    code: string;
    message: string;
    row?: number;
    index?: number;
  }
  export interface ParseResult<T> {
    data: T[];
    errors: ParseError[];
    meta: { delimiter: string; linebreak: string; aborted: boolean; truncated: boolean };
  }
  export interface ParseConfig {
    delimiter?: string;
    newline?: string;
    quoteChar?: string;
    escapeChar?: string;
    header?: boolean;
    skipEmptyLines?: boolean | "greedy";
  }
  export interface UnparseConfig {
    quotes?: boolean | boolean[];
    quoteChar?: string;
    escapeChar?: string;
    delimiter?: string;
    header?: boolean;
    newline?: string;
    escapeFormulae?: boolean;
  }
  export function parse<T = unknown>(input: string, config?: ParseConfig): ParseResult<T>;
  export function unparse(data: { fields: string[]; data: unknown[][] } | unknown[][], config?: UnparseConfig): string;
  const Papa: { parse: typeof parse; unparse: typeof unparse };
  export default Papa;
}
