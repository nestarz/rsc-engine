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

See the framework in action here: https://bureaudouble-rsc-demo.deno.dev/

To create a new project based on the demo, run:

```bash
git clone https://github.com/nestarz/bureaudouble-rsc-demo.git
cd bureaudouble-rsc-demo
deno run start
```

## Installation

Ensure you have Deno installed. You can install it from
[deno.land](https://deno.land/#installation).

Add the package to your project:

```bash
deno add jsr:@bureaudouble/rsc-engine
```

## Usage

### Creating a Hello World Component with "use client" and "use server" features:

```tsx
// /app/pages/index.tsx
import ClientComponent from "@/app/components/client.tsx";
import getServerDate from "@/app/actions/get-server-date.ts";

export default async function HelloWorld() {
  return (
    <html>
      <body>
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
  return `Hello World, the server date is ${Date.now()}`;
}
```

### Setup

To use the RSC Engine, you need to set up a main file that will build and serve your project. You also need a special `deno.json` which will resolve accordingly the react ecosystem specifiers, you need to take this one as a base: https://github.com/nestarz/bureaudouble-rsc-demo/blob/main/deno.json.

### Build and serve

To serve or build your project, run the setup function using a router (ex: @fartlabs/rt) this way:

```typescript
// main.ts
import { setupClientComponents } from "@bureaudouble/rsc-engine";
import { createRouter } from "jsr:@fartlabs/rt@0.0.3";

const setup = await setupClientComponents({
  entryPoint: import.meta.url,
  bootstrapModules: [import.meta.resolve("@bureaudouble/rsc-engine/client")],
});

const router = createRouter()
  .with(setup.route)
  .use(setup.createRscRoutes({ "/": import("@/app/pages/index.tsx") }));

Deno.args.some((v) => v === "build")
  ? Deno.exit(0)
  : Deno.serve((request) => router.fetch(request));
```

Run the script with HMR enabled:

```bash
# dev
deno run --allow-read --allow-write --allow-net --unstable-hmr main.ts 
# build
deno run --allow-read --allow-write --allow-net --unstable-hmr main.ts build
```

## License

This project is licensed under the Commons Clause License. See the [LICENSE](LICENSE)
file for more information.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on
GitHub.
