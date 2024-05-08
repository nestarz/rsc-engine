import { renderToPipeableStream } from "react-server-dom-esm/server.node";
import { PassThrough, Readable } from "node:stream";

export function renderToReadableStream(
  model: Parameters<typeof renderToPipeableStream>[0],
  moduleBasePath: Parameters<typeof renderToPipeableStream>[1],
  options?: Parameters<typeof renderToPipeableStream>[2],
): ReadableStream {
  const stream = renderToPipeableStream(model, moduleBasePath, options);
  const jsxStream = stream.pipe(new PassThrough());
  return Readable.toWeb(jsxStream) as ReadableStream;
}

export * from "react-server-dom-esm/server.node";
