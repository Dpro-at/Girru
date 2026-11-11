/** Bounded HTML-to-text extraction. Returned text is untrusted data, never safe HTML. */
import DOMPurify from 'isomorphic-dompurify';

export const HTML_TEXT_INPUT_BYTES = 256 * 1024;
export const HTML_TEXT_OUTPUT_BYTES = 64 * 1024;

export function htmlToText(input: unknown): string {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > HTML_TEXT_INPUT_BYTES || Buffer.from(input, 'utf8').toString('utf8') !== input) {
    throw new TypeError('extension_html_text_input_invalid');
  }
  const fragment = DOMPurify.sanitize(input, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
    FORBID_CONTENTS: ['script', 'style', 'template', 'iframe', 'object', 'noscript'],
    RETURN_DOM_FRAGMENT: true,
  });
  const text = fragment.textContent ?? '';
  if (Buffer.byteLength(text, 'utf8') > HTML_TEXT_OUTPUT_BYTES) throw new RangeError('extension_html_text_output_too_large');
  return text;
}
