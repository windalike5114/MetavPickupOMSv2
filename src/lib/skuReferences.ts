import Papa from 'papaparse';

export function parseSkuReferenceSheet(csv: string) {
  const parsed = Papa.parse<string[]>(csv, { skipEmptyLines: 'greedy' });
  const [header = [], ...records] = parsed.data;
  const columns = header.map(value => value.toLowerCase().replace(/\s/g, ''));
  const code = columns.indexOf('code(unique)');
  const first = columns.indexOf('subname1');
  const second = columns.indexOf('subname2');

  if (code < 0 && first < 0 && second < 0) return null;
  if (code < 0 || (first < 0 && second < 0)) {
    throw new Error('Reference imports require Code(Unique) and Sub Name 1 or Sub Name 2.');
  }
  if (parsed.errors.length || records.some(row => row.length !== header.length)) {
    throw new Error('The reference CSV contains malformed rows.');
  }

  const byCode = new Map<string, { sku: string; ref1?: string; ref2?: string }>();
  let empty = 0;
  for (const [index, row] of records.entries()) {
    const sku = row[code]?.trim().toUpperCase();
    const ref1 = row[first]?.trim().toUpperCase() || undefined;
    const ref2 = row[second]?.trim().toUpperCase() || undefined;
    if (!ref1 && !ref2) {
      empty++;
      continue;
    }
    if (!sku || sku.length > 200 || (ref1?.length ?? 0) > 250 || (ref2?.length ?? 0) > 250) {
      throw new Error('Invalid code or reference at CSV row ' + (index + 2) + '.');
    }
    const previous = byCode.get(sku);
    if ((previous?.ref1 && ref1 && previous.ref1 !== ref1) || (previous?.ref2 && ref2 && previous.ref2 !== ref2)) {
      throw new Error('Conflicting reference values for Code(Unique) ' + sku + '.');
    }
    byCode.set(sku, { sku, ref1: ref1 ?? previous?.ref1, ref2: ref2 ?? previous?.ref2 });
  }
  return { rows: [...byCode.values()], empty };
}
