// @deno-types="@types/react"
import {
  Component,
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  startTransition,
  type Usable,
  use,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  createFromReadableStream,
  encodeReply,
} from "react-server-dom-esm/client.browser";
// @deno-types="@types/react-dom/client"
import { hydrateRoot } from "react-dom/client";
import { rscStream } from "rsc-html-stream/client";
import urlcat from "@bureaudouble/outils/urlcat.ts";

const contentMap = new Map<string, ControlledRoot>();

const getURLPath = () =>
  globalThis.location.href.replace(globalThis.location.origin, "");

const ErrorContext = createContext({
  pathname: getURLPath(),
  error: null as Error | null,
  setError: (_arg: Error | null) => {},
  subscribe: (_callback: (error: Error | null) => void) => {},
});

const ErrorContextProvider = ({
  children,
  initialPathname,
}: {
  initialPathname: string;
  children: ReactNode;
}) => {
  const [error, setError] = useState<Error | null>(null);
  const [pathname, setPathname] = useState<string>(initialPathname);
  const subscribers = useRef<((error: Error | null) => void)[]>([]);
  useEffect(() => {
    if (!error) return;
    contentMap.delete(getURLPath());
    const listener = () => (setPathname(getURLPath()), setError(null));
    globalThis.addEventListener("popstate", listener);
    return () => globalThis.removeEventListener("popstate", listener);
  }, [error]);
  useEffect(() => {
    subscribers.current.forEach((callback) => callback(error));
  }, [error]);
  const subscribe = (callback: (error: Error | null) => void) => {
    subscribers.current.push(callback);
  };
  return (
    <ErrorContext value={{ error, pathname, setError, subscribe }}>
      <ErrorBoundary>{children}</ErrorBoundary>
    </ErrorContext>
  );
};

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  static contextType = ErrorContext;
  declare context: React.ContextType<typeof ErrorContext>;

  componentDidMount() {
    this.context.subscribe((error) => this.setState({ error }));
  }

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: Error) {
    this.context.setError(error);
  }

  render() {
    if (this.state?.error) {
      return (
        <html>
          <head>
            <link rel="stylesheet" href="/styles/styles.css" />
          </head>
          <body className="p-4">
            <h1 className="font-bold">Error</h1>
            <p>{this.context.error?.message}</p>
          </body>
        </html>
      );
    }
    return this.props.children;
  }
}

interface ControlledRoot {
  root: Usable<any>;
  abortController?: AbortController;
}
interface ReadableStreamOptions {
  callServer: (id: string, args: unknown[]) => Usable<any>;
}

let pid: number;
const timeConstant = 10 * 1000;
const progressHandler = () => {
  const set = (v: number) =>
    document
      .getElementById("rsc-fetch-value")
      ?.style.setProperty("--value", (v * 100).toString());
  clearInterval(pid);
  set(0);
  const startTime = Date.now();
  pid = setInterval(() => {
    const elapsedTime = Date.now() - startTime;
    const progressValue = 1 - Math.exp(-elapsedTime / timeConstant);
    set(progressValue);
    if (progressValue >= 1) {
      clearInterval(pid);
      set(1);
    }
  }, 10);
  return () => {
    clearInterval(pid);
    set(0);
  };
};

let cacheSetComponent: Dispatch<SetStateAction<ControlledRoot | undefined>>;
export const useNavigation = () => {
  const { pathname: initialPathname } = useContext(ErrorContext);
  const [component, setComponent] = useState<ControlledRoot>();
  cacheSetComponent = setComponent;
  const readableStreamOptions: ReadableStreamOptions = {
    callServer: async (id: string, args: unknown[]) => {
      const abortController = new AbortController();
      const signal = abortController.signal;
      const endProgress = progressHandler();
      const endpoint = globalThis.location.pathname.startsWith("/admin")
        ? "/admin/actions"
        : "/actions";
      const response = await fetch(urlcat(endpoint, { rsc_action_id: id }), {
        method: "POST",
        signal,
        headers: { accept: "text/x-component" },
        body: await encodeReply(args),
      });
      const redirect = response.headers.get("x-rsc-redirect");
      if (redirect && redirect !== globalThis.location.hostname) {
        contentMap.clear();
        globalThis.location.href = redirect;
        return;
      }
      const url = new URL(response.url);
      if (response.redirected) {
        contentMap.clear();
        globalThis.history.pushState(null, "", url.pathname);
      }
      const actionResult = createFromReadableStream(
        response.body,
        readableStreamOptions,
      );
      actionResult.finally(endProgress);
      const pathname = getURLPath();
      contentMap.set(pathname, {
        abortController,
        root: Promise.all([contentMap.get(pathname)?.root, actionResult]).then(
          ([root, { _value, ...v }]) => ({ ...(root ?? {}), ...v }),
        ),
      });
      startTransition(() => cacheSetComponent(contentMap.get(pathname)!));
      const value = (await actionResult)._value;
      if (typeof value === "object") {
        if ("revalidatePath" in value) {
          contentMap.delete(value.revalidatePath);
        }
        if ("reload" in value) {
          const url = typeof value.reload === "string"
            ? value.reload
            : getURLPath();
          globalThis.history.pushState(null, "", url);
          startTransition(() => globalThis.navigate?.(url, { force: true }));
        }
      }
      return value;
    },
  };
  globalThis.callServer = readableStreamOptions.callServer;
  const navigate = (
    path: string,
    options?: { force?: boolean; preventVisitLog?: boolean },
  ) => {
    startTransition(async () => {
      if (options?.force || !contentMap.get(path)) {
        const endProgress = progressHandler();
        const abortController = new AbortController();
        const signal = abortController.signal;
        const headers = { Accept: "text/x-component" };
        const response = await fetch(path, { signal, headers });
        const redirect = response.headers.get("x-rsc-redirect");
        if (redirect && redirect !== globalThis.location.hostname) {
          contentMap.clear();
          globalThis.location.href = redirect;
          return;
        }
        const url = new URL(response.url);
        if (response.redirected) {
          contentMap.clear();
          globalThis.history.pushState(null, "", url.pathname);
        }
        const pathname = getURLPath();
        const root = createFromReadableStream(
          response.body!,
          readableStreamOptions,
        );
        root.finally(endProgress);
        contentMap.set(pathname, { abortController, root });
      }
      const pathname = getURLPath();
      const nextComponent = contentMap.get(pathname);
      if (!nextComponent) return;
      component?.abortController?.abort();
      //getRoot().render(nextComponent.root);
      //void globalThis.scrollTo(0, 0);
      // console.log(nextComponent);
      setComponent(nextComponent);
      if (!options?.preventVisitLog) {
        (globalThis as any)._pageView?.();
      }
      // setPathname(path);
    });
  };
  globalThis.navigate = navigate;

  const interceptLinkClick = (event_: Event) => {
    const event = event_ as MouseEvent;
    if (event.defaultPrevented) return;
    let target = event.target as HTMLAnchorElement | null;
    if (target?.tagName !== "A") target = target?.closest("a") ?? null;
    const goodKey = !event.metaKey && !event.ctrlKey && !event.shiftKey &&
      !event.altKey;
    if (target && goodKey) {
      const href = target.getAttribute("href");
      if (href?.startsWith("/") && target.getAttribute("target") !== "_self") {
        event.preventDefault();
        globalThis.history.pushState(null, "", href);
        navigate(href);
      }
    }
  };

  useEffect(() => {
    type EventListenerArgs = [string, EventListener, boolean?];
    const arr: EventListenerArgs[] = [];
    const listen = (...v: EventListenerArgs) =>
      globalThis.addEventListener(...arr.at(arr.push(v) - 1)!);
    const getHref = () => globalThis.location.href;
    let previousHref = getHref();
    const getPathnameFrom = (url: string | URL) =>
      new URL(url).pathname + new URL(url).search;
    const setUrl = () => setTimeout(() => (previousHref = getHref()), 0);
    const isLog = () =>
      new URL(previousHref).pathname === new URL(getHref()).pathname;
    listen("click", interceptLinkClick, true);
    listen("popstate", () => {
      if (getPathnameFrom(previousHref) !== getPathnameFrom(getHref())) {
        navigate(getURLPath(), { preventVisitLog: isLog() });
      }
    });
    listen(
      "hmr",
      () => navigate(getURLPath(), { force: true, preventVisitLog: isLog() }),
    );
    listen("click", setUrl, true);
    listen("popstate", setUrl);
    return () => arr.forEach((v) => globalThis.removeEventListener(...v));
  }, []);

  useEffect(() => void globalThis.scrollTo(0, 0), [component]);

  return use(
    (
      component ??
        contentMap.get(initialPathname) ??
        contentMap
          .set(initialPathname, {
            root: createFromReadableStream(rscStream, readableStreamOptions),
          })
          .get(initialPathname)!
    ).root,
  );
};

const Route = () => useNavigation();

hydrateRoot(
  globalThis.document,
  <ErrorContextProvider initialPathname={getURLPath()}>
    <Route />
  </ErrorContextProvider>,
);
