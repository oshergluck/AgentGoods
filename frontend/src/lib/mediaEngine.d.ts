/**
 * Types for the procedural artwork engine.
 *
 * The engine itself is plain JavaScript so the offline generator and the UI can share one file
 * without a build step in between.
 */
export declare function hashSeed(seed: string): number;
export declare function rng(seed: string): () => number;
export declare function palette(seed: string): {
  a: string;
  b: string;
  c: string;
  glow: string;
  harmony: number;
};
export declare function coverSvg(seed: string, caption?: string): string;
export declare function logoSvg(seed: string, initials?: string): string;
export declare function toDataUri(svg: string): string;
export declare function escapeXml(value: unknown): string;
