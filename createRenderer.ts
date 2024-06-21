// @deno-types="@types/react"
import { createElement } from "react";
// @deno-types="@types/react-dom/server"
import { renderToReadableStream as renderHTMLToReadableStream } from "react-dom/server.edge";
import {
  decodeReply,
  renderToReadableStream,
} from "react-server-dom-esm/server.edge";
import { createFromReadableStream } from "react-server-dom-esm/client.browser";
import { injectRSCPayload } from "rsc-html-stream/server";
import { fromFileUrl } from "@std/path/from-file-url";
import { toFileUrl } from "@std/path/to-file-url";
import { join } from "@std/path/join";

export const createRenderer = (
  clientRsc: {
    hasClientBuildFinished: () => Promise<any>;
    getBootstrapModules: () => Promise<string[]>;
    pathTransformStream: (
      stream: ReadableStream,
    ) => Promise<ReadableStream<Uint8Array>>;
  },
  moduleBaseURL: string,
) =>
(importFn: () => any) => {
  const moduleBasePath = fromFileUrl(moduleBaseURL);
  return async (ctx: any) => {
    const req = ctx.request;
    await clientRsc.hasClientBuildFinished();
    let redirectUrl: string | undefined;
    const rscActionResult = req.method === "POST" &&
        req.headers.get("Accept") === "text/x-component"
      ? {
        _value: await (async () => {
          const contentType = req.headers.get("Content-Type");
          const data = contentType?.startsWith("multipart/form-data")
            ? await req.formData()
            : await req.text();
          const actionArgs = data
            ? await decodeReply(data, moduleBasePath)
            : [];
          const [relativePath, exportName] = decodeURIComponent(
            new URL(req.url).searchParams.get("rsc_action_id")!,
          ).split("#");
          const href = toFileUrl(join(Deno.cwd(), relativePath)).href;
          const { [exportName]: fn } = href ? await import(href) : {};
          ctx.state.redirect = (v: string) => (redirectUrl = v);
          return await ctx.state.routeStorage?.run(ctx, fn, ...actionArgs) ??
            fn?.(...actionArgs);
        })(),
      }
      : null;

    if (redirectUrl) {
      return URL.canParse(redirectUrl)
        ? new Response(null, {
          headers: { "x-rsc-redirect": redirectUrl! },
        })
        : new Response(null, {
          status: 302,
          headers: { Location: redirectUrl },
        });
    }

    const node = rscActionResult ?? (await (await importFn()).default(ctx));
    const rscStreamPromise = Promise.resolve(
      renderToReadableStream(node, moduleBasePath),
    );

    if (req.headers.get("Accept") === "text/x-component") {
      return rscStreamPromise.then(clientRsc.pathTransformStream).then(
        (rscStream) =>
          new Response(rscStream, {
            headers: {
              "Content-Type": "text/x-component",
              "Cache-Control": "no-cache",
            },
          }),
      );
    }

    const htmlStreamPromise = rscStreamPromise.then(async (rscStream) => {
      const [s1, s2] = rscStream.tee();
      const data = createFromReadableStream(s1, { moduleBaseURL });
      const htmlStream = await renderHTMLToReadableStream(
        (createElement as any)(() => data),
        { bootstrapModules: await clientRsc.getBootstrapModules() },
      );
      return htmlStream.pipeThrough(
        injectRSCPayload(await clientRsc.pathTransformStream(s2)),
      );
    });

    return new Response(await htmlStreamPromise, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  };
};
