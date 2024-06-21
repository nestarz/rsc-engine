"use client";
// @deno-types="@types/react"
import { lazy, Suspense, useEffect, useState } from "react";

const cache = new Map();
const namedLazy = (f: string, e?: string) =>
  lazy(() =>
    import(f).then((v) =>
      new Promise((res) =>
        setTimeout(() => res({ default: v[e ?? "default"] } as any), 5) // hack for circular ?
      )
    )
  );

export const ClientReference = ({
  fileUrl,
  exportName,
  fallback,
  ...props
}: {
  fileUrl: string;
  exportName?: string | "default";
} & Record<string, any>) => {
  const [isMounted, setMounted] = useState<boolean>(false);
  const id = `${fileUrl}#${exportName}`;
  const Component = cache.get(id) ??
    cache.set(id, namedLazy(fileUrl, exportName)).get(id);
  useEffect(() => void setMounted(true), []);
  return isMounted
    ? (
      <Suspense fallback={fallback}>
        <Component {...props} />
      </Suspense>
    )
    : null;
};

export default ClientReference;
