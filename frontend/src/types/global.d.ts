export {};

// ─── Window / browser globals ────────────────────────────────────────────────

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: any[] }) => Promise<any>;
      on(event: string, handler: (...args: any[]) => void): void;
      removeListener(event: string, handler: (...args: any[]) => void): void;
      selectedAddress?: string;
    };
    solana?: {
      isPhantom?: boolean;
      publicKey: { toString(): string } | null;
      isConnected: boolean;
      connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
      disconnect(): Promise<void>;
      signTransaction(tx: unknown): Promise<unknown>;
      signAllTransactions(txs: unknown[]): Promise<unknown[]>;
      on(event: string, handler: (...args: any[]) => void): void;
      removeListener(event: string, handler: (...args: any[]) => void): void;
    };
    phantom?: { solana?: Window['solana'] };
  }

  // ─── Vite env ──────────────────────────────────────────────────────────────
  interface ImportMetaEnv {
    readonly VITE_NETWORK: string;
    readonly VITE_API_BASE_URL: string;
    readonly VITE_ETHEREUM_CHAIN_ID: string;
    readonly VITE_STELLAR_NETWORK: string;
    readonly VITE_ETHEREUM_RPC_URL: string;
    readonly VITE_STELLAR_HORIZON_URL: string;
    readonly VITE_NETWORK_MODE: string;
    readonly VITE_MAINNET_ENABLED: string;
    readonly VITE_ENABLE_TESTNET_FAUCETS: string;
    readonly VITE_ENABLE_DEBUG_MODE: string;
    readonly VITE_ENABLE_MOCK_DATA: string;
    readonly VITE_INFURA_API_KEY: string;
    readonly VITE_ONEINCH_API_KEY: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
