const BEGIN = '<!-- baton:begin -->';
const END = '<!-- baton:end -->';

/** @param {string} haystack @param {string} needle */
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

/**
 * Write a managed block into a document. Bytes outside the markers are never
 * touched: with both markers present the content between them is replaced;
 * with neither, a fresh block is appended. Corrupt marker states (unpaired,
 * out of order, duplicated) are refused — a half-marked file is never guessed
 * at. Pure text transform.
 * @param {string | null} existingText document body, or null when the file does not exist
 * @param {string} body the managed content to place between the markers
 * @returns {{text: string, changed: boolean} | {error: string}}
 */
export function applyManagedBlock(existingText, body) {
  const doc = existingText ?? '';
  const begins = countOf(doc, BEGIN);
  const ends = countOf(doc, END);

  if (begins > 1 || ends > 1) return { error: 'more than one managed block marker pair — ambiguous; fix the file by hand' };
  if (begins !== ends) return { error: 'unpaired managed block marker — refusing to rewrite a half-marked file' };

  if (begins === 1) {
    const idxBegin = doc.indexOf(BEGIN);
    const idxEnd = doc.indexOf(END);
    if (idxEnd < idxBegin) return { error: 'managed block markers are out of order — refusing to rewrite' };
    const text = doc.slice(0, idxBegin + BEGIN.length) + '\n' + body + '\n' + doc.slice(idxEnd);
    return { text, changed: text !== doc };
  }

  const block = BEGIN + '\n' + body + '\n' + END + '\n';
  if (doc === '') return { text: block, changed: true };
  const prefix = doc.endsWith('\n') ? doc : doc + '\n';
  return { text: prefix + block, changed: true };
}
