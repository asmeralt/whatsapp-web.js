# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

whatsapp-web.js is a Node.js library that drives a real WhatsApp Web session in a Puppeteer-managed browser and calls WhatsApp Web's internal (unversioned, Meta-controlled) webpack modules to expose a bot/client API. Because it depends on WhatsApp Web internals, breakage is usually caused by Meta changing those internals, not by bugs in this repo.

## Commands

- `npm run lint` / `npm run lint:fix` — ESLint (flat config in `eslint.config.mjs`)
- `npm run format` / `npm run format:check` — Prettier
- `npm run check` — lint + format check (run this before committing)
- `npm test` — mocha over `tests/` (recursive, 5s timeout). Tests require a real authenticated WhatsApp session plus a second phone number; configure `WWEBJS_TEST_CLIENT_ID` and `WWEBJS_TEST_REMOTE_ID` via `.env` (see `tests/README.md`). Without these, most tests cannot run.
- Single test file: `npx mocha tests/structures/message.js --timeout 5000` (or `npm run test-single -- <file>`)
- `npm run shell` — REPL with an initialized `client` for manual experimentation against a live session
- Commits follow Conventional Commits (commitlint + husky enforce this)

## Architecture: two JavaScript worlds

The core thing to understand is that code runs in two separate contexts:

1. **Node side** — `src/Client.js` (the huge entry class, an EventEmitter), `src/structures/*` (user-facing model classes), `src/authStrategies/*`, `src/webCache/*`.
2. **Browser side (injected)** — `src/util/Injected/Utils.js` exports `LoadUtils`, which `Client.inject()` evaluates inside the WhatsApp Web page to build `window.WWebJS`, a bag of helper/serializer functions.

They communicate only through Puppeteer:
- Node → browser: `this.pupPage.evaluate(fn, ...args)`. The callback is serialized and executed in the page, so it **cannot close over Node-side variables** — everything must be passed as (JSON-serializable) arguments, and return values must be serializable too. Inside these callbacks, `window.require('WAWeb...')` accesses WhatsApp's internal webpack modules and `window.WWebJS.*` accesses the injected helpers.
- Browser → Node: `exposeFunctionIfAbsent` (`src/util/Puppeteer.js`) registers `window.on...Event` callbacks; `Client.attachEventListeners()` wires WhatsApp's internal event emitters to these, which then `this.emit(...)` public events (names in `src/util/Constants.js`).

`Client.inject()` re-runs on every page load/navigation (WhatsApp Web is a SPA that can re-render), so injection code must be idempotent.

### Serialized IDs: `_serialized` vs `$1` (critical)

A 2026 WhatsApp Web update renamed the serialized ID field on wid/message-key objects from `_serialized` to `$1` (minified name; may change again). The library's public API and Node-side code still use `_serialized` everywhere. Two injected helpers bridge this — **always use them in browser-side code instead of touching `._serialized` directly on live store objects**:

- `window.WWebJS.getSerializedId(widLike)` — returns the serialized string from a wid/msg-key regardless of shape (also accepts plain strings).
- `window.WWebJS.normalizeSerializedIds(obj)` — deep-walks a `.serialize()`d model and restores `_serialized` next to `$1`; call it on any serialized payload before returning it from `pupPage.evaluate()`.

Node-side code (structures) may keep reading `data.id._serialized` as long as the browser side normalized the payload first.

### Structures and factories

`src/structures/` classes (`Message`, `Chat`, `Contact`, `GroupChat`, …) wrap serialized data from the browser side; they hold a `client` reference and implement actions by calling back into `pupPage.evaluate`. `src/factories/ChatFactory.js` and `ContactFactory.js` choose the concrete subclass (group/private/channel/business) from flags on the serialized model. Public API surface must be mirrored in `index.d.ts` and re-exported through `index.js`/`src/structures/index.js`.

### Auth and web version cache

`src/authStrategies/` (`LocalAuth`, `RemoteAuth`, `NoAuth`) manage Puppeteer user-data/session persistence. `src/webCache/` can pin/serve a cached WhatsApp Web HTML version (`webVersionCache` option) — relevant when Meta ships breaking frontend changes, since pinning an older version is a common mitigation.

## Docs

JSDoc comments are the source of the published docs (`npm run generate-docs`); keep them accurate when changing public methods. The `docs/` directory is generated output — don't hand-edit it.
