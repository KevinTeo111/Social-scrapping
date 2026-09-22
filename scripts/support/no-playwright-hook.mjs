// Records any attempt to resolve Playwright in this process (scripts/test-split.mjs).
import { registerHooks } from 'node:module';
import fs from 'node:fs';
registerHooks({
  resolve(spec, ctx, next) {
    if (/playwright/.test(spec)) fs.appendFileSync(process.env.PW_LOG, spec + '\n');
    return next(spec, ctx);
  },
});
