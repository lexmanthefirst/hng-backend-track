1. **Clone and Setup**

```bash
git clone https://github.com/lexmanthefirst/hng-backend-track.git
cd hng-backend
```

2. **Install Depenedencies**

```bash
pnpm install
pnpm run dev
```

3. **Deploy to Cloudflare**

```bash
pnpm run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

4. **Generate types base on worker configuration**

```bash
pnpm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>();
```
