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

https://github.com/nestarz/bureaudouble-rsc-demo/

## Installation

Ensure you have Deno installed. You can install it from
[deno.land](https://deno.land/#installation).

Add the package to your project:

```bash
deno add @bureaudouble/rsc-engine
```

## Usage

### Setup

To use the RSC Engine, you need to set up a manifest file that specifies your
project configuration. Below is an example of a manifest file:

```ts
const manifest = {
  minify: false,
  namespace: "default",
  entryPoint: import.meta.url,
  moduleBaseURL: import.meta.resolve("./"),
  importMap: import.meta.resolve("./deno.json"),
  bootstrapModules: [import.meta.resolve("./src/client.tsx")], // You must provides a client.tsx
  external: [],
};
```

### Creating a Hello World Component

Create a `index.tsx` file in your `src` directory:

```tsx
// src/index.tsx
import React from "react";

export default function HelloWorld() {
  return (
    <html>
      <body>
        <h1>Hello, World!</h1>
        <ClientComponent />
      </body>
    </html>
  );
}

// src/client-component.tsx
"use client";
import React from "react";

export default function ClientComponent() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount((s) => s + 1)}>{count}</button>;
}
```

### Build and serve

To build your project, run the setup function and ensure all components are
bundled correctly:

```typescript
// main.ts
import { setupClientComponents } from "@bureaudouble/rsc-engine";

const setup = await setupClientComponents(manifest);

Deno.serve(setup.render(() => import("@/src/index.tsx")));
```

Run the build script:

```bash
deno run --allow-read --allow-write --allow-net main.ts
```

## License

This project is licensed under the CC0-1.0 License. See the [LICENSE](LICENSE)
file for more information.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on
GitHub.
