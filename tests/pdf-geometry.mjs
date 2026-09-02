// Automated geometry check for every rendered document: nothing may sit outside
// the page margins, and no two text runs on a line may overlap. Eyeballing a
// dozen PDFs catches the obvious; this catches the regression six months later.
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DIR = process.argv[2] ?? '/tmp/pdfmatrix';
const MARGIN = 34, PAGE_W = 595.28, PAGE_H = 841.89;
const TOL = 1.5;

let failures = 0, checked = 0;
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.pdf')).sort()) {
  const xml = execFileSync('pdftotext', ['-bbox-layout', `${DIR}/${file}`, '-'], { encoding: 'utf8' });
  const problems = [];
  // Split by page first. The same header appears at the same coordinates on
  // every page of a multi-page invoice, so comparing across pages reports every
  // repeated heading as an overlap with itself.
  const pages = xml.split(/<page\b/).slice(1);
  const words = [];
  pages.forEach((pageXml, pageNo) => {
    for (const m of pageXml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)) {
      words.push({ page: pageNo, x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], t: m[5] });
    }
  });
  checked += words.length;

  for (const w of words) {
    if (w.x0 < MARGIN - TOL) problems.push(`"${w.t}" runs past the left margin (x=${w.x0.toFixed(1)})`);
    if (w.x1 > PAGE_W - MARGIN + TOL) problems.push(`"${w.t}" runs past the right margin (x=${w.x1.toFixed(1)})`);
    if (w.y0 < 0 || w.y1 > PAGE_H) problems.push(`"${w.t}" is off the page vertically`);
  }
  // Overlap: words sharing a horizontal band whose boxes intersect.
  const byLine = new Map();
  for (const w of words) {
    const key = `${w.page}:${Math.round(w.y0 / 3)}`;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(w);
  }
  for (const row of byLine.values()) {
    row.sort((a, b) => a.x0 - b.x0);
    for (let i = 1; i < row.length; i += 1) {
      if (row[i].x0 < row[i - 1].x1 - TOL) {
        problems.push(`"${row[i - 1].t}" and "${row[i].t}" overlap`);
      }
    }
  }
  const unique = [...new Set(problems)];
  if (unique.length) {
    failures += 1;
    console.log(`  FAIL ${file}`);
    unique.slice(0, 5).forEach((p) => console.log(`        ${p}`));
    if (unique.length > 5) console.log(`        …and ${unique.length - 5} more`);
  } else {
    console.log(`  ok   ${file}`);
  }
}
console.log(failures
  ? `\n${failures} document(s) have layout problems.`
  : `\nAll documents clean — ${checked} text runs inside the margins, none overlapping.`);
process.exit(failures ? 1 : 0);
