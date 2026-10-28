// Inputs for fingerprint-vectors.json. The expected values in that file are
// produced by the REAL 0013 SQL functions (question_import_normalize,
// question_import_fingerprint, question_import_text_fingerprint) on
// PostgreSQL — see tests/question-import/README.md.
export const COURSE_A = "3f2b1c9e-8d4a-4b6f-9e21-5c7d8a9b0e1f";
export const COURSE_B = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";

export const VECTOR_INPUTS = [
  { name: "plain", courseId: COURSE_A, type: "single_choice", text: "What does FT stand for?", options: ["Flow transmitter", "Flow totaliser", "Flow switch"] },
  { name: "case + spacing + option order", courseId: COURSE_A, type: "single_choice", text: "  what DOES ft   stand for? ", options: ["flow switch", "FLOW TRANSMITTER", "Flow  totaliser"] },
  { name: "tabs, newlines, CR, control chars", courseId: COURSE_A, type: "multiple_choice", text: "Line one\r\n\tLine two\u0007end", options: ["A\tB", "C\nD"] },
  { name: "NBSP and other spaces (NFKC)", courseId: COURSE_A, type: "single_choice", text: "Flow rate meter check", options: ["x y", "z"] },
  { name: "full-width letters and digits (NFKC)", courseId: COURSE_A, type: "single_choice", text: "ＦＬＯＷ　ｒａｔｅ １２３", options: ["ＡＢＣ", "abc"] },
  { name: "ligature, superscript, roman numeral (NFKC)", courseId: COURSE_A, type: "true_false", text: "The ﬁeld value is m² and Ⅻ units", options: ["True", "False"] },
  { name: "combining accent vs precomposed", courseId: COURSE_A, type: "single_choice", text: "Café or Café?", options: ["é", "é"] },
  { name: "non-ASCII capitals keep case", courseId: COURSE_A, type: "single_choice", text: "ÄRGER ÉTÉ ΣΙΓΜΑ İSTANBUL", options: ["Ä", "ä"] },
  { name: "astral vs BMP private-use sort (code point order)", courseId: COURSE_A, type: "multiple_choice", text: "Symbols", options: ["😀 smile", " private", "zeta", "Ω omega"] },
  { name: "different course, same content", courseId: COURSE_B, type: "single_choice", text: "What does FT stand for?", options: ["Flow transmitter", "Flow totaliser", "Flow switch"] },
  { name: "different type, same content", courseId: COURSE_A, type: "multiple_choice", text: "What does FT stand for?", options: ["Flow transmitter", "Flow totaliser", "Flow switch"] },
  { name: "empty-ish text and blank-space option", courseId: COURSE_A, type: "single_choice", text: "   ", options: ["  a  ", "b"] },
  { name: "ten options A–J", courseId: COURSE_A, type: "multiple_choice", text: "Pick all valid", options: ["j", "i", "h", "g", "f", "e", "d", "c", "b", "a"] },
  { name: "uppercase course id input", courseId: COURSE_A.toUpperCase(), type: "single_choice", text: "What does FT stand for?", options: ["Flow transmitter", "Flow totaliser", "Flow switch"] },
  { name: "DEL char and zero-width space (not collapsed)", courseId: COURSE_A, type: "single_choice", text: "a\u007Fb​c", options: ["x", "y"] },
  { name: "long text", courseId: COURSE_A, type: "single_choice", text: "Long ".repeat(900), options: ["one", "two"] },
];
