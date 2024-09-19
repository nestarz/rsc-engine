import type { RouterContext } from "@fartlabs/rt";
import { AsyncLocalStorage } from "node:async_hooks";
/* @deno-types="@types/react" */
import * as React from "react";

type ReactRouterContext = RouterContext<
  any,
  {
    id: number;
    redirect: (v: string) => void;
    routeStorage?: AsyncLocalStorage<any>;
  }
>;

const getRouteContext_ = (React as any).cache(() => ({ id: Math.random() }));
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
  { ctx, Component: ComponentPromise }: {
    ctx: ReactRouterContext;
    Component:
      | React.FC<ReactRouterContext>
      | Promise<React.FC<ReactRouterContext>>;
  },
) => {
  Object.assign(getRouteContext(), ctx);
  const Component: React.FC<any> = React.use(ComponentPromise as any);
  return <Component {...ctx} />;
};
export const withRouteContext = <T extends React.FC<ReactRouterContext>>(
  routeComponent: Promise<T> | T,
) => {
  return () => {
    return Promise.resolve({
      default: (ctx: ReactRouterContext) => (
        <Context ctx={ctx} Component={Promise.resolve(routeComponent)} />
      ),
    });
  };
};

export const routeStorageMiddleware = (ctx: ReactRouterContext) => (
  (ctx.state.routeStorage = routeStorage as any), ctx.next()
);
