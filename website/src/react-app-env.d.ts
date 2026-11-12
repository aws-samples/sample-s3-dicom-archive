/// <reference types="vite/client" />

declare class DecompressionStream {
  constructor(format: string);
  readonly readable: ReadableStream;
  readonly writable: WritableStream;
}

declare class CompressionStream {
  constructor(format: string);
  readonly readable: ReadableStream;
  readonly writable: WritableStream;
}
