// github-core-clone: a standalone GitHub-compatible git forge.
//
// A trial runs one entry process per shop. This entry is that process: it
// starts the forge, registers its port with the env, then serves until the
// env says the trial is done.

import { startForge } from './app.ts';

const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';
void SHOP_TOKEN;

const envUrl = process.env.MAKEFUN_ENV_URL;
if (!envUrl) {
  console.error('MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

const forge = await startForge(SHOP_TOKEN);
console.log(`forge listening on 127.0.0.1:${forge.port}`);

await fetch(`${envUrl}/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ port: forge.port }),
});

for (;;) {
  try {
    const res = await fetch(`${envUrl}/done`);
    if (res.ok) {
      const body = (await res.json()) as { done?: boolean };
      if (body.done) break;
    }
  } catch {
    // the env is not answering yet; keep serving and poll again
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

await forge.close();
process.exit(0);
