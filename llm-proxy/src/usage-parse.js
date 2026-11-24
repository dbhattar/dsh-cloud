/** Token counts from an OpenAI-style `usage` object, or null. */
export function usageOf(obj) {
  const u = obj?.usage;
  if (!u || typeof u !== 'object') return null;
  const input = u.prompt_tokens ?? u.input_tokens;
  const output = u.completion_tokens ?? u.output_tokens;
  if (![input, output].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return { input: Math.round(input), output: Math.round(output) };
}

/** Incremental scanner for an SSE stream; keeps the last `usage` the provider reported. */
export class SseUsageScanner {
  constructor() {
    this.buf = '';
    this.usage = null;
    this.decoder = new TextDecoder();
  }
  feed(chunk) {
    this.buf += this.decoder.decode(chunk, { stream: true });
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      this.#line(this.buf.slice(0, i).replace(/\r$/, ''));
      this.buf = this.buf.slice(i + 1);
    }
    if (this.buf.length > 1 << 20) this.buf = ''; // a single line this long is not a usage chunk
  }
  end() {
    if (this.buf) this.#line(this.buf);
    this.buf = '';
  }
  #line(line) {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data.includes('"usage"')) return;
    try {
      const u = usageOf(JSON.parse(data));
      if (u) this.usage = u;
    } catch {
      // not JSON (e.g. [DONE]); ignore
    }
  }
}
