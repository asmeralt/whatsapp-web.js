# Fork notes

This is a fork of [wwebjs/whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js), maintained at
[asmeralt/whatsapp-web.js](https://github.com/asmeralt/whatsapp-web.js) for
[wapp-bot](../README.md). It keeps the library working against WhatsApp Web builds that broke the upstream
release, mostly around **serialized ids**, **LID-migrated accounts** and **sending media**.

|                    |                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------- |
| Upstream base      | `v1.34.7`, plus upstream `main` up to `942d236` (2026-07-27), merged in `9392d20`   |
| Fork-only commits  | `c27cd09`, `4d466e4`, `a795045`, `0e92d85`, `5c23598`, `3622673`, `00a5e02`         |
| Files touched      | `src/util/Injected/Utils.js`, `src/Client.js`, `src/structures/{Contact,GroupChat,Message,Reaction}.js`, `CLAUDE.md` |
| `package.json` version | unchanged (`1.34.7`)                                                            |

To list the fork's changes at any time:

```sh
git log --oneline --no-merges 942d236..HEAD
git diff 942d236 HEAD -- src
```

## How wapp-bot consumes it

- **Local development:** wapp-bot's `package.json` has `"whatsapp-web.js": "file:./whatsapp-web.js"`, so
  this checkout (gitignored in wapp-bot, not a git submodule) is what `yarn install` links.
- **Docker / production:** the `Dockerfile` clones `https://github.com/asmeralt/whatsapp-web.js.git` and
  checks out the commit in `ARG WWEBJS_COMMIT` (currently `00a5e02`, the tip of `main`). Pushing here
  changes nothing in production until that pin is bumped, and the pinned commit must be pushed.
- `wapp-bot/npm_rewrites/` holds older patch-over-`node_modules` copies of `Utils.js` and `Channel.js` from
  before this fork existed. The Dockerfile has them commented out, and they are superseded by this fork.

## Changes

### 1. Serialized ids: `_serialized` → `$1` (`c27cd09`)

**Problem.** A 2026 WhatsApp Web build renamed the serialized-id string on wid and message-key objects from
`_serialized` to the minified `$1`. Upstream reads `._serialized` throughout the injected code, so ids came
back `undefined`. Message, chat and contact lookups then failed, events carried no ids, and anything keyed
on an id broke.

**Fix.** Two injected helpers, used everywhere the browser side used to read `._serialized`:

- `window.WWebJS.getSerializedId(widLike)` returns `_serialized ?? $1`, and passes strings and nullish
  values through.
- `window.WWebJS.normalizeSerializedIds(obj)` deep-walks a `.serialize()`d model, with cycle protection,
  and copies `$1` into `_serialized` wherever only `$1` exists.

Every payload that crosses back to Node is normalized: `getMessageModel`, `getChatModel`,
`getContactModel`, `getStatusModel`, `ClientInfo` (`Conn` / me-user), common groups, `createGroup`'s
`gid`, payments, reactions, edits and event edits. `Reaction._patch` also normalizes `msgKey` /
`parentMsgKey` on the Node side. With that in place, the Node-side structures keep reading
`data.id._serialized` unchanged, and the public API is unaffected.

Rule for new code: on the browser side, never read `._serialized` from a live store object. Use
`getSerializedId`, and run anything returned from `pupPage.evaluate()` through `normalizeSerializedIds`.

### 2. Resilience to LID and IndexedDB lookup errors (`c27cd09`)

On LID-migrated accounts, many internal lookups throw (an IndexedDB `DataError` for LID-addressed chats,
contacts and messages that are not known locally, and `getAlternateUserWid` for device wids). Upstream let
one bad record fail an entire call. The fork contains these failures:

| Function                                  | Change                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `WWebJS.getChats` / `getChannels`         | Builds models one at a time and **skips** a chat that throws, instead of failing the whole `Promise.all` |
| `WWebJS.getContacts`                      | Same: skips contacts that fail to serialize                                     |
| `WWebJS.getChat`                          | Returns `null` for an empty id or a lookup that throws                          |
| `WWebJS.getChatModel`                     | Tolerates `groupMetadata.update()` throwing and uses the cached metadata        |
| `WWebJS.getContact`                       | Returns `null` for an empty id. Falls back to the in-memory `Contact.get()`. Business-profile lookup is best-effort |
| `WWebJS.getContactModel`                  | Blocked-status lookup is best-effort and skipped for device wids                |
| `Contact.block()` / `unblock()`           | Fall back to the contact's own wid when no LID can be resolved                  |
| `Client.getState()` / `logout()`          | Return `null` (or nothing) while `window.require` is unavailable or throws during SPA re-render |
| `Client.getContactById()`                 | Returns `undefined` instead of throwing when the contact cannot be found        |

`getChats()` and `getContacts()` can therefore return **fewer** items than WhatsApp shows, and never throw
because of a single bad record. wapp-bot's two-minute group sync relies on this.

### 3. Media download fallback (`c27cd09`)

`WWebJS.resolveMediaBlob` (behind `Message.downloadMedia()`):

- tolerates `getMessagesById` throwing for LID message keys
- tolerates WhatsApp's internal `msg.downloadMedia()` throwing on the blob-cache path
- when no blob is available, downloads and decrypts straight from the CDN with
  `WAWebDownloadManager.downloadAndMaybeDecrypt` (`directPath` + `mediaKey`)

wapp-bot uses this for `Event.downloadMedia` (inbound media → Google Drive).

### 4. Other id-related fixes (`c27cd09`)

- `Client.acceptInvite()` builds the group id string inside the page and returns it.
- Poll votes: `parentMessage` is passed through `getMessageModel` instead of as a raw store model, which
  does not serialize across Puppeteer.
- `change:unreadCount` passes `{ id }` instead of the live chat model. Node already looks the chat up by id.
- Incoming call `peerJid` is a string.
- `addParticipants`, membership requests, `getBlockedContacts`, labels, `getContactLidAndPhone`,
  `rejectCall`, the `sendMessage` key lookup and `editMessage` all use `getSerializedId`.

### 5. Labelled steps and readable send errors (`a795045`, `5c23598`)

**Problem.** A failure inside one `pupPage.evaluate` reached Node as one of WhatsApp's minified, generic
errors (most often `Data passed to getter must include an id property`), with no clue which internal call
raised it. Anything added to the error inside the page was also lost: Puppeteer rebuilds a page exception
from the stack V8 captured when the error was **constructed**.

**Fix.**

- `window.WWebJS.step(label, fn)` runs one internal call and, on failure, throws a **new** `Error`. Its
  message is `[WWebJS:<label>] <original>`, it has a `wwebjsStep` property, and its stack ends with
  `Caused by: <original stack>`.
- `Client.sendMessage()` wraps `getChat`, `sendSeen`, `sendMessage` and `getMessageModel` in steps. It
  catches errors **inside the page** and returns them as data (`{ __wwebjsError: { step, message, stack } }`).
  The Node side rethrows that as:

  ```
  Error: sendMessage failed at step "<step>": [WWebJS:<inner step>] <message>
    error.wwebjsStep   // label of the outermost step that failed
    error.browserStack // full in-page stack, including "Caused by:" chains
  ```

  Each step wraps the error again from the outside in, so `wwebjsStep` is almost always `'sendMessage'`. The
  **innermost** label (for example `prepRawMedia`) is only found in the message text. wapp-bot's
  `isMediaPrepFailure()` therefore matches on the message, not on `wwebjsStep`.

- Steps inside `WWebJS.sendMessage` / `processMediaData`: `addAndSendMsgToChat`, `awaitAddedMsg`,
  `awaitSendMsgResult`, `getSentMsg`, `createOpaqueData`, `prepRawMedia`, `computeFilehash`,
  `getOrCreateMediaObject`, `msgToMediaType`, `consolidateMediaObject` and `uploadMedia`.

### 6. Sending media: three causes of "Data passed to getter must include an id property"

Sending a video failed on current WhatsApp builds with that one error. It had three separate causes, fixed
one after the other:

1. **Missing `filehash` after media prep** (`0e92d85`). The prep step stopped returning `filehash`, the
   key the media-storage getter memoizes on. The fork now computes it itself: base64 SHA-256 of the
   plaintext, using `WWebJS.getFileHash` on the prepped blob or on the source file. It logs a
   `console.warn` in the page when it does. A prep that returns nothing throws `media-fault: sendToChat
   prepped no media`.
2. **Undefined sender on LID-migrated accounts** (`3622673`). `getMaybeMePnUser()` returns `undefined` for
   accounts that only have a LID identity, and the reverse can also happen. `from` now falls back to
   whichever identity exists, for both 1:1 chats and groups (LID-addressing mode or not). If neither
   exists, it throws `send-fault: neither a LID nor a phone-number identity is available for this account`.
3. **Media model clobbering the message key** (`00a5e02`). Upstream spread the prepped `WAWebMediaData`
   model into the new message's data. WhatsApp models store attributes in `__x_<prop>` slots, so the
   spread copied `__x_id`, which overwrote the message key, and the message had no id. The new
   `window.WWebJS.getMediaPayload()` builds a plain payload (`toJSON()` plus directly assigned fields such
   as the caption, with no `__x_*` keys and no `id`). As an extra safeguard, `sendMessage` deletes any
   `__x_*` key from the final message object.

A fourth trigger is fixed in **wapp-bot**, not here: link previews on media messages. wapp-bot sends videos
with `linkPreview: false` (`src/bot/handlers/sending/attachments/message_with_url.js`). Other consumers of
this fork sending media with a caption should do the same.

### 7. `CLAUDE.md` (`4d466e4`)

Agent and contributor notes for this repository: commands, the Node/browser split and the `$1` rule.

## Behaviour that differs from upstream

Most of the fork is invisible to callers. These differences are visible:

- `client.sendMessage()` throws `sendMessage failed at step …` errors carrying `wwebjsStep` /
  `browserStack`, instead of the raw page error.
- `getChats()`, `getChannels()` and `getContacts()` skip records that cannot be read instead of rejecting.
- `getContactById()` can return `undefined`.
- `getState()` returns `null` instead of throwing while the page re-renders.
- The page console may show `[WWebJS] prepped media carried no filehash, computed one …`.

## Maintaining the fork

**Syncing with upstream:**

```sh
git remote add upstream https://github.com/wwebjs/whatsapp-web.js.git   # once
git fetch upstream
git merge upstream/main     # or open a PR from wwebjs/main on GitHub, as was done for 9392d20
```

Expect conflicts in `src/util/Injected/Utils.js` (`sendMessage`, `processMediaData`, `getChatModel`,
`getContact*`) and in `src/Client.js` (`sendMessage`, `attachEventListeners`). After merging:

- `grep -n "\._serialized" src/util/Injected/Utils.js src/Client.js` and route any new browser-side reads
  through `getSerializedId`. Node-side reads on normalized data are fine.
- Check that new `*.serialize()` returns are wrapped in `normalizeSerializedIds`.
- Check that upstream has not reintroduced `...mediaOptions` spreads into the message object.
- When upstream fixes the same problem, prefer its version and drop ours. Note the removal here.

**Testing.** The mocha suite in `tests/` needs a live session and a second phone number (see
`tests/README.md`). In practice, verify through wapp-bot: send plain text, a Drive video and a base64 image
to a 1:1 chat and to a group, then check that `message_create` / `message_reaction` webhooks carry ids.

**Shipping.** Commit (commitlint is configured for Conventional Commits, though husky only enforces it after
`npm install` has run its `prepare` hook), push to `main` on
`asmeralt/whatsapp-web.js`, set `WWEBJS_COMMIT` in wapp-bot's `Dockerfile` to the new SHA, and update
the pinned commit noted above. Then rebuild the wapp-bot image. A one-off build can override the pin with
`--build-arg WWEBJS_COMMIT=<sha>`.

**When adding a fix,** add an entry under [Changes](#changes) with the commit hash, the symptom as it
appears in logs, and the cause.
