export const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024

export interface CapturedStdout {
  text: string
  bytes: number
  truncated: boolean
}

/** Append as much of chunk as fits without splitting a UTF-8 code point. */
export function appendCappedUtf8(
  captured: CapturedStdout,
  chunk: string,
  maxBytes: number,
): CapturedStdout {
  if (chunk === '') return captured
  if (captured.truncated) return captured

  const remaining = Math.max(0, maxBytes - captured.bytes)
  const chunkBytes = Buffer.byteLength(chunk)
  if (chunkBytes <= remaining) {
    return {
      text: captured.text + chunk,
      bytes: captured.bytes + chunkBytes,
      truncated: false,
    }
  }

  const prefix = utf8Prefix(chunk, remaining)
  return {
    text: captured.text + prefix,
    bytes: captured.bytes + Buffer.byteLength(prefix),
    truncated: true,
  }
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let bytes = 0
  let prefix = ''
  for (const char of text) {
    const charBytes = Buffer.byteLength(char)
    if (bytes + charBytes > maxBytes) break
    prefix += char
    bytes += charBytes
  }
  return prefix
}
