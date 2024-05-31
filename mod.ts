import type * as Esbuild from "esbuild-types";

import { format } from "@std/path/format";
import { parse } from "@std/path/parse";
import { relative } from "@std/path/relative";
import { toFileUrl } from "@std/path/to-file-url";
import { join } from "@std/path/join";
import { basename } from "@std/path/basename";
import { fromFileUrl } from "@std/path/from-file-url";
import { resolveImportMap } from "@bureaudouble-forks/importmap";
import { denoPlugins } from "@luca/esbuild-deno-loader";
import { RateLimiter } from "@teemukurki/rate-limiter";
import { getHashSync } from "@bureaudouble/scripted";

import { info, type ModuleEntryEsm } from "./info.ts";

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

const createRemoveReferences = (basePath: string) => (value: string) =>
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

const generateReferenceCode = (specifierURL: string, ids: string[]) =>
  [
    `"use client";`,
    `import * as mod from ${JSON.stringify(specifierURL)};`,
    `const { registerClientReference: rcr } = globalThis.document ? {} : await import("react-server-dom-esm/server.edge");`,
    `const __url = ${JSON.stringify(specifierURL)};`,
    ...ids.map((exportName) => {
      const exportKey = exportName === "default"
        ? "export default"
        : `export const ${exportName} =`;
      return `${exportKey} !rcr ? mod[${
        JSON.stringify(
          exportName,
        )
      }] : rcr?.({}, __url, ${JSON.stringify(exportName)});`;
    }),
  ].join("\n");

const limiter = new RateLimiter({ tokensPerInterval: 60, interval: "second" });
const getUseDirective = async (specifier: string) => {
  if (new URL(specifier).protocol !== "file:") {
    await limiter.removeTokens(1);
  }
  const response = await fetch(specifier).catch(console.error);
  if (!response?.body) return false;
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

  constructor(
    private pathMap: Record<string, { endpointPath: string }>,
    private baseURL: string,
  ) {
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
          const path = getRelativePathOrUrl(
            new URL(originalPath, this.baseURL).href,
          );
          const newPath = this.pathMap[path]?.endpointPath ?? originalPath;
          return `${line.slice(0, start)}${newPath}${line.slice(end)}`;
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
const getRelativePathOrUrl = (specifier: string) =>
  URL.canParse(specifier)
    ? new URL(specifier).protocol === "file:"
      ? relative(Deno.cwd(), fromFileUrl(specifier))
      : specifier
    : relative(Deno.cwd(), specifier);

const locateModuleInBuild = (build: Esbuild.BuildResult, specifier: string) =>
  Object.entries(build.metafile?.outputs ?? {}).find(
    ([, v]) => v.entryPoint === getRelativePathOrUrl(specifier),
  );

const createResolveSpecifier =
  (scopes: { [t: string]: { [t: string]: string } }, referenceDir: string) =>
  (
    { specifier, local: cache }: ModuleEntryEsm,
  ) => {
    if (specifier.includes(relative(Deno.cwd(), referenceDir))) {
      const scopeEntry = Object.values(scopes)
        .flatMap((v) => Object.entries(v))
        .find(([, value]) => value === getRelativePathOrUrl(specifier));
      if (scopeEntry) {
        const [scopeUrl] = scopeEntry;
        return null!;
      }
    }
    const isLocal = new URL(specifier).protocol === "file:";
    const entryPoint = isLocal ? fromFileUrl(specifier) : specifier;
    const local = cache ? toFileUrl(cache).href : specifier;
    return { isLocal, local, specifier, entryPoint };
  };

const pkg = "npm:esbuild@0.21.3";
const withWritePermission: boolean =
  (await Deno.permissions.query({ name: "write", path: Deno.cwd() })).state ===
    "granted";
const esbuild: typeof Esbuild | null = withWritePermission
  ? ((await import(
    `data:application/javascript,export * from "${pkg}";`
  ).finally(() => console.log("[islet:esbuild] imported"))) as typeof Esbuild)
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
}

interface ClientComponentsBaseOutput {
  updatedBootstrapModules: string[];
  updatedExternals: { [k: string]: string };
  outputMappings: {
    [x: string]: { outputEntry: { [x: string]: string }; endpointPath: string };
  };
  modules: {
    directive: boolean | "default" | "client" | "server";
    specifier: string;
  }[];
}

const setupClientComponentsBase = async (
  manifest: Manifest,
): Promise<ClientComponentsBaseOutput> => {
  const basePath = manifest.basePath ?? "default";
  const logprefix = `[rsc-engine:${basePath}]`;
  const timeStartEnd = createTimeStartEnd(basePath);
  const relativeReferenceDirectory = join("build", basePath, "references");
  const absoluteReferenceDirectory = absolute(relativeReferenceDirectory);
  const outputDirectory = absolute("build", basePath, "es");
  const endpointDirectory = join("/", manifest.basePath ?? ".", "build", "es");
  const localImportMapPath = absolute("deno.json");
  const snapshotPath = join("build", basePath, "snapshot.json");

  if (!esbuild) {
    console.log(logprefix, "using snapshot");
    const snapshot = await Deno.readTextFile(snapshotPath).then(JSON.parse);
    globalExternals = { ...globalExternals, ...snapshot.updatedExternals };
    return snapshot as ClientComponentsBaseOutput;
  }

  const importMapResponse = await fetch(manifest.importMap);
  const importMap = await importMapResponse.json();
  const cleanReferences = createRemoveReferences(relativeReferenceDirectory);
  const scopesWithoutReferences = createRemoveReferences(
    relativeReferenceDirectory,
  )(importMap.scopes);
  const resolveModuleSpecifier = createResolveSpecifier(
    scopesWithoutReferences,
    absoluteReferenceDirectory,
  );

  await Deno.mkdir(absoluteReferenceDirectory, { recursive: true }).catch(
    () => null,
  );
  const esbuildOptions = {
    quiet: true,
    importMapURL: `data:application/json,${
      JSON.stringify(
        resolveImportMap(
          { ...importMap, scopes: scopesWithoutReferences },
          new URL(importMapResponse.url),
        ),
      )
    }`,
  };
  const timeEndInfo = timeStartEnd("info");
  const moduleInfos = await Promise.all(
    [manifest.entryPoint].map((entryPoint) => info(entryPoint, esbuildOptions)),
  );
  timeEndInfo();

  const timeEndDirective = timeStartEnd("directive");
  const modules = await Promise.all(
    moduleInfos
      .flatMap((info) => info.modules)
      .filter((module): module is ModuleEntryEsm =>
        "kind" in module && module.kind === "esm"
      )
      .filter((module) => supportedMediaTypes.includes(module.mediaType))
      .map(async (module) => {
        const { local } = resolveModuleSpecifier(module);
        const directive = await getUseDirective(local);
        return { ...module, directive };
      }),
  );
  timeEndDirective();

  const scopesWithDependencies = modules
    .filter((module) => module.directive !== "client")
    .map((module) => ({
      scope: module.specifier,
      dependencies: (module.dependencies ?? [])
        .filter((dependency) =>
          modules
            .filter((module) => module.directive === "client")
            .some((module) => module.specifier === dependency?.code?.specifier)
        )
        .map((dependency) =>
          modules.find(
            (module) => module.specifier === dependency.code.specifier,
          )!
        ).filter((v) => !!v),
    }))
    .filter((scope) => scope.dependencies.length > 0);

  const entryPointModules = scopesWithDependencies
    .flatMap((scope) => scope.dependencies)
    .map((module) => resolveModuleSpecifier(module))
    .map((resolvedModule) => resolvedModule.entryPoint);

  const esbuildContext = await esbuild!.context({
    plugins: [...denoPlugins(esbuildOptions)],
    entryPoints: [
      ...manifest.bootstrapModules,
      ...entryPointModules,
      ...(manifest.external ?? []),
    ],
    entryNames: "[name]-[hash]",
    outdir: outputDirectory,
    bundle: true,
    splitting: true,
    metafile: true,
    treeShaking: true,
    minify: manifest.minify,
    format: "esm",
    jsx: "automatic",
  });

  const timeEndBuild = timeStartEnd("build");
  const esbuildResult = await esbuildContext?.rebuild();
  timeEndBuild();

  const outputMappings: {
    [x: string]: {
      outputEntry: { [x: string]: string };
      endpointPath: string;
    };
  } = await scopesWithDependencies
    .flatMap((scope) => scope.dependencies)
    .reduce(async (promise, module) => {
      const { specifier, entryPoint } = resolveModuleSpecifier(module);
      const relativeEntryPoint = getRelativePathOrUrl(entryPoint);
      const [outputRelativePath, { exports }] = Object
        .entries(esbuildResult.metafile.outputs).find(
          ([, { entryPoint }]) => entryPoint === relativeEntryPoint,
        )!;
      const fileContent = generateReferenceCode(entryPoint, exports);
      const outputFileName = format({
        name: `${parse(specifier).name}-${getHashSync(fileContent)}`,
        ext: ".ts",
      });
      const relativeOutputFilePath = toImportUrl(
        join(relativeReferenceDirectory, outputFileName),
      );
      await writeTextFileIfDifferent(
        absolute(relativeOutputFilePath),
        fileContent,
      );
      const moduleKey = toImportUrl(getRelativePathOrUrl(specifier), "@");
      const outputEntry = { [moduleKey]: relativeOutputFilePath };
      const endpointPath = join(
        endpointDirectory,
        basename(outputRelativePath),
      );
      return promise.then((acc) => ({
        ...acc,
        [getRelativePathOrUrl(specifier)]: { outputEntry, endpointPath },
      }));
    }, Promise.resolve({}));

  await updateJsonFileIfDifferent(localImportMapPath, (data) => ({
    ...data,
    scopes: {
      ...cleanReferences(data.scopes),
      ...scopesWithDependencies.reduce(
        (acc, scope) => ({
          ...acc,
          [scope.scope]: sortKeys(
            scope.dependencies
              .map((dependency) => getRelativePathOrUrl(dependency.specifier))
              .reduce(
                (dependenciesAcc, dependency) => ({
                  ...dependenciesAcc,
                  ...(outputMappings[dependency]?.outputEntry ?? {}),
                }),
                cleanReferences(data.scopes)?.[scope.scope] ?? {},
              ),
          ),
        }),
        {},
      ),
    },
  }));

  const updatedBootstrapModules = manifest.bootstrapModules
    .map((specifier) => locateModuleInBuild(esbuildResult, specifier)!)
    .map((resolvedPath) => join(endpointDirectory, basename(resolvedPath[0])));

  const updatedExternals = Object.fromEntries(
    (manifest.external ?? [])
      .map((specifier) => locateModuleInBuild(esbuildResult, specifier)!)
      .map((resolvedPath) => join(endpointDirectory, basename(resolvedPath[0])))
      .map((v, i) => [getRelativePathOrUrl(manifest.external[i]), v]),
  );

  globalExternals = { ...globalExternals, ...updatedExternals };
  return {
    modules,
    ...(await updateJsonFileIfDifferent(snapshotPath, () => ({
      updatedBootstrapModules,
      updatedExternals,
      outputMappings,
    }))),
  };
};

let globalExternals: Record<string, string> = {};
export const getUrlFromExternals = (k: string) =>
  globalExternals[
    new URL(k).protocol === "file:" ? relative(Deno.cwd(), fromFileUrl(k)) : k
  ];

export const setupClientComponents = async (manifest: Manifest) => {
  let result = setupClientComponentsBase(manifest);
  globalThis.addEventListener("hmr", async (event: Event) => {
    const detail = (event as CustomEvent).detail;
    const { modules } = await result;
    const getModule = (path: string) =>
      modules.find((module) => module.specifier === path);
    const module = getModule(detail.path);
    if (module || parse(detail.path).ext?.startsWith("json")) {
      result = setupClientComponentsBase(manifest);
      await result;
    }
    globalThis.dispatchEvent(new CustomEvent(hmrRebuildEventName, { detail }));
  });

  return await Promise.resolve({
    hmrRebuildEventName,
    hasClientBuildFinished: () => result,
    pathTransformStream: async (stream: ReadableStream) =>
      new PathTransformStream(
        (await result).outputMappings,
        manifest.moduleBaseURL,
      ).getReadableStream(stream),
    getBootstrapModules: async () => (await result).updatedBootstrapModules,
  });
};
