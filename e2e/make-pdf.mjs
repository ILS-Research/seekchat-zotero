// Writes the E2E fixture PDFs into the given directory. No dependencies.
//   seekchat-test.pdf  3 short pages (fits into the context)
//   seekchat-long.pdf  40 full pages (does not fit into the default budget), with
//                      chapter headings and one page about "Waermeinseln" that a
//                      question about "Stadtklima" only finds via model keywords
import fs from 'node:fs';
import path from 'node:path';

/** outline: optional [{ title, page (0-based), children: [{ title, page }] }] written as /Outlines (bookmarks). */
function writePdf(file, pages, outline = null) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c);
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const lines of pages) {
    const ops = ['BT', '/F1 11 Tf', '14 TL', '56 780 Td', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  let outlinesRef = '';
  if (outline?.length) {
    const root = add(null);
    const writeLevel = (entries, parent) => {
      const ids = entries.map(() => add(null));
      entries.forEach((e, i) => {
        const kids = e.children?.length ? writeLevel(e.children, ids[i]) : null;
        objects[ids[i] - 1] = `<< /Title (${esc(e.title)}) /Parent ${parent} 0 R` +
          (i > 0 ? ` /Prev ${ids[i - 1]} 0 R` : '') + (i < ids.length - 1 ? ` /Next ${ids[i + 1]} 0 R` : '') +
          (kids ? ` /First ${kids[0]} 0 R /Last ${kids[kids.length - 1]} 0 R /Count ${kids.length}` : '') +
          ` /Dest [${kidsRef(e.page)} /Fit] >>`;
      });
      return ids;
    };
    const kidsRef = (page) => `${kids[page]} 0 R`;
    const top = writeLevel(outline, root);
    objects[root - 1] = `<< /Type /Outlines /First ${top[0]} 0 R /Last ${top[top.length - 1]} 0 R /Count ${top.length} >>`;
    outlinesRef = ` /Outlines ${root} 0 R /PageMode /UseOutlines`;
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R${outlinesRef} >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, out, 'latin1');
}

const dir = process.argv[2];
fs.mkdirSync(dir, { recursive: true });

writePdf(path.join(dir, 'seekchat-test.pdf'), [
  ['SeekChat E2E Testdokument', 'Abstract: Dieses Dokument dient dem automatischen Test.', 'Es beschreibt Methoden der Stadtklimaforschung.'],
  ['Kapitel 2: Starkregen', 'Starkregenereignisse fuehren in Staedten zu Ueberflutungen.', 'Versiegelte Flaechen verstaerken den Oberflaechenabfluss.'],
  ['Kapitel 3: Fazit', 'Gruene Infrastruktur mindert Hitze und Abfluss.', 'Weitere Messungen sind notwendig.'],
]);

const filler = 'Die Untersuchung betrachtet Verwaltung Planung Beteiligung und Finanzierung im kommunalen Kontext.';
const body = (n) => Array.from({ length: n }, () => filler);
const long = Array.from({ length: 40 }, (_, i) => body(40));
long[0] = ['SeekChat E2E Langes Buch', 'Ein Testbuch mit vielen Seiten.', ...body(38)];
long[4] = ['Kapitel 1 Grundlagen', ...body(39)];
long[19] = ['Kapitel 2 Ergebnisse', ...body(39)];
long[26] = ['Waermeinseln in dicht bebauten Quartieren erhoehen die naechtlichen Temperaturen.', ...body(39)];
writePdf(path.join(dir, 'seekchat-long.pdf'), long, [
  { title: 'Einleitung', page: 0 },
  { title: 'Grundlagen', page: 4, children: [{ title: 'Begriffe', page: 4 }, { title: 'Stand der Forschung', page: 10 }] },
  { title: 'Ergebnisse', page: 19, children: [{ title: 'Waermeinseln', page: 26 }] },
  { title: 'Fazit', page: 35 },
]);
