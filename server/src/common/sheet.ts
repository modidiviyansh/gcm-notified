import { BadRequestException } from '@nestjs/common';
import { inflateRawSync } from 'zlib';
import { parse } from 'csv-parse/sync';

/**
 * Reads an uploaded sheet — CSV or Excel (.xlsx) — into rows keyed by the header row.
 * The .xlsx reader is dependency-free: an .xlsx is a zip of XML files; we read the first worksheet,
 * shared strings and the date formats from styles.xml. Formulas give their last calculated value.
 */
export function readSheet(buf: Buffer, filename = ''): Record<string, string>[] {
  return dropBlankColumns(readAny(buf, filename));
}

/** Columns with no heading and nothing in them (Excel leaves these behind) are dropped. */
function dropBlankColumns(rows: Record<string, string>[]) {
  if (!rows.length) return rows;
  const blank = Object.keys(rows[0]).filter((k) => /^Column [A-Z]+$/.test(k) && rows.every((r) => !String(r[k] ?? '').trim()));
  if (!blank.length) return rows;
  return rows.map((r) => { const o = { ...r }; for (const k of blank) delete o[k]; return o; });
}

function readAny(buf: Buffer, filename: string): Record<string, string>[] {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return readXlsx(buf);
  if (buf.length >= 8 && buf.readUInt32LE(0) === 0xe011cfd0) {
    throw new BadRequestException('This is an old Excel file (.xls). In Excel choose File → Save As → Excel Workbook (.xlsx) or CSV, then upload again.');
  }
  if (/\.(numbers|ods)$/i.test(filename)) throw new BadRequestException('Export the sheet as Excel (.xlsx) or CSV first, then upload it.');
  return readCsv(buf);
}

export function readCsv(buf: Buffer): Record<string, string>[] {
  let text = buf.toString('utf8').replace(/^﻿/, '');
  // Excel in some locales saves "CSV" with semicolons
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : first.includes('\t') && !first.includes(',') ? '\t' : ',';
  const rows: Record<string, string>[] = parse(text, {
    columns: (h: string[]) => uniqueHeaders(h), skip_empty_lines: true, trim: true, relax_column_count: true, bom: true, delimiter,
  });
  return rows.filter((r) => Object.values(r).some((v) => String(v ?? '').trim()));
}

function uniqueHeaders(h: string[]): string[] {
  const seen = new Map<string, number>();
  return h.map((x, i) => {
    let name = String(x ?? '').trim() || `Column ${colName(i)}`;
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    if (n > 1) name = `${name} ${n}`;
    return name;
  });
}

// ---------------------------------------------------------------- zip
function unzip(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new BadRequestException('This Excel file looks damaged — open it in Excel and save it again.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, () => Buffer>();
  for (let i = 0; i < count && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), full = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extra + comment;
    files.set(name, () => {
      if (full > 60 * 1024 * 1024) throw new BadRequestException('This sheet is too large');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: 60 * 1024 * 1024 });
      throw new BadRequestException('Unsupported Excel compression — save the file again as .xlsx or CSV');
    });
  }
  return files;
}

// ---------------------------------------------------------------- xlsx
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m);
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map((m) => decode(m[1] ?? '')).join('');
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
function colName(i: number) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

function readXlsx(buf: Buffer): Record<string, string>[] {
  const files = unzip(buf);
  const get = (name: string) => files.get(name)?.().toString('utf8');
  const workbook = get('xl/workbook.xml');
  if (!workbook) throw new BadRequestException('This does not look like an Excel workbook');
  const firstSheet = /<sheet\b[^>]*>/.exec(workbook)?.[0] ?? '';
  const rid = attr(firstSheet, 'r:id');
  const rels = get('xl/_rels/workbook.xml.rels') ?? '';
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => attr(r, 'Id') === rid);
  let target = rel ? attr(rel, 'Target') ?? 'worksheets/sheet1.xml' : 'worksheets/sheet1.xml';
  target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const sheet = get(target) ?? get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new BadRequestException('The first sheet of this workbook is empty');

  const shared = [...(get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  const dateStyles = readDateStyles(get('xl/styles.xml') ?? '');

  const grid: string[][] = [];
  for (const row of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    let next = 0;
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = c[1], inner = c[2] ?? '';
      const ref = attr(head, 'r');
      const i = ref ? colIndex(ref) : next;
      next = i + 1;
      const t = attr(head, 't'), s = Number(attr(head, 's') ?? -1);
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let out = '';
      if (t === 's') out = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') out = texts(inner);
      else if (t === 'str' || t === 'e') out = decode(v ?? '');
      else if (t === 'b') out = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined && v !== '') out = dateStyles.has(s) ? serialToDate(Number(v)) : fmtNumber(Number(v));
      cells[i] = out.trim();
    }
    grid.push(Array.from(cells, (x) => x ?? ''));
  }
  const start = grid.findIndex((r) => r.some(Boolean));
  if (start < 0) return [];
  const headers = uniqueHeaders(grid[start]);
  return grid.slice(start + 1)
    .filter((r) => r.some(Boolean))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

/** Indexes into cellXfs whose number format is a date (built-in 14–22 / 45–47, or a custom d/m/y format). */
function readDateStyles(styles: string): Set<number> {
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), decode(attr(m[0], 'formatCode') ?? ''));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const out = new Set<number>();
  [...xfs.matchAll(/<xf\b[^>]*>/g)].forEach((m, i) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    const code = custom.get(id)?.replace(/"[^"]*"|\[[^\]]*\]/g, '') ?? '';
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[dy]|m{3,}/i.test(code) || (/m/i.test(code) && /[d]/i.test(code))) out.add(i);
  });
  return out;
}

/** Excel day number → DD-MM-YYYY (1900 date system), time dropped. */
function serialToDate(n: number): string {
  if (!Number.isFinite(n)) return '';
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86_400_000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12)));
}
