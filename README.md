# Matrix Link Language for AD4M

AD4M link language that syncs Perspective triples to Matrix rooms via the Client-Server API.

## What It Does

- **Commits:** links → custom `dev.ad4m.link.triple` events in a Matrix room
- **Sync:** polls room timeline for new events → local links
- **Query:** indexed local store (source, target, predicate)
- **Dual rendering:** each link becomes both a typed custom event and a human-readable `m.room.message`, so Matrix clients display meaningful content alongside structured data
- **Telepresence:** real-time presence via Matrix Presence API, peer-to-peer signalling via to-device messages, broadcast via room events

## Template Variables

| Variable | Description |
|----------|-------------|
| `MATRIX_HOMESERVER_URL` | Matrix homeserver base URL |
| `MATRIX_ROOM_ID` | Target room ID (`!xxx:server`) |
| `MATRIX_USER_ID` | Bot/user MXID (`@user:server`) |
| `MATRIX_ACCESS_TOKEN` | CS API access token |
| `MATRIX_ROOM_ALIAS` | Optional room alias |
| `NEIGHBOURHOOD_META` | AD4M neighbourhood metadata |

## Building

```bash
pnpm install
deno run --allow-all esbuild.ts
```

Requires `@coasys/ad4m-ldk` at `../ad4m/ad4m-ldk/js/` or set `AD4M_LDK_ENTRY`.

## Testing

```bash
node --experimental-vm-modules --import tsx --test tests/*.test.ts
```

297 tests across 11 suites.

## Architecture

Same [pure/impure pattern](https://github.com/HexaField/ad4m-link-language-template) as all AD4M link languages. Protocol-specific modules:

- `src/matrix-api.ts` / `matrix-api.pure.ts` — HTTP Client-Server API calls
- `src/rendering.ts` / `rendering.pure.ts` — dual-render: custom event + `m.room.message`
- `src/membership.ts` — room-based membership management
- `src/translate.ts` / `translate.pure.ts` — link ↔ Matrix event translation
- `src/dual-language.ts` — dual-language support
- `src/sdna.ts` — social DNA definitions
- `src/settings.ts` — language settings
- `src/sync.ts` — sync orchestration

`ad4m:host` imports confined to 4 adapter files + `index.ts`.

## License

CAL-1.0
