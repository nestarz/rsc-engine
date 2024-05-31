let tmpDir: string | undefined;

// Lifted from https://raw.githubusercontent.com/denoland/deno_graph/89affe43c9d3d5c9165c8089687c107d53ed8fe1/lib/media_type.ts
export type MediaType =
  | "JavaScript"
  | "Mjs"
  | "Cjs"
  | "JSX"
  | "TypeScript"
  | "Mts"
  | "Cts"
  | "Dts"
  | "Dmts"
  | "Dcts"
  | "TSX"
  | "Json"
  | "Wasm"
  | "TsBuildInfo"
  | "SourceMap"
  | "Unknown";

interface InfoOutput {
  roots: string[];
  modules: ModuleEntry[];
  redirects: Record<string, string>;
  npmPackages: Record<string, NpmPackage>;
}

export type ModuleEntry =
  | ModuleEntryError
  | ModuleEntryEsm
  | ModuleEntryJson
  | ModuleEntryNpm
  | ModuleEntryNode;

export interface ModuleEntryBase {
  specifier: string;
}

export interface ModuleEntryError extends ModuleEntryBase {
  error: string;
}

export interface ModuleEntryEsm extends ModuleEntryBase {
  kind: "esm";
  local: string | null;
  emit: string | null;
  map: string | null;
  mediaType: MediaType;
  size: number;
  dependencies?: Dependency[];
}

export interface ModuleEntryJson extends ModuleEntryBase {
  kind: "asserted" | "json";
  local: string | null;
  mediaType: MediaType;
  size: number;
}

export interface ModuleEntryNpm extends ModuleEntryBase {
  kind: "npm";
  npmPackage: string;
}

export interface ModuleEntryNode extends ModuleEntryBase {
  kind: "node";
  moduleName: string;
}

interface Dependency {
  specifier: string;
  code: {
    specifier: string;
    span: {
      start: {
        line: number;
        character: number;
      };
      end: {
        line: number;
        character: number;
      };
    };
  };
}

export interface NpmPackage {
  name: string;
  version: string;
  dependencies: string[];
}

interface InfoOptions {
  cwd?: string;
  config?: string;
  importMap?: string;
  lock?: string;
  nodeModulesDir?: boolean;
  quiet?: boolean;
}

export async function info(
  specifier: string,
  options: InfoOptions,
): Promise<InfoOutput> {
  const opts = {
    args: ["info", "--json"],
    cwd: undefined as string | undefined,
    env: { DENO_NO_PACKAGE_JSON: "true" } as Record<string, string>,
    stdout: "piped",
    stderr: "inherit",
  };
  if (typeof options.config === "string") {
    opts.args.push("--config", options.config);
  } else {
    opts.args.push("--no-config");
  }
  if (options.importMap) {
    opts.args.push("--import-map", options.importMap);
  }
  if (typeof options.lock === "string") {
    opts.args.push("--lock", options.lock);
  } else if (!options.cwd) {
    opts.args.push("--no-lock");
  }
  if (options.nodeModulesDir) {
    opts.args.push("--node-modules-dir");
  }
  if (options.quiet) {
    opts.args.push("--quiet");
  }
  if (options.cwd) {
    opts.cwd = options.cwd;
  } else {
    if (!tmpDir) tmpDir = Deno.makeTempDirSync();
    opts.cwd = tmpDir;
  }

  opts.args.push(specifier);

  const output = await new Deno.Command(
    Deno.execPath(),
    opts as Deno.CommandOptions,
  ).output();
  if (!output.success) {
    throw new Error(`Failed to call 'deno info' on '${specifier}'`);
  }
  const txt = new TextDecoder().decode(output.stdout);
  return JSON.parse(txt);
}

