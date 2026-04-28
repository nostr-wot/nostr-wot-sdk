# @nostr-wot/ui

Headless React UI for Nostr — login modal/widget, session provider, themable via CSS variables.

| Component | What it does |
|---|---|
| `<NostrSessionProvider>` | Holds the active signer + pubkey; sets the `data-nui-root` styling scope |
| `<LoginButton>` | Pill button that opens the login modal; renders nothing once signed in |
| `<LoginModal>` | Portal-based modal wrapping the login widget |
| `<LoginWidget>` | Inline form: NIP-07 / NIP-46 / generate / import |

Backed by `@nostr-wot/signers` for the four login methods. Reads/writes the same session context that `@nostr-wot/dm`, `@nostr-wot/blossom`, and `@nostr-wot/wallet` consume — so once the user signs in here, every other hook in the SDK has the signer.

## Install

```bash
npm i @nostr-wot/ui @nostr-wot/data @nostr-wot/signers nostr-tools react react-dom
```

```ts
// Optional: import the default stylesheet once at app boot.
// Skip this import to ship fully unstyled (useful with shadcn/Tailwind).
import "@nostr-wot/ui/styles.css";
```

## Quick start

```tsx
import { NostrSessionProvider, LoginButton, useSession } from "@nostr-wot/ui";
import { NostrDataProvider } from "@nostr-wot/data/react";
import "@nostr-wot/ui/styles.css";

export default function App() {
  return (
    <NostrSessionProvider>
      <NostrDataProvider relays={["wss://relay.damus.io", "wss://nos.lol"]}>
        <Header />
        <Page />
      </NostrDataProvider>
    </NostrSessionProvider>
  );
}

function Header() {
  return (
    <LoginButton
      renderLoggedIn={({ pubkey, logout }) => (
        <button onClick={logout}>{pubkey.slice(0, 12)}…</button>
      )}
    />
  );
}

function Page() {
  const { pubkey } = useSession();
  return pubkey ? <p>Welcome {pubkey}</p> : <p>Please sign in</p>;
}
```

If you're using the meta package, `<NostrSdkProvider>` already mounts the session provider for you:

```tsx
import { NostrSdkProvider } from "nostr-wot-sdk/react";
import { LoginButton } from "@nostr-wot/ui";
import "@nostr-wot/ui/styles.css";

<NostrSdkProvider relays={["wss://relay.damus.io"]}>
  <LoginButton />
</NostrSdkProvider>;
```

## Components

### `<NostrSessionProvider>`

Wraps your tree, holds session state, and (by default) silently re-attaches the previous signer on mount.

```tsx
<NostrSessionProvider
  theme="system"            // "light" | "dark" | "system"
  autoRestore               // attempt silent NIP-46 + remembered-nsec restore
  initialSigner={someSigner}  // already-constructed signer
  onChange={({ signer, pubkey }) => /* mirror to your state */}
  onLogout={async () => { /* clear app caches */ }}
>
  <App />
</NostrSessionProvider>
```

Sets `data-nui-root` on its wrapper element so the default stylesheet can scope its CSS variables.

### `<LoginButton>`

```tsx
<LoginButton
  signInLabel="Sign in"
  renderLoggedIn={({ pubkey, logout }) => (
    <ProfileMenu pubkey={pubkey} onLogout={logout} />
  )}
  modalProps={{
    title: "Welcome to MyApp",
    subtitle: "Pick how you'd like to sign in",
    methods: ["nip07", "nip46", "generate"],   // hide "import"
    hideAdvanced: true,
  }}
/>
```

### `<LoginModal>`

Use directly when you control the open state from elsewhere:

```tsx
const [open, setOpen] = useState(false);
<LoginModal
  open={open}
  onClose={() => setOpen(false)}
  onSuccess={() => /* logged in */}
/>;
```

### `<LoginWidget>`

The inline form, for embedding in a page (no modal chrome):

```tsx
<LoginWidget
  title="Sign in"
  subtitle="Choose a method"
  methods={["nip07", "nip46", "generate", "import"]}
  hideAdvanced={false}
  onSuccess={() => router.push("/")}
  // NIP-46 — render a nostrconnect:// QR by default; users can switch
  // to "Paste URI" for the bunker:// flow.
  nip46Mode="qr"
  nip46Relays={["wss://relay.nsec.app", "wss://relay.damus.io"]}
  nip46Metadata={{ name: "MyApp", url: "https://myapp.com" }}
  nip46Perms="sign_event:1,nip44_encrypt,nip44_decrypt"
  // Generate flow — show a profile-setup step + publish kind-0
  profileSetup
  profileRelays={["wss://relay.damus.io", "wss://nos.lol"]}
/>
```

#### NIP-46 modes

The `nip46` method has two pairing flows, switchable via tabs in the UI:

- **Scan QR** (`nostrconnect://`) — the SDK generates an ephemeral client key + QR; the user opens their signer app (Amber, Nsec.app, Keychat) and scans it. Default tab. Best UX for desktop ↔ phone.
- **Paste URI** (`bunker://`) — the user copies a `bunker://` URI from their signer app and pastes it. Best when the signer is on the same device.

Auth-URL prompts (`"Approve in your signer app"`) appear automatically as a green banner above the QR/form when the bunker requests user approval mid-flow. The banner links straight to the URL the bunker provided.

#### Profile setup

Pass `profileSetup` to extend the "Generate" flow with a second step asking for `name`, `about`, and `picture`. After the user fills (or skips), the SDK publishes a kind-0 event to `profileRelays` so the new account shows up across Nostr clients.

## Hooks

Re-exports from `@nostr-wot/data/react` so you can import everything from `@nostr-wot/ui`:

| Hook | Returns |
|---|---|
| `useSession()` | `{ signer, pubkey, isLoading, error, setSigner, logout }` |
| `useSigner()` | The active `NostrSigner` or `null` |
| `usePubkey()` | The active hex pubkey or `null` |
| `useLogin()` | `(signer) => Promise<void>` callback |
| `useLogout()` | `() => Promise<void>` callback |

## Login methods

| Method | What it does | Persistence |
|---|---|---|
| `nip07` | Connects to `window.nostr` (Alby, nos2x, …) | Extension handles its own permissions |
| `nip46` | Pastes a `bunker://` URI; pairs with the remote signer | Saves bunker URI + ephemeral client nsec to localStorage so subsequent loads silently reconnect |
| `generate` | Generates a fresh keypair on-device; shows nsec/npub for backup, optional download | "Remember on device" writes nsec to localStorage; off by default |
| `import` | Pastes nsec or 64-char hex private key | Same as `generate` |

`generate` and `import` are collapsed under "Advanced" by default — pass `hideAdvanced` to hide them entirely.

The persistence helpers are exported for advanced flows:

```ts
import {
  clearPersistedNip46,
  clearPersistedNsec,
  readPersistedNip46,
  tryRestoreNip46,
  tryRestoreGeneratedOrImported,
} from "@nostr-wot/ui";
```

## Theming

Option A: CSS variables. The provider sets `data-nui-root` on its wrapper, so all theming attributes scope cleanly.

```css
[data-nui-root] {
  --nui-bg: #fafafa;
  --nui-fg: #18181b;
  --nui-muted: #71717a;
  --nui-border: #e4e4e7;
  --nui-input-bg: #ffffff;

  --nui-primary: #6366f1;
  --nui-primary-fg: #ffffff;
  --nui-primary-hover: #4f46e5;

  --nui-radius: 10px;
  --nui-shadow: 0 8px 24px rgba(0,0,0,0.12);
  --nui-space: 12px;
  --nui-font: "Inter", system-ui, sans-serif;

  --nui-overlay-bg: rgba(15, 23, 42, 0.6);
  --nui-z-modal: 9999;
}
```

Force a theme:

```tsx
<NostrSessionProvider theme="dark">{...}</NostrSessionProvider>
```

Per-element overrides via the `classes` slot prop on every component:

```tsx
<LoginWidget
  classes={{
    root: "my-card",
    title: "text-xl font-bold",
    method: "rounded-2xl shadow-md",
    input: "border-2 border-blue-500",
  }}
  styles={{
    root: { padding: 24 },
  }}
/>
```

Available slots:

```ts
type LoginWidgetSlot =
  | "root" | "title" | "subtitle"
  | "methods" | "method" | "methodIcon" | "methodText" | "methodLabel" | "methodHint"
  | "divider" | "input" | "inputRow"
  | "primaryButton" | "back" | "error" | "warning" | "keyDisplay";

type ModalSlot = "overlay" | "modal" | "close";
type LoginButtonSlot = "button" | "spinner";
```

`<LoginModal>` accepts both `classes` (forwarded to the widget) and `modalClasses` (the modal chrome itself).

## Skip the default stylesheet

Don't import `@nostr-wot/ui/styles.css`. Components still render — they just have no default styles. Provide your own CSS targeting the `.nui-*` classes, or use the `classes` slots to swap in your design-system classes (Tailwind, shadcn, etc.).

## Cross-package wiring

The session this provider holds is the single source of truth for every `@nostr-wot/*` package that needs a signer:

```tsx
import { useDMSession } from "@nostr-wot/dm/react";

function Inbox() {
  // No `signer` prop — falls back to the session context.
  const { session, sendDM } = useDMSession({ relays: ["wss://..."] });
  // ...
}
```

Same for blossom uploads, zap requests, etc. — they read the active signer from context unless you explicitly pass one.

## License

MIT
