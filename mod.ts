import type * as Esbuild from "esbuild-types";

import { format } from "@std/path/format";
import { parse } from "@std/path/parse";
import { relative } from "@std/path/relative";
import { toFileUrl } from "@std/path/to-file-url";
import { join } from "@std/path/join";
import { basename } from "@std/path/basename";
import { dirname } from "@std/path/dirname";
import { fromFileUrl } from "@std/path/from-file-url";
import { resolveImportMap } from "@bureaudouble-forks/importmap";
import { denoPlugins } from "@luca/esbuild-deno-loader";
import { RateLimiter } from "@teemukurki/rate-limiter";
import { getHashSync } from "@bureaudouble/scripted";
import { calculate } from "@std/http/etag";

import { info, type ModuleEntryEsm } from "@bureaudouble/deno-info";
import { createRenderer } from "./createRenderer.ts";

const absolute = (...a: string[]) => join(Deno.cwd(), ...a);

const sortKeys = <T extends Record<string, any>>(obj: T): T => {
  const sortedObj = {} as { [K in keyof T]: T[K] };
  Object.keys(obj)
    .sort((a, b) => a.localeCompare(b))
    .forEach((key) => {
      sortedObj[key as keyof T] = obj[key];
    });
  return sortedObj;
};

const writeTextFileIfDifferent = (filePath: string, content: string) =>
  Deno.readTextFile(filePath)
    .then((existingContent) => existingContent === content || Promise.reject())
    .catch(async () => {
      await Deno.mkdir(dirname(filePath), { recursive: true }).catch(
        () => null,
      );
      await Deno.writeTextFile(filePath, content);
      console.log("[rsc-engine] wrote", filePath);
    });

const updateJsonFileIfDifferent = async <T>(
  filePath: string,
  updateFn: (arg: any) => T,
) => {
  const fn = URL.canParse(filePath) ? fromFileUrl(filePath) : filePath;
  const originalContent = await Deno.readTextFile(fn).catch(() => null);
  const jsonData = originalContent ? JSON.parse(originalContent) : null;
  const updatedJsonData = updateFn(jsonData);
  const updatedContent = JSON.stringify(updatedJsonData, null, 2);
  await writeTextFileIfDifferent(fn, updatedContent);
  return updatedJsonData as T;
};

const createRemoveReferences =
  (basePath: string) => (value: { [k: string]: { [k: string]: string } }) =>
    Object.fromEntries(
      Object.entries(value ?? {}).map(([k, v]) => [
        k,
        Object.fromEntries(
          Object.entries(v)
            .filter(([_, v]) => !v.includes(basePath))
            .map(([k, v]) => [k, v]),
        ),
      ]),
    );

const generateClientReferenceServerCode = (
  relativeBundleDirectory: string,
  bundleURL: string,
  specifierURL: string,
  originalSpecifierURL: string,
  ids: string[],
) => `
import { registerClientReference } from "react-server-dom-esm/server.edge";
import { join } from "@std/path/join";
import type * as _RSC_exports from ${
  JSON.stringify(
    toImportUrl(getRelativePathOrUrl(bundleURL, relativeBundleDirectory)),
  )
};
(() => import(${
  JSON.stringify(
    toImportUrl(getRelativePathOrUrl(specifierURL, relativeBundleDirectory)),
  )
}));
import(${
  JSON.stringify(
    toImportUrl(
      getRelativePathOrUrl(originalSpecifierURL, relativeBundleDirectory),
    ),
  )
}).catch(() => null);
const rcr = <T extends keyof typeof _RSC_exports>(id: T) => {
  const url = ${JSON.stringify(specifierURL)};
  return registerClientReference({}, URL.canParse(url) ? url : join(Deno.cwd(), url), id);
};
const rcrHMR = (name: keyof typeof _RSC_exports) =>
  new Proxy({}, { get(_target, prop) { return rcr(name)[prop] } });
${
  ids
    .map((exportName) =>
      exportName === "default"
        ? `const _RSC_default = rcrHMR("default");\nexport default _RSC_default;`
        : `export const ${exportName} = rcrHMR(${JSON.stringify(exportName)});`
    )
    .join("\n")
}
`;

const generateServerReferenceServerCode = (
  relativeReferenceDirectory: string,
  specifierURL: string,
  ids: string[],
) =>
  [
    `import { registerServerReference } from "react-server-dom-esm/server.edge";`,
    `import * as _RSC_exports from ${
      JSON.stringify(
        toImportUrl(
          getRelativePathOrUrl(specifierURL, relativeReferenceDirectory),
        ),
      )
    };`,
    `const rsr = <T extends keyof typeof _RSC_exports>(id: T): typeof _RSC_exports[T] => {
      const url = ${JSON.stringify(specifierURL)};
      return registerServerReference(_RSC_exports[id], url, id);
    };`,
    ...ids.flatMap((exportName) => {
      const exportKey = exportName === "default"
        ? `const _RSC_default =`
        : `export const ${exportName} =`;
      return [
        `${exportKey} rsr(${JSON.stringify(exportName)});`,
        ...(exportName === "default" ? [`export default _RSC_default;`] : []),
      ];
    }),
  ].join("\n");

const generateServerReferenceClientCode = (
  specifierURL: string,
  ids: string[],
) =>
  [
    `import { createServerReference as csr } from "react-server-dom-esm/client.browser";`,
    `import type * as _RSC_types from ${JSON.stringify(specifierURL)};`,
    `const _RSC_url = ${JSON.stringify(specifierURL)};`,
    ...ids.flatMap((exportName) => {
      const exportKey = exportName === "default"
        ? `const _RSC_default: typeof _RSC_types["default"] =`
        : `export const ${exportName}: typeof _RSC_types[${
          JSON.stringify(
            exportName,
          )
        }] =`;
      return [
        `${exportKey} csr([_RSC_url, ${
          JSON.stringify(
            exportName,
          )
        }].join("#"), globalThis.callServer);`,
        ...(exportName === "default" ? [`export default _RSC_default;`] : []),
      ];
    }),
  ].join("\n");

const limiter = new RateLimiter({ tokensPerInterval: 60, interval: "second" });
const getUseDirective = async (specifier: string) => {
  if (new URL(specifier).protocol !== "file:") {
    await limiter.removeTokens(1);
  }
  const response = await fetch(specifier).catch(console.error);
  if (!response?.body) return "error";
  const reader = response.body.getReader({ mode: "byob" });
  const { value } = await reader.read(new Uint8Array(11));
  const decoder = new TextDecoder("utf-8");
  const directive = decoder.decode(value).trim().slice(1, 11);
  const map = {
    "use client": "client",
    "use server": "server",
  } as const;
  const mode = directive in map
    ? map[directive as keyof typeof map]
    : ("default" as const);
  return mode;
};

class PathTransformStream {
  private transformStream: TransformStream<Uint8Array, Uint8Array>;
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private pendingChunk: string = "";

  constructor(private basePath: string) {
    this.transformStream = new TransformStream({
      transform: (chunk, controller) => {
        const text = this.decoder.decode(chunk, { stream: true });
        const lines = (this.pendingChunk + text).split("\n");
        this.pendingChunk = lines.pop() || "";
        for (const line of lines) {
          controller.enqueue(
            this.encoder.encode(this.transformLine(line) + "\n"),
          );
        }
      },
      flush: (controller) => {
        if (this.pendingChunk) {
          controller.enqueue(
            this.encoder.encode(this.transformLine(this.pendingChunk) + "\n"),
          );
        }
      },
    });
  }
  private transformLine(line: string): string {
    const index = line.indexOf(':I["');
    if (index !== -1) {
      const start = index + 4;
      const end = line.indexOf('"', start);
      if (end !== -1) {
        const originalPath = line.slice(start, end);
        if (originalPath) {
          return `${line.slice(0, start)}${
            join(
              "/",
              this.basePath,
              originalPath,
            )
          }${line.slice(end)}`;
        }
      }
    }
    return line;
  }

  getReadableStream(
    inputStream: ReadableStream<Uint8Array>,
  ): ReadableStream<Uint8Array> {
    return inputStream.pipeThrough(this.transformStream);
  }
}
const toImportUrl = (str: string, k = ".") =>
  URL.canParse(str) ? str : `${k}/${join(".", str)}`;
const getRelativePathOrUrl = (specifier: string, relativeDir = Deno.cwd()) => {
  const corrected = specifier.startsWith("//")
    ? "https:".concat(specifier)
    : specifier;
  return URL.canParse(corrected)
    ? new URL(corrected).protocol === "file:"
      ? relative(relativeDir, fromFileUrl(corrected))
      : corrected
    : relative(relativeDir, specifier);
};

const locateModuleInBuild = (
  build: Esbuild.BuildResult,
  specifier: string,
  moduleInfos: {
    redirects: {
      [k: string]: string;
    };
  },
) =>
  Object.entries(build.metafile?.outputs ?? {}).find(
    ([, v]) =>
      v.entryPoint === getRelativePathOrUrl(specifier) ||
      v.entryPoint === resolveJsrSpecifier(moduleInfos, specifier),
  );

const resolveJsrSpecifier = (
  info: { redirects: { [k: string]: string } },
  specifier: string,
) => (specifier?.startsWith("jsr:") ? info.redirects[specifier] : specifier);

const resolveModuleSpecifier = ({
  specifier,
  local: cache,
}: ModuleEntryEsm) => {
  const isLocal = new URL(specifier).protocol === "file:";
  const entryPoint = isLocal ? fromFileUrl(specifier) : specifier;
  const local = cache ? toFileUrl(cache).href : specifier;
  return { isLocal, local, specifier, entryPoint };
};

const pkg = "npm:esbuild@0.21.4";
const withWritePermission: boolean =
  (await Deno.permissions.query({ name: "write", path: Deno.cwd() })).state ===
    "granted";
console.time("[rsc-engine] esbuild imported");
const esbuild: typeof Esbuild | null = withWritePermission
  ? ((await import(
    `data:application/javascript,export * from "${pkg}";`
  ).finally(() =>
    console.timeEnd("[rsc-engine] esbuild imported")
  )) as typeof Esbuild)
  : null;
const createTimeStartEnd = (ns: string, timeIndex = 0) => (key: string) => {
  const id = `[rsc-engine:${ns}:${timeIndex++}] ${key}`;
  console.time(id);
  return () => console.timeEnd(id);
};
const supportedMediaTypes = ["TSX", "JSX", "JavaScript", "TypeScript"];
export const hmrRebuildEventName = "hmr:rscengine:snapshot-created";

interface Manifest {
  entryPoint: string;
  external: string[];
  importMap: string;
  bootstrapModules: string[];
  moduleBaseURL: string;
  minify?: boolean;
  verbose?: "info" | "error";
  basePath?: string;
  namespace: string;
  clientImports?: {
    imports?: Record<string, string>;
    scopes?: Record<string, Record<string, string>>;
  };
}

interface ClientComponentsBaseOutput {
  locals: string[];
  updatedBootstrapModules: string[];
  updatedExternals: { [k: string]: string };
}

interface OutputMapping {
  [x: string]: { endpointPath: string };
}

const setupClientComponentsBase = async (
  manifest: Manifest,
  state: { entryPoints?: string[]; esbuildContext?: Esbuild.BuildContext },
): Promise<ClientComponentsBaseOutput> => {
  const basePath = manifest.basePath ?? "default";
  const logprefix = `[rsc-engine:${basePath}]`;
  const timeStartEnd = createTimeStartEnd(basePath);
  const relativeReferenceDirectory = join("build", basePath, "references");
  const relativeReferencesRegex = new RegExp(
    join("build", ".*?", "references"),
  );
  const absoluteReferenceDirectory = absolute(relativeReferenceDirectory);
  const relativeOutputDirectory = join("build", basePath, "es");
  const outputDirectory = absolute(relativeOutputDirectory);
  const endpointDirectory = join("/", manifest.basePath ?? ".", "build", "es");
  const localImportMapPath = absolute("deno.json");
  const localImportMap = await Deno.readTextFile(localImportMapPath).then(
    JSON.parse,
  );
  const snapshotPath = join("build", basePath, "snapshot.json");

  const snapshot = await Deno.readTextFile(snapshotPath)
    .then(JSON.parse)
    .catch(() => null);
  if (!esbuild) {
    if (!snapshot) {
      throw Error(
        "You must build before when using without write permissions.",
      );
    }
    console.log(logprefix, "using snapshot");
    globalExternals = { ...globalExternals, ...snapshot.updatedExternals };
    return snapshot as ClientComponentsBaseOutput;
  }

  const importMapResponse = await fetch(manifest.importMap);
  const importMap = (await importMapResponse.json()) as {
    imports?: Record<string, string>;
    scopes?: Record<string, Record<string, string>>;
  };
  const cleanReferences = createRemoveReferences(relativeReferenceDirectory);
  const scopesWithoutReferences = createRemoveReferences(
    relativeReferenceDirectory,
  )(importMap.scopes ?? {});

  const infoOptions = {
    quiet: true,
    importMap: `data:application/json,${
      JSON.stringify(
        resolveImportMap(
          {
            imports: Object.fromEntries(
              Object.entries({
                ...importMap.imports,
                ...(manifest.clientImports?.imports ?? {}),
              }).flatMap(([k, v]) => [
                [k, v],
                ...(k.endsWith("/") ? [] : [
                  [
                    `${k}/`,
                    `${v.replace("npm:", "npm:/").replace("jsr:", "jsr:/")}/`,
                  ],
                ]),
              ]),
            ),
            scopes: scopesWithoutReferences,
          },
          new URL(importMapResponse.url),
        ),
      )
    }`,
  };

  const esbuildOptions = { quiet: true, importMapURL: infoOptions.importMap };
  const timeEndInfo = timeStartEnd("info");
  const moduleInfos = await Promise.all(
    [manifest.entryPoint, ...manifest.bootstrapModules ?? []].map((
      entryPoint,
    ) => info(entryPoint, infoOptions)),
  );
  timeEndInfo();

  const timeEndDirective = timeStartEnd("directive");
  const modules = await Promise.all(
    moduleInfos
      .flatMap((info) => info.modules)
      .filter(
        (module): module is ModuleEntryEsm =>
          "kind" in module && module.kind === "esm",
      )
      .filter((module) => !relativeReferencesRegex.test(module.specifier))
      .filter((module) => supportedMediaTypes.includes(module.mediaType))
      .map(async (module) => {
        const { local } = resolveModuleSpecifier(module);
        const directive: "default" | "error" | "client" | "server" =
          await getUseDirective(local);

        return { ...module, directive };
      }),
  );
  timeEndDirective();

  const scopesWithDependencies = modules
    .filter((module) => module.directive !== "client")
    .map((module) => ({
      scope: module.specifier,
      dependencies: (module.dependencies ?? [])
        .map((dependency) => ({
          scope: module.specifier,
          dependency,
          module: modules.find(
            (module) =>
              module.specifier ===
                resolveJsrSpecifier(
                  moduleInfos[0],
                  dependency?.code?.specifier,
                ),
          )!,
        }))
        .filter((v) => ["client", "server"].includes(v.module?.directive)),
    }))
    .filter((scope) => scope.dependencies.length > 0);

  const entryPointModules = scopesWithDependencies
    .flatMap((scope) => scope.dependencies)
    .filter(({ module }) => module.directive === "client")
    .map(({ module }) => resolveModuleSpecifier(module))
    .map((resolvedModule) => resolvedModule.entryPoint);

  const entryPoints = [
    ...manifest.bootstrapModules,
    ...entryPointModules,
    ...(manifest.external ?? []),
  ];

  const symmetricDifference = new Set(entryPoints).symmetricDifference(
    new Set(state.entryPoints),
  );
  const useCacheContext = state.esbuildContext &&
    symmetricDifference.size === 0;
  if (state.esbuildContext && !useCacheContext) {
    console.log(logprefix, "renew context", symmetricDifference);
    state.esbuildContext?.dispose();
  }

  const esbuildServerResult = await esbuild.build({
    entryPoints: modules
      .filter((module) => module.directive === "server")
      .map((module) => resolveModuleSpecifier(module))
      .map((resolvedModule) => resolvedModule.entryPoint),
    plugins: [...denoPlugins(esbuildOptions)],
    metafile: true,
    write: false,
    outdir: absolute("."),
    format: "esm",
    jsx: "automatic",
  });

  const timeEndEntryInfo = timeStartEnd("entry-info");
  const entryInfos = await Promise.all(
    (
      await Promise.all(
        entryPoints.map((specifier) => info(specifier, infoOptions)),
      )
    )
      .flatMap((v) => v.modules)
      .filter((v) => "local" in v)
      .filter((v) => !v.specifier.startsWith("http"))
      .filter((v) => !v.specifier.startsWith("jsr:"))
      .filter((v) => !v.specifier.startsWith("npm:"))
      .map((v) => Deno.stat(v.local!).then(calculate)),
  );
  timeEndEntryInfo();

  let isPresentInJson = true;
  const newScopes = scopesWithDependencies
    .flatMap((scope) => scope.dependencies)
    .reduce((scopes, { module, dependency, scope }) => {
      const { specifier } = resolveModuleSpecifier(module);
      const outputFileName = format({
        name: `${parse(specifier).name}-${getHashSync(specifier)}`,
        ext: ".ts",
      });
      const relativeOutputFilePath = toImportUrl(
        join(relativeReferenceDirectory, outputFileName),
      );
      const moduleKey = new URL(scope).protocol === "file:" ||
          !dependency.specifier.startsWith(".")
        ? dependency.specifier
        : toImportUrl(getRelativePathOrUrl(specifier), "@");
      const relscope = toImportUrl(getRelativePathOrUrl(scope), ".");
      isPresentInJson =
        localImportMap.scopes[relscope]?.[moduleKey] === relativeOutputFilePath;
      const outputEntry = {
        ...scopes,
        [relscope]: {
          ...scopes[relscope],
          [moduleKey]: relativeOutputFilePath,
        },
      };
      return outputEntry;
    }, {} as { [x: string]: { [x: number]: string } });

  const hash = getHashSync(
    JSON.stringify({
      entryInfos,
      exports: Object.values(
        esbuildServerResult.metafile?.outputs ?? {},
      ).flatMap((v) => [v.entryPoint, v.exports]),
    }),
  );
  if (isPresentInJson && snapshot?.hash === hash) {
    console.log(
      logprefix,
      "using cached client components and server action names",
    );
    globalExternals = { ...globalExternals, ...snapshot.updatedExternals };
    return snapshot;
  }

  const esbuildServerActionPlugin: Esbuild.Plugin = {
    name: "client-server-actions",
    setup: (build) => {
      const cache = new Map();
      build.onLoad({ filter: /\.(ts|tsx)$/ }, async ({ path }) => {
        const value = cache.get(path);
        if (value) return value;
        const relativePath = getRelativePathOrUrl(path);
        const exports = Object.values(
          esbuildServerResult.metafile?.outputs ?? {},
        ).find(({ entryPoint }) => entryPoint === relativePath)?.exports;
        if (exports) {
          const value = {
            contents: generateServerReferenceClientCode(relativePath, exports),
            loader: "ts",
          };
          cache.set(path, value);
          return value;
        }
      });
    },
  };

  const removeExcept = async (dirPath: string, toKeep: string[]) => {
    if (!(await Deno.stat(dirPath).then(() => true).catch(() => false))) return;
    for await (const dirEntry of Deno.readDir(dirPath)) {
      const fn = join(dirPath, dirEntry.name);
      if (toKeep.includes(fn)) continue;
      await Deno.remove(join(dirPath, dirEntry.name), { recursive: true });
    }
  };

  state.esbuildContext = useCacheContext
    ? state.esbuildContext
    : await esbuild!.context({
      plugins: [
        esbuildServerActionPlugin,
        {
          name: "dynamic-react-resolver",
          setup(build: Esbuild.PluginBuild) {
            build.onResolve(
              {
                filter: /react\.react-server/,
              },
              () => {
                return {
                  path: "@bureaudouble/rsc-engine/react.react-server",
                  namespace: "react-dynamic",
                  external: true,
                };
              },
            );
          },
        },
        ...denoPlugins(esbuildOptions),
      ],
      entryPoints: [...entryPoints],
      entryNames: "[name]-[hash]",
      outdir: outputDirectory,
      bundle: true,
      splitting: true,
      metafile: true,
      treeShaking: true,
      write: false,
      minify: manifest.minify,
      format: "esm",
      jsx: "automatic",
    });
  state.entryPoints = entryPoints;

  const timeEndBuild = timeStartEnd("build");
  const esbuildResult = await state.esbuildContext!.rebuild();
  await removeExcept(
    outputDirectory,
    (esbuildResult.outputFiles ?? []).map((f) => f.path),
  );
  await Promise.all((esbuildResult.outputFiles ?? []).map(async (out) => {
    if (await Deno.stat(out.path).then(() => true).catch(() => false)) return;
    await Deno.mkdir(dirname(out.path), { recursive: true }).catch(
      () => null,
    );
    await Deno.writeFile(out.path, out.contents);
    console.log("[rsc-engine] wrote", out.path);
  }));
  timeEndBuild();

  const createProxySpecifier = (specifier: string) =>
    join(
      relativeReferenceDirectory,
      toImportUrl(
        format({
          name: `${parse(specifier).name}-${getHashSync(specifier)}-proxy`,
          ext: ".ts",
        }),
      ),
    );

  const toKeep: string[] = [];
  const notExistingYet: string[] = [];
  const outputMappings: OutputMapping = await scopesWithDependencies
    .flatMap((scope) => scope.dependencies)
    .reduce(async (promise, { module, scope }) => {
      const { specifier, entryPoint } = resolveModuleSpecifier(module);
      const relativeEntryPoint = getRelativePathOrUrl(entryPoint);
      const [outputRelativePath, { exports }] = Object.entries(
        (module.directive === "server" ? esbuildServerResult : esbuildResult)
          .metafile?.outputs ?? {},
      ).find(([, { entryPoint }]) => entryPoint === relativeEntryPoint)!;
      const proxyPoint = createProxySpecifier(specifier);
      toKeep.push(absolute(proxyPoint));
      await writeTextFileIfDifferent(
        absolute(proxyPoint),
        `export { ${exports.join(", ")} } from ${
          JSON.stringify(
            getRelativePathOrUrl(entryPoint, absoluteReferenceDirectory),
          )
        }`,
      );
      const fileContent = module.directive === "client"
        ? generateClientReferenceServerCode(
          relativeReferenceDirectory,
          proxyPoint,
          outputRelativePath,
          specifier,
          exports,
        )
        : generateServerReferenceServerCode(
          relativeReferenceDirectory,
          proxyPoint,
          exports,
        );
      const outputFileName = format({
        name: `${parse(specifier).name}-${getHashSync(specifier)}`,
        ext: ".ts",
      });
      const relativeOutputFilePath = toImportUrl(
        join(relativeReferenceDirectory, outputFileName),
      );
      toKeep.push(absolute(relativeOutputFilePath));
      if (
        !(await Deno.stat(absolute(relativeOutputFilePath)).catch(() => false))
      ) {
        notExistingYet.push(absolute(relativeOutputFilePath));
      }
      await writeTextFileIfDifferent(
        absolute(relativeOutputFilePath),
        fileContent,
      );
      const endpointPath = join(
        endpointDirectory,
        basename(outputRelativePath),
      );
      return promise.then((acc) => ({
        ...acc,
        [scope]: { endpointPath, outputPath: outputRelativePath },
      }));
    }, Promise.resolve({} as OutputMapping));

  await updateJsonFileIfDifferent(
    localImportMapPath,
    (data: {
      rscUpdateId?: string;
      imports: { [k: string]: string };
      scopes: { [k: string]: { [k: string]: string } };
    }) => {
      const jsonReferencesCode = Object.values(data?.scopes ?? {})
        .flatMap((v) => Object.values(v))
        .map((v) => absolute(v))
        .filter((v) => v.includes(basePath));
      const needRestartFiles = jsonReferencesCode.filter((v) =>
        notExistingYet.includes(v)
      );
      if (needRestartFiles.length > 0) {
        console.warn(
          logprefix,
          `need restart; missing ${needRestartFiles.length}`,
        );
      }

      return {
        ...data,
        scopes: {
          ...cleanReferences(data.scopes),
          ...Object.entries(newScopes).reduce(
            (acc, [scope, scopeMap]) => ({
              ...acc,
              [scope]: sortKeys({
                ...cleanReferences(data.scopes)[scope],
                ...scopeMap,
              }),
            }),
            {},
          ),
        },
        rscUpdateId: needRestartFiles.length > 0
          ? new Date().toISOString()
          : data.rscUpdateId,
      };
    },
  );

  await removeExcept(absoluteReferenceDirectory, toKeep);

  const endpointBasePath = manifest.basePath ?? ".";
  const updatedBootstrapModules = manifest.bootstrapModules
    .map((specifier, i) =>
      locateModuleInBuild(esbuildResult, specifier, moduleInfos.at(i + 1))!
    )
    .map((resolvedPath) => join("/", endpointBasePath, resolvedPath[0]));

  const updatedExternals = Object.fromEntries(
    (manifest.external ?? [])
      .map((specifier) =>
        locateModuleInBuild(esbuildResult, specifier, moduleInfos.at(0))!
      )
      .map((resolvedPath) => join("/", endpointBasePath, resolvedPath[0]))
      .map((v, i) => [getRelativePathOrUrl(manifest.external[i]), v]),
  );

  globalExternals = { ...globalExternals, ...updatedExternals };
  console.log(logprefix, "ended");
  return await updateJsonFileIfDifferent(snapshotPath, () => ({
    locals: modules
      .filter((module) => new URL(module.specifier).protocol === "file:")
      .map(({ specifier }) => getRelativePathOrUrl(specifier)),
    hash,
    updatedBootstrapModules,
    updatedExternals,
    outputMappings,
  }));
};

let globalExternals: Record<string, string> = {};
export const getUrlFromExternals = (k: string) =>
  globalExternals[
    new URL(k).protocol === "file:" ? relative(Deno.cwd(), fromFileUrl(k)) : k
  ];

export const setupClientComponents = async (manifest: Manifest) => {
  const state = {};
  let result = setupClientComponentsBase(manifest, state);
  if (new URL(manifest.entryPoint).protocol === "file:") {
    globalThis.addEventListener("hmr", async (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const dir = toFileUrl(absolute("build", manifest.basePath ?? "default"));
      if (detail.path.startsWith(dir)) return;
      const { locals } = await result;
      const module = locals?.includes(getRelativePathOrUrl(detail.path));
      if (module || parse(detail.path).ext?.startsWith("json")) {
        result = setupClientComponentsBase(manifest, state);
        await result;
      }
      globalThis.dispatchEvent(
        new CustomEvent(hmrRebuildEventName, { detail }),
      );
    });
  }

  if (withWritePermission) await result;

  const basePath = manifest.basePath ?? "default";
  return await Promise.resolve({
    hmrRebuildEventName,
    hasClientBuildFinished: () => result,
    pathTransformStream: async (stream: ReadableStream) =>
      new PathTransformStream(manifest.basePath ?? ".").getReadableStream(
        stream,
      ),
    getBootstrapModules: async () => (await result).updatedBootstrapModules,
    route: {
      match: {
        method: "GET" as const,
        pattern: new URLPattern({
          pathname: join(
            "/",
            manifest.basePath ?? ".",
            `/build/${basePath}/es/:id`,
          ),
        }),
      },
      handle: async (ctx: any) => {
        const rawfilename = toFileUrl(
          join(Deno.cwd(), "build", basePath, "es", ctx.params.id),
        );
        const response = await fetch(rawfilename.href).catch(() => null);
        const size = response?.headers.get("content-length");
        if (!response?.body) return new Response(null, { status: 404 });
        return new Response(response.body, {
          headers: {
            "Content-Type": "text/javascript",
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,OPTIONS,PATCH,DELETE,POST,PUT",
            "Access-Control-Allow-Headers": "*",
            "Cache-Control": "public, max-age=31536000, immutable",
            ...(size ? { "content-length": String(size) } : {}),
          },
        });
      },
    },
  }).then((result) => ({
    ...result,
    render: createRenderer(result, manifest.moduleBaseURL),
  }));
};
