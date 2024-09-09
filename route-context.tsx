import type { RouterContext } from "@fartlabs/rt";
import { AsyncLocalStorage } from "node:async_hooks";
/* @deno-types="@types/react" */
import { cache } from "react";

type ReactRouterContext = RouterContext<
  any,
  {
    id: number;
    redirect: (v: string) => void;
    routeStorage?: AsyncLocalStorage<any>;
  }
>;

const getRouteContext_ = cache(() => ({ id: Math.random() }));
export const routeStorage: {
  run: <T extends (...args: any) => any, U>(
    k: U,
    fn: T,
    ...args: any[]
  ) => ReturnType<T>;
  getStore: () => any;
} = new AsyncLocalStorage();
export const getRouteContext = (): ReactRouterContext =>
  routeStorage.getStore() ?? getRouteContext_();

const Context = (
  { ctx, Component }: {
    ctx: ReactRouterContext;
    Component: React.FC<ReactRouterContext>;
  },
) => {
  Object.assign(getRouteContext(), ctx);
  return <Component {...ctx} />;
};
export const withRouteContext = (handle: () => any) => {
  return async () => {
    const { default: Component } = await handle();
    return {
      default: (ctx: ReactRouterContext) => (
        <Context ctx={ctx} Component={Component} />
      ),
    };
  };
};

export const routeStorageMiddleware = (ctx: ReactRouterContext) => (
  (ctx.state.routeStorage = routeStorage), ctx.next()
);
