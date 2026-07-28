// Minimal WAV read/write for the SFX pipeline (genSfx.ts).
//
// Hand-rolled on purpose: the generators workspace has no audio dependencies and
// uncompressed PCM needs none. Reading covers what the extracted Future Cop
// sounds actually are (RIFF PCM s16le 22050 Hz mono) plus the neighbouring depths
// a re-export might produce; writing is always mono 16-bit PCM.

export interface Pcm {
  readonly rate: number;
  /** Mono samples in [-1, 1]. */
  readonly samples: Float32Array;
}

function readChunks(view: DataView): Map<string, { offset: number; length: number }> {
  const tag = (at: number) =>
    String.fromCharCode(
      view.getUint8(at),
      view.getUint8(at + 1),
      view.getUint8(at + 2),
      view.getUint8(at + 3),
    );
  if (view.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  const chunks = new Map<string, { offset: number; length: number }>();
  let o = 12;
  while (o + 8 <= view.byteLength) {
    const length = view.getUint32(o + 4, true);
    chunks.set(tag(o), { offset: o + 8, length });
    o += 8 + length + (length % 2); // chunk bodies are word-aligned
  }
  return chunks;
}

/**
 * Decodes a PCM or IEEE-float WAV to mono float. Multi-channel input is averaged
 * — the cues are one-shots played through a StereoPanner, so a stereo source
 * would only fight the pan.
 */
export function decodeWav(bytes: Uint8Array): Pcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = readChunks(view);
  const fmt = chunks.get("fmt ");
  const data = chunks.get("data");
  if (!fmt || !data) throw new Error("WAV missing fmt or data chunk");

  const format = view.getUint16(fmt.offset, true);
  const channels = view.getUint16(fmt.offset + 2, true);
  const rate = view.getUint32(fmt.offset + 4, true);
  const bits = view.getUint16(fmt.offset + 14, true);
  // 0xFFFE is WAVE_FORMAT_EXTENSIBLE; its real format lives in the subformat
  // GUID, whose first two bytes repeat the tag above.
  const tag = format === 0xfffe ? view.getUint16(fmt.offset + 24, true) : format;
  const float = tag === 3;
  if (tag !== 1 && !float) throw new Error(`unsupported WAV format ${tag}`);
  if (channels < 1) throw new Error("WAV with no channels");

  const bytesPerSample = bits / 8;
  const frames = Math.floor(data.length / (bytesPerSample * channels));
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = data.offset + (f * channels + c) * bytesPerSample;
      if (float) sum += bits === 64 ? view.getFloat64(at, true) : view.getFloat32(at, true);
      else if (bits === 8)
        sum += (view.getUint8(at) - 128) / 128; // 8-bit WAV is unsigned
      else if (bits === 16) sum += view.getInt16(at, true) / 32768;
      else if (bits === 24) {
        // little-endian 24-bit: two unsigned bytes then the signed top byte
        sum += ((view.getInt8(at + 2) << 16) | view.getUint16(at, true)) / 8388608;
      } else if (bits === 32) sum += view.getInt32(at, true) / 2147483648;
      else throw new Error(`unsupported WAV bit depth ${bits}`);
    }
    out[f] = sum / channels;
  }
  return { rate, samples: out };
}

/** Encodes mono 16-bit PCM. */
export function encodeWav(pcm: Pcm): Uint8Array {
  const n = pcm.samples.length;
  const bytes = new Uint8Array(44 + n * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, pcm.rate, true);
  view.setUint32(28, pcm.rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = pcm.samples[i] < -1 ? -1 : pcm.samples[i] > 1 ? 1 : pcm.samples[i];
    view.setInt16(44 + i * 2, Math.round(v < 0 ? v * 32768 : v * 32767), true);
  }
  return bytes;
}
