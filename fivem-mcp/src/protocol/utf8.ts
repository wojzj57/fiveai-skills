/**
 * UTF-8 byte length without runtime-specific globals (Buffer/TextEncoder),
 * so the same contract source can be bundled for both desktop Node.js and
 * the FiveM script runtimes later.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) as number;
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
      index += 1;
    }
  }
  return bytes;
}
