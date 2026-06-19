// Minimal ambient types for gifenc (the package ships no .d.ts).
// Only the surface used by background/browser/image.ts.
declare module 'gifenc' {
  export interface GifFrameOpts { palette?: number[][] | Uint8Array[]; delay?: number }
  export interface GifEncoderInstance {
    writeFrame(index: Uint8Array | number[], width: number, height: number, opts?: GifFrameOpts): void
    finish(): void
    bytes(): Uint8Array
  }
  export function GIFEncoder(): GifEncoderInstance
  export function quantize(rgba: Uint8ClampedArray | Uint8Array, maxColors: number): number[][]
  export function applyPalette(rgba: Uint8ClampedArray | Uint8Array, palette: number[][]): Uint8Array
}
