# Tree-Shaking & Bundle Optimization

This SDK is optimized for modern bundlers (Vite, Webpack 5+, Rollup, esbuild) to ensure only used code is included in your application bundle.

## Configuration

- **`sideEffects: false`** — Marks the package as free of side effects, enabling aggressive tree-shaking.
- **`"type": "module"`** — ESM-native module format.
- **Named exports** — All exports are explicitly named to maximize bundler analysis.
- **Subpath exports** — Use specific entry points to avoid importing unnecessary modules.

## Usage

### Import only what you need

```typescript
// ✅ Good: Imports only the secret utilities
import { generateSecret, hashSecret } from "@wafflefinance/sdk/secrets";

// ✅ Good: Imports only Ethereum-specific code
import { EthereumHTLCClient } from "@wafflefinance/sdk/ethereum";

// ✅ Good: Imports only type definitions (zero runtime cost)
import type { Order, Direction } from "@wafflefinance/sdk/types";

// ⚠️ Avoid: Imports everything (larger bundle)
import * as SDK from "@wafflefinance/sdk";
```

### Recommended imports by use case

**Ethereum only:**
```typescript
import { EthereumHTLCClient } from "@wafflefinance/sdk/ethereum";
import { generateSecret } from "@wafflefinance/sdk/secrets";
import type { Order } from "@wafflefinance/sdk/types";
```

**Solana only:**
```typescript
import { SolanaHTLCClient } from "@wafflefinance/sdk/solana";
import { generateSecret } from "@wafflefinance/sdk/secrets";
```

**Cross-chain (all chains):**
```typescript
import { EthereumHTLCClient } from "@wafflefinance/sdk/ethereum";
import { SorobanHTLCClient } from "@wafflefinance/sdk/soroban";
import { SolanaHTLCClient } from "@wafflefinance/sdk/solana";
import { generateSecret } from "@wafflefinance/sdk/secrets";
```

## Verification

Run the bundle analysis to confirm tree-shaking is working:

```bash
npm run build:analyze
```

This verifies:
- All export entry points are accessible
- No circular dependencies
- `sideEffects: false` is set correctly
- ESM format is correct

## Available Entry Points

| Entry Point | Contents |
|---|---|
| `.` (default) | All exports (use when you need multiple chains) |
| `./types` | Type definitions and interfaces |
| `./secrets` | Secret generation and verification utilities |
| `./ethereum` | Ethereum HTLC client and ABI |
| `./soroban` | Soroban HTLC client and signers |
| `./solana` | Solana HTLC client and signers |
| `./state-machine` | Order state machine transitions |
| `./assets` | Asset mapping and resolution functions |

## For Bundler Users

Modern bundlers will automatically:
1. Follow subpath exports to their specific entry points
2. Omit unused modules when `sideEffects: false` is set
3. Tree-shake unused named exports
4. Merge declarations correctly with `"declaration": true`

If your bundle still feels large, check that:
- You're using specific subpath imports, not the default `.`
- Your bundler supports `sideEffects: false` (all modern bundlers do)
- You're not re-exporting unused modules in your own code
