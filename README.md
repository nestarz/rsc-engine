# @bureaudouble/rsc-engine

RSC Engine is a TypeScript library designed to facilitate the building and
rendering of React Server Components (RSC). It leverages Esbuild and Deno to
provide a seamless experience for handling client and server components,
ensuring efficient and effective module management.

## Features

- **Dynamic Module Resolution**: Automatically resolves and handles client and
  server components.
- **Esbuild Integration**: Utilizes Esbuild for bundling and transpiling client
  modules.
- **Hot Module Replacement (HMR)**: Supports HMR for efficient development
  workflows.
- **Scoped Import Maps**: Use scoped import maps for efficient module
  resolution.
- **Support RSC**: Support "use server" and "use client" directives.

## Use the demo

git clone [github.com/nestarz/bureaudouble-rsc-demo](https://github.com/nestarz/bureaudouble-rsc-demo.git)

## Installation

Ensure you have Deno installed. You can install it from
[deno.land](https://deno.land/#installation).

Add the package to your project:

```bash
deno add jsr:@bureaudouble/rsc-engine
```

## Usage

### Setup

To use the RSC Engine, you need to set up a manifest file that specifies your
project configuration. Below is an example of a manifest file:

```ts
const manifest = {
  entryPoint: import.meta.url,
  bootstrapModules: [import.meta.resolve("@bureaudouble/rsc-engine/client")],
};
```

### Creating a Hello World Component with "use client" and "use server" features:

```tsx
// /app/pages/index.tsx
import ClientComponent from "@/app/components/client.tsx";
import getServerDate from "@/app/actions/get-server-date.ts";

export default async function HelloWorld() {
  return (
    <html>
      <body>
        <h1>Hello, World!</h1>
        <ClientComponent initial={await getServerDate()} />
      </body>
    </html>
  );
}

// /app/components/client.tsx
"use client";
import getServerDate from "@/app/actions/get-server-date.ts";
import { useState, useTransition } from "react";

export default function ClientComponent({ initial }) {
  const [isPending, startTransition] = useTransition();
  const [serverDate, setServerDate] = useState(initial);
  const onClick = () =>
    startTransition(async () => void setLikeCount(await getServerDate()));
  return (
    <button onClick={onClick} disabled={isPending}>
      {serverDate}
    </button>
  );
}

// /app/actions/get-server-date.ts
"use server";

export default function getServerDate() {
  return Date.now();
}
```

### Build and serve

To serve or build your project, run the setup function using a router (ex: @fartlabs/rt) this way:

```typescript
// main.ts
import { setupClientComponents } from "@bureaudouble/rsc-engine";
import { createRouter } from "jsr:@fartlabs/rt@0.0.3";

const setup = await setupClientComponents(manifest);

const clientRsc = await setupClientComponents({
  entryPoint: import.meta.url,
  bootstrapModules: [import.meta.resolve("@bureaudouble/rsc-engine/client")],
});

const router = createRouter()
  .with(clientRsc.route)
  .use(clientRsc.createRscRoutes({ "/": import("@/app/pages/index.tsx") }));

Deno.args.some((v) => v === "build")
  ? Deno.exit(0)
  : Deno.serve((request) => router.fetch(request));
```

Run the script with HMR enabled:

```bash
deno run --allow-read --allow-write --allow-net --unstable-hmr main.ts
```

Run the build:

```bash
deno run --allow-read --allow-write --allow-net --unstable-hmr main.ts build
```

## License

This project is licensed under the CC0-1.0 License. See the [LICENSE](LICENSE)
file for more information.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on
GitHub.
