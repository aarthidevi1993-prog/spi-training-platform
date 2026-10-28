// Deterministic OCR for tests: a scripted engine (no network, no canvas, no tesseract).
// Each scanned page's "recognised" text is given as lines; a line is a string (all words at
// `confidence`, default 95) or { text, confidence } or { words: [[text, confidence], ...] }.
// Words are laid out left to right on a 2480×3508 image (A4 at 300 dpi), one line per 60 px.
export function scriptedOcr(pagesByNumber, { confidence = 95, onRecognize, render, engine } = {}) {
  const calls = { started: 0, recognized: [], released: [], terminated: 0 };
  const layout = (lines) => {
    const out = [];
    lines.forEach((line, i) => {
      const words = typeof line === "string"
        ? line.split(/\s+/).filter(Boolean).map((w) => [w, confidence])
        : line.words ?? line.text.split(/\s+/).filter(Boolean).map((w) => [w, line.confidence ?? confidence]);
      const baseline = 200 + i * 60;
      let x = typeof line === "object" && line.x !== undefined ? line.x : 150;
      out.push({
        baseline,
        words: words.map(([text, conf]) => {
          const w = { text, confidence: conf, x0: x, y0: baseline - 40, x1: x + text.length * 22, y1: baseline + 8 };
          x = w.x1 + 18;
          return w;
        }),
      });
    });
    return out;
  };
  const options = {
    async engine() {
      calls.started++;
      if (engine) return engine(calls);
      return {
        async recognize(image) {
          calls.recognized.push(image.image);
          if (onRecognize) {
            const r = await onRecognize(image.image, calls);
            if (r) return r;
          }
          const lines = pagesByNumber[image.image];
          return { width: 2480, height: 3508, lines: layout(lines ?? []) };
        },
        async terminate() {
          calls.terminated++;
        },
      };
    },
    async render(page) {
      if (render) return render(page, calls);
      const n = page.pageNumber;
      return { width: 2480, height: 3508, image: n, release: () => calls.released.push(n) };
    },
  };
  return { options, calls };
}
