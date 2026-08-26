import { SorobanConfig } from './client.js'
import { TxType } from '../outbox/types.js'
import { RawReceiptEvent } from '../indexer/event-parser.js'

export interface RecordReceiptParams {
  txId: string           // BytesN<32> as hex string - deterministic idempotency key (SHA-256 of canonical external ref)
  txType: TxType
  amountUsdc: string     // USDC amount (canonical); decimal string
  tokenAddress: string   // USDC token contract address
  dealId: string
  listingId?: string
  from?: string
  to?: string
  amountNgn?: number
  fxRate?: number
  fxProvider?: string
  metadataHash?: string
}

export type DealSyncStatus = 'active' | 'completed' | 'defaulted'

export interface SyncDealStatusParams {
  dealId: string
  contractDealId: string
  newStatus: DealSyncStatus
  actor: string
}

/**
 * Money contract types that hold user funds on-chain.
 * These are the contracts that need to be reconciled against the off-chain ledger.
 */
export type MoneyContractType =
  | 'deal_escrow'      // Holds rent deposits
  | 'staking_pool'     // Holds stakes
  | 'rent_wallet'      // Holds tenant balances
  | 'bond_collateral'  // Holds posted bonds

/**
 * On-chain position read result for a money contract.
 * Represents the contract's view of what it owes or holds for an account/aggregation.
 */
export interface OnChainPosition {
  contractType: MoneyContractType
  contractId: string
  account?: string  // Optional: for per-account reads; undefined for aggregate obligation reads
  balanceMinor: bigint  // The on-chain balance in minor units
  currency: string  // Typically 'USDC' for on-chain contracts
  timestamp: bigint  // Ledger timestamp when this position was read
}

/**
 * Callback fired after a Stellar transaction is signed and hashed but *before*
 * it is broadcast to the network. Persisting the hash at this point allows a
 * worker that crashes between broadcast and result-recording to recover by
 * querying the chain for the known hash rather than blindly resubmitting.
 */
export interface TxBroadcastHooks {
  /** Called with the signed tx hash just before sendTransaction. */
  onTxBuilt?: (txHash: string) => Promise<void>
}

/** On-chain status of a previously submitted Stellar transaction. */
export interface TxOnChainStatus {
  status: 'success' | 'failed' | 'not_found' | 'pending'
  /** Ledger sequence in which the tx was applied (only set for 'success'). */
  ledger?: number
}

/**
 * On-chain representation of a tenant's aggregated reputation.
 * Scores are on a 0–1000 scale (off-chain 1–5 avg × 200).
 */
export interface TenantReputationRecord {
  compositeScore: number
  paymentScore: number
  propertyCareScore: number
  communicationScore: number
  totalRatings: number
  lastUpdated: bigint
}

export interface SorobanAdapter {
  getBalance(account: string): Promise<bigint>
  credit(account: string, amount: bigint): Promise<void>
  debit(account: string, amount: bigint): Promise<void>
  getStakedBalance(account: string): Promise<bigint>
  getClaimableRewards(account: string): Promise<bigint>
  recordReceipt(params: RecordReceiptParams, hooks?: TxBroadcastHooks): Promise<void>
  getConfig(): SorobanConfig
  getReceiptEvents(fromLedger: number | null): Promise<RawReceiptEvent[]>
  getTimelockEvents(fromLedger: number | null): Promise<any[]>
  executeTimelock(txHash: string, target: string, functionName: string, args: any[], eta: number): Promise<string>
  cancelTimelock(txHash: string): Promise<string>

  // Inspector bond operations (inspector_bond contract)
  stakeBond(inspectorId: string, amount: bigint): Promise<void>
  unstakeBond(inspectorId: string): Promise<void>
  isBonded(inspectorId: string): Promise<boolean>
  getBond(inspectorId: string): Promise<{ isBonded: boolean; amount: bigint }>

  /**
   * Query the current on-chain status of a previously submitted transaction.
   * Used for crash recovery: if a worker persisted a txHash but crashed before
   * recording the result, the next worker queries this instead of resubmitting.
   *
   * Optional: adapters that do not support status queries (e.g. simple stubs)
   * may omit this method; the sender will fall back to blind resubmission.
   */
  getTransactionStatus?(txHash: string): Promise<TxOnChainStatus>

  // Tenant reputation contract (tenant_reputation)
  updateTenantReputation?(tenantId: string, record: TenantReputationRecord): Promise<void>
  getTenantReputation?(tenantId: string): Promise<TenantReputationRecord | null>

  // Admin operations (require SOROBAN_ADMIN_SIGNING_ENABLED=true)
  pause?(contractId: string): Promise<string>
  unpause?(contractId: string): Promise<string>
  setOperator?(contractId: string, operatorAddress: string | null): Promise<string>
  init?(contractId: string, adminAddress: string, operatorAddress?: string): Promise<string>
  syncDealStatus?(params: SyncDealStatusParams): Promise<void>

  /**
   * Read on-chain position from a money contract for reconciliation.
   * This reads the contract's view of what it owes or holds, either as an aggregate
   * obligation (if the contract supports it) or per-account balance.
   *
   * @param contractType - The type of money contract (deal_escrow, staking_pool, etc.)
   * @param account - Optional account address for per-account reads; if undefined, reads aggregate obligation
   * @returns The on-chain position including balance, contract info, and timestamp
   */
  getOnChainPosition?(contractType: MoneyContractType, account?: string): Promise<OnChainPosition>
}
