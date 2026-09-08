const LAYERS = new Set([
  "business",
  "data",
  "coordinators",
  "entrypoints",
  "dto",
]);

export interface Classification {
  module: string | null;
  layer: string;
  isModRoot: boolean;
  isPolyMod: boolean;
  isBootstrap: boolean;
}

export function classifyFile(path: string): Classification {
  const segs = path.split("/");
  const baseName = segs[segs.length - 1].replace(/\.[^.]+$/, "");

  if (segs[0] !== "src") {
    return {
      module: null,
      layer: "unknown",
      isModRoot: false,
      isPolyMod: false,
      isBootstrap: false,
    };
  }

  const isModRoot = baseName === "mod-root";
  const isPolyMod = baseName === "poly-mod";
  const isBootstrap = segs[1] === "bootstrap";

  if (isBootstrap) {
    return {
      module: "bootstrap",
      layer: "bootstrap",
      isModRoot,
      isPolyMod,
      isBootstrap,
    };
  }

  const module = segs[1] ?? null;
  const layer = segs.find((s) => LAYERS.has(s)) ?? "unknown";

  return { module, layer, isModRoot, isPolyMod, isBootstrap };
}

export function getModuleFromPath(path: string): string | null {
  const segs = path.split("/");
  return segs[0] === "src" ? segs[1] ?? null : null;
}

export function getLayerFromPath(path: string): string {
  return path.split("/").find((s) => LAYERS.has(s)) ?? "unknown";
}

export function isModRootImport(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return base.replace(/\.[^.]+$/, "") === "mod-root";
}
