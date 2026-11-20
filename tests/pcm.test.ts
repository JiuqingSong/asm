import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

interface Processor {
  port: { onmessage: (event: { data: unknown }) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
function worklet(rate = 48000): { processor: Processor; messages: unknown[] } {
  let ctor: (new () => Processor) | undefined;
  const messages: unknown[] = [];
  class Base {
    port = { onmessage: null, postMessage: (data: unknown) => messages.push(data) };
  }
  runInNewContext(readFileSync(new URL('../src/ui/pcm-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: Base, Float32Array, ArrayBuffer, sampleRate: rate,
    registerProcessor: (_name: string, value: new () => Processor) => { ctor = value; },
  });
  if (!ctor) throw new Error('PCM worklet was not registered');
  return { processor: new ctor(), messages };
}
function submit(processor: Processor, values: number[]): void {
  processor.port.onmessage({ data: { type: 'samples', buffer: new Float32Array(values).buffer } });
}
function render(processor: Processor, frames: number): Float32Array[] {
  const output = [new Float32Array(frames), new Float32Array(frames)];
  processor.process([], [output]);
  return output;
}
describe('PCM audio worklet', () => {
  it('plays interleaved stereo without changing channels, then emits silence', () => {
    const { processor } = worklet();
    submit(processor, [0.5, -0.5, 0.25, -0.25]);
    const [left, right] = render(processor, 4);
    expect([...left]).toEqual([0.5, 0.25, 0, 0]);
    expect([...right]).toEqual([-0.5, -0.25, 0, 0]);
  });
  it('resamples to the host audio rate and clears stale samples on pause', () => {
    const { processor } = worklet(96000);
    submit(processor, [0, 0, 1, -1, 0, 0]);
    const [left, right] = render(processor, 4);
    expect([...left]).toEqual([0, 0.5, 1, 0.5]);
    expect([...right]).toEqual([0, -0.5, -1, -0.5]);
    processor.port.onmessage({ data: { type: 'clear' } });
    expect([...render(processor, 2)[0]]).toEqual([0, 0]);
  });
  it('bounds buffered audio and explicitly reports overflow instead of growing indefinitely', () => {
    const { processor, messages } = worklet();
    submit(processor, Array(40000).fill(0.25));
    expect(messages).toContainEqual({ type: 'overflow' });
    expect([...render(processor, 2)[0]]).toEqual([0.25, 0.25]);
  });
});
